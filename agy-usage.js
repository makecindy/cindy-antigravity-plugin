'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configFilePath, resolveAgy, spawnAgy, SESSION_SETTINGS, killTree } = require('./resolve-agy.js');

const NAMED_PERIODS = { hourly: 60, daily: 1440, weekly: 10080 };
const PERIOD_UNITS = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440,
  w: 10080, wk: 10080, week: 10080, weeks: 10080,
};
/** Cindy accepts window lengths up to a leap year. */
const MAX_WINDOW_MINUTES = 527040;
/**
 * Persistent throttling across `on-demand` worker restarts (worker exits after 30 s idle):
 * - Active (at least one Antigravity prompt ran since the last check): at most once every 15 min.
 * - Idle (no Antigravity task ran since the last check): at most once every 60 min.
 * - Window reset boundary crossed since the last check: allow one re-check after 5 min.
 * - Failure / signed-out null reads: exponential backoff 15 min → 30 min → 60 min.
 */
const ACTIVE_TTL_MS = 15 * 60_000;
const IDLE_TTL_MS = 60 * 60_000;
const RESET_MIN_INTERVAL_MS = 5 * 60_000;
const FAILURE_BACKOFF_INITIAL_MS = 15 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 60_000;
const CACHE_FILE_NAME = 'usage-cache.json';
const ACTIVITY_FILE_NAME = 'usage-activity.json';
const MAX_CACHE_BYTES = 16 * 1024;
const MAX_ACTIVITY_BYTES = 1024;
const MAX_GENERATION_KEYS = 64;
const cacheGenerations = new Map();

function getCacheGenerations(file) {
  return cacheGenerations.get(file || '') || { all: 0, fail: 0 };
}

function bumpCacheGeneration(file, kind) {
  const key = file || '';
  const current = getCacheGenerations(key);
  const next = kind === 'all'
    ? { all: current.all + 1, fail: current.fail + 1 }
    : { all: current.all, fail: current.fail + 1 };
  cacheGenerations.delete(key);
  cacheGenerations.set(key, next);
  if (cacheGenerations.size > MAX_GENERATION_KEYS) {
    const oldest = cacheGenerations.keys().next().value;
    if (oldest !== undefined) cacheGenerations.delete(oldest);
  }
}

/**
 * The length of a quota window from its period as agy reports it (`5h` → 300, `weekly` → 10080), so
 * Cindy can tell which quota resets soonest. Anything else (e.g. `monthly`, whose length varies) has none.
 */
function windowMinutesOf(period) {
  const key = period.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED_PERIODS, key)) return NAMED_PERIODS[key];
  const match = /^(\d{1,6})\s*([a-z]+)$/.exec(key);
  const unit = match && Object.prototype.hasOwnProperty.call(PERIOD_UNITS, match[2]) ? PERIOD_UNITS[match[2]] : 0;
  const minutes = unit * (match ? Number(match[1]) : 0);
  return minutes >= 1 && minutes <= MAX_WINDOW_MINUTES ? minutes : undefined;
}

/** agy's /usage command is answered by the CLI itself, outside a model turn. */
function usageFromReport(report, updatedAt = Date.now()) {
  if (report?.status !== 'SUCCESS' || report.command?.name !== 'usage' || report.num_turns !== 0) return null;
  const groups = report.command.data?.groups;
  if (!Array.isArray(groups)) return null;
  const windows = [];
  for (const group of groups) {
    if (typeof group?.name !== 'string' || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      const fraction = bucket?.remaining_fraction;
      if (bucket?.disabled || typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const period = bucket.window || bucket.name;
      if (typeof period !== 'string') continue;
      const label = (group.name + ' · ' + period).trim();
      if (!label || label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) continue;
      const resetsAt = Date.parse(bucket.reset_time);
      const windowMinutes = windowMinutesOf(period);
      windows.push({ label, remainingPercent: Math.round(fraction * 10000) / 100,
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        ...(windowMinutes ? { windowMinutes } : {}) });
      if (windows.length === 24) break;
    }
    if (windows.length === 24) break;
  }
  return windows.length ? { updatedAt, windows } : null;
}

function stateFilePath(fileName, options) {
  const config = configFilePath(options);
  return config ? path.join(path.dirname(config), fileName) : null;
}

function cacheFilePath(options) {
  return stateFilePath(CACHE_FILE_NAME, options);
}

function activityFilePath(options) {
  return stateFilePath(ACTIVITY_FILE_NAME, options);
}

function writeJsonAtomic(file, payload) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore cleanup error */ }
    }
  } catch {
    // Best-effort local state; never breaks usage reads or ACP tasks.
  }
}

function readJsonBounded(file, maxBytes) {
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function sanitizeCachedUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt <= 0) return null;
  if (!Array.isArray(raw.windows) || raw.windows.length === 0 || raw.windows.length > 24) return null;
  const windows = [];
  for (const row of raw.windows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (typeof row.label !== 'string' || !row.label || row.label.length > 120 || /[\x00-\x1f\x7f]/.test(row.label)) return null;
    if (typeof row.remainingPercent !== 'number' || !Number.isFinite(row.remainingPercent)
      || row.remainingPercent < 0 || row.remainingPercent > 100) return null;
    if (row.resetsAt !== undefined && (typeof row.resetsAt !== 'number' || !Number.isFinite(row.resetsAt) || row.resetsAt <= 0)) {
      return null;
    }
    if (row.windowMinutes !== undefined && (!Number.isSafeInteger(row.windowMinutes)
      || row.windowMinutes < 1 || row.windowMinutes > MAX_WINDOW_MINUTES)) {
      return null;
    }
    windows.push({
      label: row.label,
      remainingPercent: row.remainingPercent,
      ...(row.resetsAt !== undefined ? { resetsAt: row.resetsAt } : {}),
      ...(row.windowMinutes !== undefined ? { windowMinutes: row.windowMinutes } : {}),
    });
  }
  return { updatedAt: raw.updatedAt, windows };
}

function readUsageCache(options) {
  const data = readJsonBounded(cacheFilePath(options), MAX_CACHE_BYTES);
  if (!data) return null;
  if (typeof data.executable !== 'string' || !data.executable) return null;
  if (typeof data.checkedAt !== 'number' || !Number.isFinite(data.checkedAt) || data.checkedAt <= 0) return null;
  const consecutiveFailures = Number.isSafeInteger(data.consecutiveFailures) && data.consecutiveFailures >= 0
    ? data.consecutiveFailures
    : 0;
  if (data.usage === null) {
    return {
      executable: data.executable,
      checkedAt: data.checkedAt,
      usage: null,
      consecutiveFailures: Math.max(1, consecutiveFailures),
    };
  }
  const usage = sanitizeCachedUsage(data.usage);
  if (!usage) return null;
  return {
    executable: data.executable,
    checkedAt: data.checkedAt,
    usage,
    consecutiveFailures: 0,
  };
}

function writeUsageCache(entry, options) {
  writeJsonAtomic(cacheFilePath(options), entry);
}

function clearUsageCache(options) {
  const file = cacheFilePath(options);
  bumpCacheGeneration(file, 'all');
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

/** Clears a cached failed/signed-out entry once sign-in is observed, without dropping valid quota data. */
function clearFailedUsageCache(options) {
  const file = cacheFilePath(options);
  bumpCacheGeneration(file, 'fail');
  const cached = readUsageCache(options);
  if (cached && cached.usage === null && file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }
}

function recordUsageActivity(options) {
  const nowFn = typeof options?.now === 'function' ? options.now : Date.now;
  const now = nowFn();
  if (typeof now !== 'number' || !Number.isFinite(now) || now <= 0) return;
  writeJsonAtomic(activityFilePath(options), { lastActivityAt: now });
}

function readUsageActivity(options) {
  const data = readJsonBounded(activityFilePath(options), MAX_ACTIVITY_BYTES);
  if (!data) return null;
  return typeof data.lastActivityAt === 'number' && Number.isFinite(data.lastActivityAt) && data.lastActivityAt > 0
    ? data.lastActivityAt
    : null;
}

/**
 * Decides whether a real `agy --print /usage` probe should run now, or whether the cached result
 * should be reused.
 */
function shouldRefreshUsage(cache, activityAt, now, executable, options) {
  if (!cache || cache.executable !== executable || cache.checkedAt > now) return true;
  const age = now - cache.checkedAt;
  if (cache.usage === null) {
    const initial = options?.failureBackoffInitialMs ?? FAILURE_BACKOFF_INITIAL_MS;
    const max = options?.failureBackoffMaxMs ?? FAILURE_BACKOFF_MAX_MS;
    const step = Math.min(10, Math.max(0, (cache.consecutiveFailures || 1) - 1));
    const backoff = Math.min(max, initial * Math.pow(2, step));
    return age >= backoff;
  }
  const resetMin = options?.resetMinIntervalMs ?? RESET_MIN_INTERVAL_MS;
  const resetPassed = cache.usage.windows.some((window) =>
    typeof window.resetsAt === 'number' && window.resetsAt > cache.checkedAt && window.resetsAt <= now);
  if (resetPassed && age >= resetMin) return true;
  const hasActivity = typeof activityAt === 'number'
    && activityAt > cache.checkedAt
    && activityAt <= now + FUTURE_CLOCK_SKEW_MS;
  const ttl = hasActivity
    ? (options?.activeTtlMs ?? ACTIVE_TTL_MS)
    : (options?.idleTtlMs ?? IDLE_TTL_MS);
  return age >= ttl;
}

async function probeUsage(executable, options, nowFn) {
  // The Windows updater can open a terminal of its own even when agy is hidden.
  const env = options?.env ?? process.env;
  const usageEnv = (options?.platform ?? process.platform) === 'win32'
    ? { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
    : env;
  const child = spawnAgy(executable, ['--settings', SESSION_SETTINGS, '--output-format', 'json', '--print', '/usage'],
    { ...options, env: usageEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks = [];
  let length = 0;
  const stop = () => killTree(child, 'SIGKILL');
  const timer = setTimeout(stop, 12000);
  process.once('exit', stop);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
      child.stdout.on('data', chunk => {
        length += chunk.length;
        if (length > 128 * 1024) stop();
        else chunks.push(chunk);
      });
    });
    if (code !== 0 || length > 128 * 1024) return null;
    return usageFromReport(JSON.parse(Buffer.concat(chunks).toString('utf8')), nowFn());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    process.removeListener('exit', stop);
  }
}

async function readUsage(options) {
  const executable = resolveAgy(options);
  if (!executable) return null;
  const nowFn = typeof options?.now === 'function' ? options.now : Date.now;
  const now = nowFn();
  const file = cacheFilePath(options);
  const cached = readUsageCache(options);
  const activityAt = readUsageActivity(options);
  if (!options?.force && !shouldRefreshUsage(cached, activityAt, now, executable, options)) {
    return cached.usage;
  }
  const startGen = getCacheGenerations(file);
  const usage = await probeUsage(executable, options, nowFn);
  const currentGen = getCacheGenerations(file);
  // Discard results from probes started before an account/path invalidation so a late probe
  // cannot resurrect old quota data or a stale signed-out failure entry on disk.
  if (currentGen.all !== startGen.all || resolveAgy(options) !== executable) {
    return null;
  }
  const checkedAt = nowFn();
  if (usage) {
    writeUsageCache({ executable, checkedAt, usage, consecutiveFailures: 0 }, options);
    return usage;
  }
  if (currentGen.fail !== startGen.fail) {
    return null;
  }
  const prevFailures = cached && cached.executable === executable && cached.usage === null
    ? cached.consecutiveFailures
    : 0;
  writeUsageCache({ executable, checkedAt, usage: null, consecutiveFailures: prevFailures + 1 }, options);
  return null;
}

module.exports = {
  ACTIVE_TTL_MS,
  IDLE_TTL_MS,
  RESET_MIN_INTERVAL_MS,
  FAILURE_BACKOFF_INITIAL_MS,
  FAILURE_BACKOFF_MAX_MS,
  activityFilePath,
  cacheFilePath,
  clearFailedUsageCache,
  clearUsageCache,
  readUsage,
  readUsageActivity,
  readUsageCache,
  recordUsageActivity,
  shouldRefreshUsage,
  usageFromReport,
  windowMinutesOf,
};
