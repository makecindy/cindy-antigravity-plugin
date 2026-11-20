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
 *   Sign-in stays with agy (see agy-account.js); the plugin never sees credentials or the email.
 */

const readline = require('node:readline');
const maintain = require('./cli-installer.cjs');
const { detectAgy, readCustomAgyConfig, runVersion, validateCustomPath, writeCustomAgyPath } = require('./resolve-agy.js');
const { listModels } = require('./agy-models.js');
const account = require('./agy-account.js');

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function replyError(id, code, message) {
  reply({ jsonrpc: '2.0', id, error: { code, message } });
}

let usageRead;
const handlers = {
  cliMaintenance(params) {
    if (params && params.action === 'install' && readCustomAgyConfig().kind !== 'none') {
      return { error: 'custom-path' };
    }
    return maintain(params, (method, data) => reply({ jsonrpc: '2.0', method, ...(data ? { params: data } : {}) }));
  },
  usage() {
    if (!usageRead) {
      const read = require('./agy-usage.js').readUsage().catch(() => null).finally(() => {
        if (usageRead === read) usageRead = undefined;
      });
      usageRead = read;
    }
    return usageRead;
  },
  async detect(params) {
    const locale = params && typeof params.locale === 'string' ? params.locale : undefined;
    return detectAgy({ locale });
  },
  async setCustomPath(params) {
    if (!params || typeof params.path !== 'string') return { ok: false, error: 'not-absolute' };
    const locale = typeof params.locale === 'string' ? params.locale : undefined;
    const checked = validateCustomPath(params.path);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (checked.path !== null) {
      const probe = await runVersion(checked.path);
      if (!probe.ok) return { ok: false, error: 'not-runnable', detail: probe.detail };
    }
    const saved = writeCustomAgyPath(params.path);
    if (!saved.ok) return { ok: false, error: saved.error };
    usageRead = undefined;
    const detection = await detectAgy({ locale });
    return { ok: true, customPath: saved.customPath, detection };
  },
  async account(params) {
    return account.status(params).catch((error) => ({
      supported: true,
      error: 'status-failed',
      detail: String((error && error.message) || error).slice(0, 300),
    }));
  },
  async login() {
    usageRead = undefined;
    return account.login(undefined, () => {
      reply({ jsonrpc: '2.0', method: 'progress', params: { stage: 'waiting-for-browser' } });
    });
  },
  async cancelLogin() {
    return account.cancelLogin();
  },
  async logout() {
    usageRead = undefined;
    return account.logout();
  },
  async listModels(params) {
    return listModels(params).catch((error) => ({
      supported: true,
      error: 'list-failed',
      detail: String((error && error.message) || error).slice(0, 300),
    }));
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
