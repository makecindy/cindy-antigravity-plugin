import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const usageMod = await import(pathToFileURL(path.join(root, 'agy-usage.js')).href);
const {
  ACTIVE_TTL_MS,
  IDLE_TTL_MS,
  RESET_MIN_INTERVAL_MS,
  FAILURE_BACKOFF_INITIAL_MS,
  FAILURE_BACKOFF_MAX_MS,
  cacheFilePath,
  clearFailedUsageCache,
  clearUsageCache,
  readUsage,
  readUsageActivity,
  readUsageCache,
  recordUsageActivity,
  shouldRefreshUsage,
} = usageMod;

const FAKE_USAGE_AGY = `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const countFile = process.env.FAKE_USAGE_COUNT_FILE;
const failFile = process.env.FAKE_USAGE_FAIL_FILE;
const resetFile = process.env.FAKE_USAGE_RESET_FILE;

if (args.at(-1) === '/usage') {
  const prev = countFile && fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) || 0 : 0;
  const next = prev + 1;
  if (countFile) fs.writeFileSync(countFile, String(next));
  if (failFile && fs.existsSync(failFile)) process.exit(1);
  const resetTime = resetFile && fs.existsSync(resetFile) ? fs.readFileSync(resetFile, 'utf8').trim() : undefined;
  const bucket = { window: '5h', remaining_fraction: Math.max(0, 1 - next * 0.1) };
  if (resetTime) bucket.reset_time = resetTime;
  process.stdout.write(JSON.stringify({
    status: 'SUCCESS',
    num_turns: 0,
    command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [bucket] }] } },
  }));
  process.exit(0);
}
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('agy 1.5.18\\n');
  process.exit(0);
}
if (args.includes('acp')) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' },
            agentCapabilities: { auth: { logout: true } },
            authMethods: [{ id: 'oauth-personal', name: 'Google' }],
          },
        }) + '\\n');
      } else if (msg.method === 'logout') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
      } else if (msg.method === 'session/new') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', configOptions: [] } }) + '\\n');
      } else if (msg.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
`;

function makeEnvFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-throttle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binDir = path.join(dir, 'bin');
  const homeDir = path.join(dir, 'home');
  const configDir = path.join(dir, 'xdg');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const script = path.join(binDir, 'fake-agy.js');
  fs.writeFileSync(script, FAKE_USAGE_AGY, 'utf8');
  let agyPath;
  if (isWin) {
    agyPath = path.join(binDir, 'agy.cmd');
    fs.writeFileSync(agyPath, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    agyPath = path.join(binDir, 'agy');
    fs.writeFileSync(agyPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const countFile = path.join(dir, 'usage-count.txt');
  const failFile = path.join(dir, 'fail.flag');
  const resetFile = path.join(dir, 'reset.txt');
  const env = {
    ...(isWin ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    PATH: binDir + path.delimiter + path.dirname(process.execPath),
    HOME: homeDir,
    XDG_CONFIG_HOME: configDir,
    LOCALAPPDATA: configDir,
    USERPROFILE: homeDir,
    FAKE_USAGE_COUNT_FILE: countFile,
    FAKE_USAGE_FAIL_FILE: failFile,
    FAKE_USAGE_RESET_FILE: resetFile,
  };
  const readCount = () => (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) || 0 : 0);
  return { dir, agyPath, env, countFile, failFile, resetFile, readCount };
}

function startWorker(env) {
  const child = spawn(process.execPath, [path.join(root, 'worker.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  return {
    call(req) {
      return new Promise((resolve) => {
        pending.set(req.id, resolve);
        child.stdin.write(JSON.stringify(req) + '\n');
      });
    },
    close() {
      child.stdin.end();
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
      });
    },
  };
}

describe('usage adaptive throttling and persistent cache', () => {
  test('shouldRefreshUsage applies idle TTL, active TTL, reset window, backoff, and clock-skew rules', () => {
    const exe = '/usr/local/bin/agy';
    const t0 = 1_700_000_000_000;
    const validCache = {
      executable: exe,
      checkedAt: t0,
      usage: {
        updatedAt: t0,
        windows: [{ label: 'Gemini · 5h', remainingPercent: 80, resetsAt: t0 + 10 * 60_000, windowMinutes: 300 }],
      },
      consecutiveFailures: 0,
    };

    // Idle: cached for up to 60 min (unless a reset boundary passes).
    const noResetCache = {
      ...validCache,
      usage: { updatedAt: t0, windows: [{ label: 'Gemini · 5h', remainingPercent: 80, windowMinutes: 300 }] },
    };
    assert.equal(shouldRefreshUsage(noResetCache, null, t0 + 59 * 60_000, exe), false);
    assert.equal(shouldRefreshUsage(noResetCache, null, t0 + IDLE_TTL_MS, exe), true);

    // Activity before checkedAt does NOT switch to active TTL.
    assert.equal(shouldRefreshUsage(noResetCache, t0 - 1000, t0 + ACTIVE_TTL_MS, exe), false);

    // Activity after checkedAt switches to 15 min active TTL.
    assert.equal(shouldRefreshUsage(noResetCache, t0 + 60_000, t0 + ACTIVE_TTL_MS - 1, exe), false);
    assert.equal(shouldRefreshUsage(noResetCache, t0 + 60_000, t0 + ACTIVE_TTL_MS, exe), true);

    // Window reset boundary triggers once after RESET_MIN_INTERVAL_MS (5 min).
    assert.equal(shouldRefreshUsage(validCache, null, t0 + 10 * 60_000 - 1, exe), false);
    assert.equal(shouldRefreshUsage(validCache, null, t0 + 10 * 60_000, exe), true);

    // Window whose reset was already in the past at checkedAt must NOT trigger a loop.
    const alreadyExpiredCache = {
      ...validCache,
      checkedAt: t0 + 11 * 60_000,
      usage: {
        updatedAt: t0 + 11 * 60_000,
        windows: [{ label: 'Gemini · 5h', remainingPercent: 80, resetsAt: t0 + 10 * 60_000, windowMinutes: 300 }],
      },
    };
    assert.equal(shouldRefreshUsage(alreadyExpiredCache, null, t0 + 11 * 60_000 + RESET_MIN_INTERVAL_MS, exe), false);

    // Reset boundary within RESET_MIN_INTERVAL_MS waits for 5 min minimum interval.
    const soonResetCache = {
      ...validCache,
      usage: {
        updatedAt: t0,
        windows: [{ label: 'Gemini · 5h', remainingPercent: 80, resetsAt: t0 + 60_000, windowMinutes: 300 }],
      },
    };
    assert.equal(shouldRefreshUsage(soonResetCache, null, t0 + 2 * 60_000, exe), false);
    assert.equal(shouldRefreshUsage(soonResetCache, null, t0 + RESET_MIN_INTERVAL_MS, exe), true);

    // Failure backoff: 15m -> 30m -> 60m cap.
    const fail1 = { executable: exe, checkedAt: t0, usage: null, consecutiveFailures: 1 };
    assert.equal(shouldRefreshUsage(fail1, t0 + 1000, t0 + FAILURE_BACKOFF_INITIAL_MS - 1, exe), false);
    assert.equal(shouldRefreshUsage(fail1, t0 + 1000, t0 + FAILURE_BACKOFF_INITIAL_MS, exe), true);
    const fail2 = { executable: exe, checkedAt: t0, usage: null, consecutiveFailures: 2 };
    assert.equal(shouldRefreshUsage(fail2, null, t0 + FAILURE_BACKOFF_INITIAL_MS * 2 - 1, exe), false);
    assert.equal(shouldRefreshUsage(fail2, null, t0 + FAILURE_BACKOFF_INITIAL_MS * 2, exe), true);
    const fail5 = { executable: exe, checkedAt: t0, usage: null, consecutiveFailures: 5 };
    assert.equal(shouldRefreshUsage(fail5, null, t0 + FAILURE_BACKOFF_MAX_MS - 1, exe), false);
    assert.equal(shouldRefreshUsage(fail5, null, t0 + FAILURE_BACKOFF_MAX_MS, exe), true);

    // Executable change or clock moving backwards invalidates cache.
    assert.equal(shouldRefreshUsage(noResetCache, null, t0 + 1000, '/other/agy'), true);
    assert.equal(shouldRefreshUsage(noResetCache, null, t0 - 1, exe), true);
  });

  test('readUsage persists across calls, distinguishes idle vs active, and backs off on failures', async (t) => {
    const fixture = makeEnvFixture(t);
    let clock = 1_750_000_000_000;
    const opts = { env: fixture.env, now: () => clock };

    // 1. Initial probe runs once.
    const first = await readUsage(opts);
    assert.equal(fixture.readCount(), 1);
    assert.equal(first.windows[0].remainingPercent, 90);

    // 2. Idle at +20m: reuses disk cache with zero spawns.
    clock += 20 * 60_000;
    const idleHit = await readUsage(opts);
    assert.equal(fixture.readCount(), 1);
    assert.deepEqual(idleHit, first);

    // 3. Antigravity task runs at +25m -> active TTL (15m) is already satisfied (25m >= 15m).
    clock += 5 * 60_000;
    recordUsageActivity(opts);
    clock += 1_000;
    const activeRefresh = await readUsage(opts);
    assert.equal(fixture.readCount(), 2);
    assert.equal(activeRefresh.windows[0].remainingPercent, 80);

    // 4. Another task runs 2 min later, but still inside 15m active cooldown -> zero spawns.
    clock += 2 * 60_000;
    recordUsageActivity(opts);
    clock += 60_000;
    const activeCooldownHit = await readUsage(opts);
    assert.equal(fixture.readCount(), 2);
    assert.deepEqual(activeCooldownHit, activeRefresh);

    // 5. After 15m from activeRefresh (with recorded activity after it) -> refreshes once.
    clock += 13 * 60_000;
    const activeSecondRefresh = await readUsage(opts);
    assert.equal(fixture.readCount(), 3);
    assert.equal(activeSecondRefresh.windows[0].remainingPercent, 70);

    // 6. Back to idle (no activity since activeSecondRefresh): 30m later still cached; 60m later refreshes.
    clock += 30 * 60_000;
    assert.equal((await readUsage(opts)).windows[0].remainingPercent, 70);
    assert.equal(fixture.readCount(), 3);
    clock += 30 * 60_000;
    assert.equal((await readUsage(opts)).windows[0].remainingPercent, 60);
    assert.equal(fixture.readCount(), 4);

    // 7. clearFailedUsageCache keeps valid quota cache intact.
    clearFailedUsageCache(opts);
    assert.ok(readUsageCache(opts)?.usage);

    // 8. Failure caches null with exponential backoff (15m -> 30m) and clears on clearFailedUsageCache.
    fs.writeFileSync(fixture.failFile, '1');
    clearUsageCache(opts);
    assert.equal(await readUsage(opts), null);
    assert.equal(fixture.readCount(), 5);
    clock += 10 * 60_000;
    assert.equal(await readUsage(opts), null);
    assert.equal(fixture.readCount(), 5);
    clock += 5 * 60_000;
    assert.equal(await readUsage(opts), null);
    assert.equal(fixture.readCount(), 6);
    assert.equal(readUsageCache(opts)?.consecutiveFailures, 2);

    // 2nd failure backs off for 30 min; clearing failed cache unblocks immediately.
    clock += 20 * 60_000;
    assert.equal(await readUsage(opts), null);
    assert.equal(fixture.readCount(), 6);
    fs.rmSync(fixture.failFile, { force: true });
    clearFailedUsageCache(opts);
    const recovered = await readUsage(opts);
    assert.equal(fixture.readCount(), 7);
    assert.ok(recovered?.windows?.length);
  });

  test('cache survives on-demand worker restarts and invalidates on logout', async (t) => {
    const fixture = makeEnvFixture(t);

    const w1 = startWorker(fixture.env);
    const r1 = await w1.call({ jsonrpc: '2.0', id: 1, method: 'usage', params: {} });
    await w1.close();
    assert.equal(fixture.readCount(), 1);
    assert.equal(r1.result.windows[0].remainingPercent, 90);

    // A brand new worker process reuses usage-cache.json without spawning agy again.
    const w2 = startWorker(fixture.env);
    const r2 = await w2.call({ jsonrpc: '2.0', id: 2, method: 'usage', params: {} });
    assert.equal(fixture.readCount(), 1);
    assert.deepEqual(r2.result, r1.result);

    // Logging out clears the persisted usage cache so the next check probes afresh.
    const out = await w2.call({ jsonrpc: '2.0', id: 3, method: 'logout', params: {} });
    assert.equal(out.result.ok, true);
    assert.equal(readUsageCache({ env: fixture.env }), null);
    const r3 = await w2.call({ jsonrpc: '2.0', id: 4, method: 'usage', params: {} });
    await w2.close();
    assert.equal(fixture.readCount(), 2);
    assert.equal(r3.result.windows[0].remainingPercent, 80);
  });

  test('agy-acp records usage activity on session/prompt and corrupt cache files recover cleanly', async (t) => {
    const fixture = makeEnvFixture(t);
    assert.equal(readUsageActivity({ env: fixture.env }), null);

    const bridge = spawn(process.execPath, [path.join(root, 'agy-acp.js')], {
      env: fixture.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: bridge.stdout });
    const waitMsg = () => new Promise((resolve) => rl.once('line', (line) => resolve(JSON.parse(line))));

    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    await waitMsg();
    assert.equal(readUsageActivity({ env: fixture.env }), null, 'initialize alone is not billable prompt activity');

    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: fixture.dir, mcpServers: [] } }) + '\n');
    await waitMsg();
    assert.equal(readUsageActivity({ env: fixture.env }), null, 'opening a session without prompting is not activity');

    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const promptRes = await waitMsg();
    assert.equal(promptRes.result.stopReason, 'end_turn');
    bridge.stdin.end();
    await new Promise((resolve) => bridge.once('exit', resolve));

    const activityAt = readUsageActivity({ env: fixture.env });
    assert.ok(typeof activityAt === 'number' && activityAt > 0, 'session/prompt recorded usage activity');

    // Corrupt usage-cache.json is ignored cleanly and triggers a fresh probe.
    const cacheFile = cacheFilePath({ env: fixture.env });
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, '{not-valid-json', 'utf8');
    assert.equal(readUsageCache({ env: fixture.env }), null);
    const fresh = await readUsage({ env: fixture.env });
    assert.equal(fixture.readCount(), 1);
    assert.equal(fresh.windows[0].remainingPercent, 90);
  });

  test('remote-workspace mode also records usage activity on session/prompt', async (t) => {
    const fixture = makeEnvFixture(t);
    assert.equal(readUsageActivity({ env: fixture.env }), null);

    const bridge = spawn(process.execPath, [path.join(root, 'agy-acp.js'), '--cindy-remote-workspace'], {
      env: fixture.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: bridge.stdout });
    const waitMsg = () => new Promise((resolve) => rl.once('line', (line) => resolve(JSON.parse(line))));

    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
    await waitMsg();
    bridge.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: fixture.dir, mcpServers: [{ name: 'cindy_exec', type: 'http', url: 'http://127.0.0.1:9999/mcp' }] },
    }) + '\n');
    await waitMsg();
    assert.equal(readUsageActivity({ env: fixture.env }), null, 'remote session/new alone does not mark activity');

    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const promptRes = await waitMsg();
    assert.equal(promptRes.result.stopReason, 'end_turn');
    bridge.stdin.end();
    await new Promise((resolve) => bridge.once('exit', resolve));

    const activityAt = readUsageActivity({ env: fixture.env });
    assert.ok(typeof activityAt === 'number' && activityAt > 0, 'remote session/prompt recorded usage activity');
  });
});
