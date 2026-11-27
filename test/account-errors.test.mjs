'use strict';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { accountErrorRelay, classifyAccountErrorResponse } = require(path.join(root, 'agy-account-errors.js'));

const NOW = Date.parse('2026-11-27T01:00:00.000Z');
const QUOTA_MSG = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h13m2s.';
const EXPECTED_RESET_MS = NOW + ((2 * 60 + 13) * 60 + 2) * 1000;

function makeFakeAgyEnv(t, scriptBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-quota-err-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jsPath = path.join(dir, 'fake-agy.js');
  fs.writeFileSync(jsPath, scriptBody, 'utf8');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'agy.cmd'), `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
  } else {
    const sh = path.join(binDir, 'agy');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, { mode: 0o755 });
  }
  const configRoot = path.join(dir, 'config');
  fs.mkdirSync(configRoot);
  return {
    ...process.env,
    PATH: binDir + path.delimiter + (process.env.PATH || ''),
    XDG_CONFIG_HOME: configRoot,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: configRoot,
  };
}

function startRelay(env, args = []) {
  const child = spawn(process.execPath, [path.join(root, 'agy-acp.js'), ...args], {
    env,
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const closed = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    lines,
    stderr: () => stderr,
    send: (msg) => child.stdin.write(JSON.stringify(msg) + '\n'),
    closed,
  };
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('agy-account-errors', () => {
  test('classifies Individual quota reached with relative reset countdown, structured quota, auth and overload', () => {
    const individual = classifyAccountErrorResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: QUOTA_MSG },
    }, NOW);
    assert.deepEqual(individual.error.data._meta.cindy, { kind: 'usage-limit', resetsAt: EXPECTED_RESET_MS });

    const structured = classifyAccountErrorResponse({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32603, message: 'quota', data: { reason: 'QUOTA_EXHAUSTED', resetTime: '2026-11-27T04:00:00.000Z' } },
    }, NOW);
    assert.deepEqual(structured.error.data._meta.cindy, {
      kind: 'usage-limit',
      resetsAt: Date.parse('2026-11-27T04:00:00.000Z'),
    });

    const overloaded = classifyAccountErrorResponse({
      jsonrpc: '2.0',
      id: 3,
      error: { code: -32603, message: 'MODEL_CAPACITY_EXHAUSTED', data: { reason: 'MODEL_CAPACITY_EXHAUSTED' } },
    }, NOW);
    assert.deepEqual(overloaded.error.data._meta.cindy, { kind: 'overloaded' });

    const auth = classifyAccountErrorResponse({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32000, message: 'Authentication required' },
    }, NOW);
    assert.deepEqual(auth.error.data._meta.cindy, { kind: 'auth-required' });

    const unrelated = { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'Tool timed out' } };
    assert.equal(classifyAccountErrorResponse(unrelated, NOW), unrelated);
  });

  test('accountErrorRelay converts terminal agy warning chunk + end_turn into classified usage-limit RPC error', () => {
    const relay = accountErrorRelay(() => NOW);
    relay.request({ jsonrpc: '2.0', id: 10, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });

    const hold = relay.notification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n⚠ ${QUOTA_MSG}\n` } } },
    });
    assert.deepEqual(hold, { hold: true });

    // Metadata updates after the warning do not flush the held warning chunk.
    const meta = relay.notification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 100, size: 100000 } },
    });
    assert.equal(meta, null);

    const converted = relay.response({ jsonrpc: '2.0', id: 10, result: { stopReason: 'end_turn' } });
    assert.equal(converted.result, undefined);
    assert.equal(converted.error.code, -32603);
    assert.equal(converted.error.message, QUOTA_MSG);
    assert.deepEqual(converted.error.data._meta.cindy, { kind: 'usage-limit', resetsAt: EXPECTED_RESET_MS });
  });

  test('accountErrorRelay flushes held warning if real content follows and never converts cancelled or replay chunks', () => {
    const relay = accountErrorRelay(() => NOW);

    // History replay outside an active prompt is forwarded immediately.
    const replay = relay.notification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n⚠ ${QUOTA_MSG}\n` } } },
    });
    assert.equal(replay, null);

    // If the agent continues writing after a warning chunk, flush the warning chunk in order.
    relay.request({ jsonrpc: '2.0', id: 11, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
    const warnMsg = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n⚠ ${QUOTA_MSG}\n` } } },
    };
    assert.deepEqual(relay.notification(warnMsg), { hold: true });
    const follow = relay.notification({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is how to handle that error.' } } },
    });
    assert.deepEqual(follow, { hold: false, flush: [warnMsg] });
    const okResult = { jsonrpc: '2.0', id: 11, result: { stopReason: 'end_turn' } };
    assert.equal(relay.response(okResult), okResult);

    // Cancelled turns keep the cancelled result and flush the held warning so users still see it.
    relay.request({ jsonrpc: '2.0', id: 12, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } });
    assert.deepEqual(relay.notification(warnMsg), { hold: true });
    const cancelled = { jsonrpc: '2.0', id: 12, result: { stopReason: 'cancelled' } };
    const flushed = [];
    assert.equal(relay.response(cancelled, (item) => flushed.push(item)), cancelled);
    assert.deepEqual(flushed, [warnMsg]);
  });

  test('agy-acp end-to-end converts agy warning chunk + end_turn into classified usage-limit error in local mode', async (t) => {
    const fakeAgy = `'use strict';
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('1.5.18'); process.exit(0); }
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let promptCount = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' }, agentCapabilities: {} } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
  } else if (msg.method === 'session/prompt') {
    promptCount += 1;
    if (promptCount === 2) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial work.' } } } });
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n⚠ ${QUOTA_MSG}\\n' } } } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'usage_update', used: 200, size: 100000 } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: promptCount === 3 ? 'cancelled' : 'end_turn' } });
  }
});
`;
    const env = makeFakeAgyEnv(t, fakeAgy);
    const bridge = startRelay(env);
    t.after(() => bridge.child.kill());

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await waitFor(() => bridge.lines.find((m) => m.id === 1), 5_000, 'initialize');
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.tmpdir(), mcpServers: [] } });
    await waitFor(() => bridge.lines.find((m) => m.id === 2), 5_000, 'session/new');

    const before = Date.now();
    bridge.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] } });
    const resp1 = await waitFor(() => bridge.lines.find((m) => m.id === 3), 5_000, 'first prompt response');
    const after = Date.now();
    assert.equal(resp1.error?.message, QUOTA_MSG);
    assert.equal(resp1.error?.data?._meta?.cindy?.kind, 'usage-limit');
    const resetsAt = resp1.error?.data?._meta?.cindy?.resetsAt;
    const expectedDelay = ((2 * 60 + 13) * 60 + 2) * 1000;
    assert.ok(resetsAt >= before + expectedDelay && resetsAt <= after + expectedDelay + 1_000, `unexpected resetsAt ${resetsAt}`);
    const leakedWarn = bridge.lines.some((m) => m.params?.update?.content?.text?.includes('⚠'));
    assert.equal(leakedWarn, false, 'warning chunk must not leak as assistant text');

    // Second prompt with partial real output before hitting quota: real output is kept, warning chunk is converted.
    bridge.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'continue' }] } });
    const resp2 = await waitFor(() => bridge.lines.find((m) => m.id === 4), 5_000, 'second prompt response');
    assert.equal(resp2.error?.data?._meta?.cindy?.kind, 'usage-limit');
    assert.ok(bridge.lines.some((m) => m.params?.update?.content?.text === 'Partial work.'));
    assert.equal(bridge.lines.some((m) => m.params?.update?.content?.text?.includes('⚠')), false);

    // Third prompt cancelled after warning: cancelled result is preserved and the held warning is flushed before it.
    bridge.send({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'cancel me' }] } });
    const resp3 = await waitFor(() => bridge.lines.find((m) => m.id === 5), 5_000, 'third prompt response');
    assert.deepEqual(resp3.result, { stopReason: 'cancelled' });
    const warnIdx = bridge.lines.findIndex((m) => m.params?.update?.content?.text?.includes('⚠'));
    const cancelIdx = bridge.lines.findIndex((m) => m.id === 5);
    assert.ok(warnIdx !== -1 && warnIdx < cancelIdx, 'held warning must be flushed before the cancelled response');

    bridge.child.stdin.end();
    await bridge.closed;
  });

  test('agy-acp end-to-end converts agy warning chunk + end_turn in remote-workspace mode', async (t) => {
    const fakeAgy = `'use strict';
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('1.5.18'); process.exit(0); }
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let promptCount = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.18' }, agentCapabilities: {} } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-r' } });
  } else if (msg.method === 'session/prompt') {
    promptCount += 1;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-r', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n⚠ ${QUOTA_MSG}\\n' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: promptCount === 2 ? 'cancelled' : 'end_turn' } });
  }
});
`;
    const env = makeFakeAgyEnv(t, fakeAgy);
    const bridge = startRelay(env, ['--cindy-remote-workspace']);
    t.after(() => bridge.child.kill());

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    await waitFor(() => bridge.lines.find((m) => m.id === 1), 5_000, 'remote initialize');
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: os.tmpdir(), mcpServers: [{ name: 'cindy_exec', type: 'http', url: 'http://127.0.0.1:9/mcp' }] },
    });
    await waitFor(() => bridge.lines.find((m) => m.id === 2), 5_000, 'remote session/new');
    bridge.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'sess-r', prompt: [{ type: 'text', text: 'hi' }] } });
    const resp = await waitFor(() => bridge.lines.find((m) => m.id === 3), 5_000, 'remote prompt response');
    assert.equal(resp.error?.message, QUOTA_MSG);
    assert.equal(resp.error?.data?._meta?.cindy?.kind, 'usage-limit');
    assert.equal(typeof resp.error?.data?._meta?.cindy?.resetsAt, 'number');
    assert.equal(bridge.lines.some((m) => m.params?.update?.content?.text?.includes('⚠')), false);

    bridge.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'sess-r', prompt: [{ type: 'text', text: 'cancel' }] } });
    const respCancelled = await waitFor(() => bridge.lines.find((m) => m.id === 4), 5_000, 'remote cancelled prompt response');
    assert.deepEqual(respCancelled.result, { stopReason: 'cancelled' });
    const warnIdx = bridge.lines.findIndex((m) => m.params?.update?.content?.text?.includes('⚠'));
    const cancelIdx = bridge.lines.findIndex((m) => m.id === 4);
    assert.ok(warnIdx !== -1 && warnIdx < cancelIdx, 'held warning must be flushed before remote cancelled response');

    bridge.child.stdin.end();
    await bridge.closed;
  });
});
