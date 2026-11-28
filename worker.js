'use strict';

/**
 * Node worker (json-rpc-stdio). One JSON-RPC 2.0 object per line in each direction;
 * stdout carries protocol messages only.
 *
 * Methods:
 *   detect({ locale? }) -> { available, path?, customPath?, customPathConfigured?, version?, reason?, message?, messages?, detail? }
 *     Finds the local agy executable and checks that `agy --version` runs. `message`
 *     is in the requested locale ('zh-CN' or English); `messages` carries both.
 *   setCustomPath({ path, locale? }) -> { ok: true, customPath, detection } | { ok: false, error, detail? }
 *     Validates and probes a user-supplied absolute path to agy before saving it, or clears it
 *     when `path` is an empty string, then returns a fresh detection result.
 *   listModels({ sessionId? })
 *     -> { supported: true, models: [{ id, name, description?, group?, efforts?, defaultEffort? }],
 *          modes?, defaultMode?, sessionId? }
 *      | { supported: false, reason: 'not-installed' | 'not-signed-in' } | { supported: true, error, detail? }
 *     Asks agy over ACP in the plugin's one dedicated session (see agy-models.js); `tier` is the
 *     subscription tier name agy reports.
 *   account({ sessionId? }) -> { supported: true, signedIn, tier?, canSignIn, canSignOut }
 *      | { supported: false, reason } | { supported: true, error, detail? }
 *   accountStatus({ harnessId, accountDir? }) -> { state: 'signed-in', plan? } | { state: 'signed-out' } | null
 *     Reads the original login or the isolated Linux account Cindy selected.
 *   accountLogin({ harnessId, accountDir, methodId: 'linux-keyring', secret: sourceProfilePath })
 *   accountLoginCancel({ harnessId, accountDir? })
 *   adoptModelSession({ sessionId }) -> { ok: true, adopted } | { ok: false, error: 'invalid' | 'busy' }
 *     main.js hands over the model-list session it saved, so accountStatus can read the tier before
 *     the next listing (plugins upgraded from 0.4.x kept it only in main.js). Kept only when the worker
 *     remembers none; starts no agy.
 *   usage({ harnessId, accountDir? }) -> { updatedAt, windows } | null   (agy's native /usage, see agy-usage.js)
 *   login() -> { ok: true, tier? } | { ok: false, error, detail? }
 *     agy's Google sign-in: agy opens the browser; answers when the sign-in finished, was cancelled
 *     or after 5 minutes. Sends a `progress` notification every 10 s meanwhile (keeps Cindy's
 *     request alive).
 *   cancelLogin() -> { ok: true, cancelled }
 *   cliMaintenance({ action, version?, op? }) -> { state, version } | { error }
 *     Checks, installs or updates agy (see cli-installer.cjs). While installing it sends `progress`
 *     keep-alives and `cli-progress` { op, events } notifications for the settings page.
 *   logout() -> { ok: true } | { ok: false, error, detail? }
 *     Signs agy out; the settings page only asks after the user confirmed.
 *   login() and logout() answer { ok: false, error: 'busy' } while a custom path is being saved: the account
 *   they would act on is the one of the executable being replaced.
 *   Sign-in stays with agy (see agy-account.js); the plugin never sees credentials or the email.
 */

const readline = require('node:readline');
const maintain = require('./cli-installer.cjs');
const { detectAgy, readCustomAgyConfig, runVersion, validateCustomPath, writeCustomAgyPath } = require('./resolve-agy.js');
const { listModels, readModelSession, rememberModelSession } = require('./agy-models.js');
const account = require('./agy-account.js');
const { accountOptions, importAccount, linuxAccountsSupported } = require('./agy-linux-accounts.js');

const HARNESS_ID = 'agy';
/** Cindy waits 26 s for accountStatus; answer "unknown" before that rather than not at all. */
const ACCOUNT_STATUS_DEADLINE_MS = 20_000;
const IMPORTED_CATALOG_DEADLINE_MS = 15_000;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function replyError(id, code, message) {
  reply({ jsonrpc: '2.0', id, error: { code, message } });
}

/** `promise`'s value, or `fallback` once `ms` passed (the work itself still finishes and cleans up). */
function withDeadline(promise, ms, fallback) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const usageReads = new Map();
const accountStatusReads = new Map();
let maintenanceActive = false;
let customPathPending = 0;
let customPathQueue = Promise.resolve();
let activeLogin = null;
let catalogGeneration = 0;

async function detect(params) {
  const locale = typeof params?.locale === 'string' ? params.locale : undefined;
  return { ...await detectAgy({ locale }), linuxAccounts: linuxAccountsSupported() };
}

/**
 * Called with a host-selected account directory only. An account discovers and remembers its own
 * model-list session. In addition to the host's per-account filter, send usable picker metadata
 * to the resident page, without identifying the account or its credential directory.
 */
async function importedAccountStatus(options, generation) {
  const status = await account.accountStatus({}, options);
  if (status?.state !== 'signed-in') return status;
  const previous = readModelSession(options);
  const listing = await withDeadline(listModels(previous ? { sessionId: previous } : {}, options)
    .catch(() => null), IMPORTED_CATALOG_DEADLINE_MS, null);
  if (listing?.supported === false && listing.reason === 'not-signed-in') return { state: 'signed-out' };
  if (!listing?.supported || !Array.isArray(listing.models)) {
    // Catalog data can fail independently of the login. Keep a valid login usable.
    return status;
  }
  if (generation !== catalogGeneration || customPathPending) return null;
  if (listing.sessionId) rememberModelSession(listing.sessionId, options);
  const { models, modes, defaultMode } = listing;
  if (models.length) reply({ jsonrpc: '2.0', method: 'imported-account-catalog', params: { models, modes, defaultMode } });
  const name = listing.tier?.name;
  const plan = typeof name === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name.slice(0, 64).trim() : '';
  return {
    state: 'signed-in',
    ...(plan ? { plan } : {}),
    ...(models.length ? { models: models.map(model => model.id) } : {}),
  };
}

function readOnce(reads, dir, read) {
  if (!reads.has(dir)) {
    const pending = Promise.resolve().then(read).catch(() => null).finally(() => {
      if (reads.get(dir) === pending) reads.delete(dir);
    });
    reads.set(dir, pending);
  }
  return reads.get(dir);
}

function validHarness(params) {
  return params?.harnessId === undefined || params.harnessId === HARNESS_ID;
}

function login(dir, importPath) {
  if (customPathPending || activeLogin) return Promise.resolve({ ok: false, error: 'busy' });
  usageReads.delete(dir);
  const state = { dir, cancelled: false, run: null };
  activeLogin = state;
  state.run = (async () => {
    if (importPath !== undefined && !await importAccount(dir, importPath)) {
      return { ok: false, error: 'invalid-secret' };
    }
    if (state.cancelled) return { ok: false, error: 'cancelled' };
    const options = await accountOptions(dir);
    if (state.cancelled) return { ok: false, error: 'cancelled' };
    if (importPath !== undefined) {
      const saved = await withDeadline(account.accountStatus({}, options).catch(() => null), 15_000, null);
      if (state.cancelled) return { ok: false, error: 'cancelled' };
      return saved?.state === 'signed-in' ? { ok: true } : { ok: false, error: 'failed' };
    }
    return account.login(options, () => {
      reply({ jsonrpc: '2.0', method: 'progress', params: { stage: 'waiting-for-browser' } });
    });
  })().catch(() => ({ ok: false, error: state.cancelled ? 'cancelled' : 'failed' })).finally(() => {
    if (activeLogin === state) activeLogin = null;
    accountStatusReads.delete(dir);
    usageReads.delete(dir);
  });
  return state.run;
}

function cancelLogin(dir) {
  if (!activeLogin || activeLogin.dir !== dir) return { ok: true, cancelled: false };
  activeLogin.cancelled = true;
  account.cancelLogin();
  return { ok: true, cancelled: true };
}

async function applyCustomPath(params) {
  if (maintenanceActive) return { ok: false, error: 'busy' };
  const checked = validateCustomPath(params.path);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (checked.path !== null) {
    const probe = await runVersion(checked.path);
    if (!probe.ok) return { ok: false, error: 'not-runnable', detail: probe.detail };
  }
  if (maintenanceActive) return { ok: false, error: 'busy' };
  const saved = writeCustomAgyPath(params.path);
  if (!saved.ok) return { ok: false, error: saved.error };
  usageReads.clear();
  accountStatusReads.clear();
  catalogGeneration++;
  // Like main.js, start the model listing of the new executable afresh.
  rememberModelSession(null);
  const pendingLogin = activeLogin;
  if (pendingLogin) {
    cancelLogin(pendingLogin.dir);
    await pendingLogin.run;
  }
  const detection = await detect(params);
  return { ok: true, customPath: saved.customPath, detection };
}

const handlers = {
  cliMaintenance(params) {
    const mutating = params && (params.action === 'install' || params.action === 'update');
    if (mutating && customPathPending > 0) return { error: 'busy' };
    if (params && params.action === 'install' && readCustomAgyConfig().kind !== 'none') {
      return { error: 'custom-path' };
    }
    const result = maintain(params, (method, data) => reply({ jsonrpc: '2.0', method, ...(data ? { params: data } : {}) }));
    if (mutating && result && typeof result.then === 'function') {
      maintenanceActive = true;
      return Promise.resolve(result).finally(() => { maintenanceActive = false; });
    }
    return result;
  },
  usage(params) {
    if (!validHarness(params)) return null;
    const dir = params?.accountDir;
    return readOnce(usageReads, dir, async () => require('./agy-usage.js').readUsage(await accountOptions(dir)));
  },
  detect,
  setCustomPath(params) {
    if (!params || typeof params.path !== 'string') return { ok: false, error: 'not-absolute' };
    customPathPending += 1;
    const run = customPathQueue.then(() => applyCustomPath(params));
    customPathQueue = run.catch(() => {});
    return run.finally(() => { customPathPending -= 1; });
  },
  async account(params) {
    return account.status(params).catch((error) => ({
      supported: true,
      error: 'status-failed',
      detail: String((error && error.message) || error).slice(0, 300),
    }));
  },
  accountStatus(params) {
    if (!validHarness(params)) return null;
    const dir = params?.accountDir;
    const generation = catalogGeneration;
    const pending = readOnce(accountStatusReads, dir, async () => {
      const options = await accountOptions(dir);
      if (options) return importedAccountStatus(options, generation);
      const sessionId = readModelSession();
      return account.accountStatus(sessionId ? { sessionId } : {});
    });
    return withDeadline(pending, ACCOUNT_STATUS_DEADLINE_MS, null);
  },
  login() {
    return login(undefined);
  },
  cancelLogin() {
    return cancelLogin(undefined);
  },
  async accountLogin(params) {
    if (!validHarness(params) || !linuxAccountsSupported()) return { ok: false, error: 'unsupported' };
    const { accountDir, methodId, secret } = params ?? {};
    if (methodId !== 'linux-keyring') return { ok: false, error: 'unsupported' };
    if (typeof accountDir !== 'string' || typeof secret !== 'string') return { ok: false, error: 'invalid-secret' };
    return login(accountDir, secret);
  },
  accountLoginCancel(params) {
    if (validHarness(params)) cancelLogin(params?.accountDir);
    return { ok: true };
  },
  async logout() {
    if (customPathPending || activeLogin) return { ok: false, error: 'busy' };
    usageReads.delete(undefined);
    return account.logout().finally(() => { accountStatusReads.delete(undefined); });
  },
  async listModels(params) {
    return listModels(params).then((result) => {
      if (result && typeof result.sessionId === 'string') rememberModelSession(result.sessionId);
      return result;
    }, (error) => ({
      supported: true,
      error: 'list-failed',
      detail: String((error && error.message) || error).slice(0, 300),
    }));
  },
  adoptModelSession(params) {
    const sessionId = params && params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: 'invalid' };
    // The saved session belongs to the executable being replaced.
    if (customPathPending > 0) return { ok: false, error: 'busy' };
    if (readModelSession()) return { ok: true, adopted: false };
    rememberModelSession(sessionId);
    return { ok: true, adopted: readModelSession() === sessionId };
  },
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    replyError(null, -32700, 'Parse error');
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    replyError(null, -32600, 'Invalid request');
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id') && request.id !== null;
  if (typeof request.method !== 'string') {
    if (hasId) replyError(request.id, -32600, 'Invalid request');
    return;
  }
  const handler = Object.prototype.hasOwnProperty.call(handlers, request.method) ? handlers[request.method] : null;
  if (!handler) {
    if (hasId) replyError(request.id, -32601, 'Method not found');
    return;
  }
  Promise.resolve()
    .then(() => handler(request.params))
    .then(
      (result) => {
        if (hasId) reply({ jsonrpc: '2.0', id: request.id, result });
      },
      (error) => {
        process.stderr.write(`[agy-acp worker] ${request.method} failed: ${error && error.message ? error.message : error}\n`);
        if (hasId) replyError(request.id, -32603, `Antigravity ${request.method} failed`);
      },
    );
});

input.on('close', () => {
  process.exit(0);
});
