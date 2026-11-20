// Run: node --test test/
//
// Exercises the real entry files (worker.js, agy-acp.js) as child processes against
// a fake `agy` placed on PATH (a Node script plus a `.cmd` wrapper on Windows or a
// `sh` wrapper elsewhere). Each test gets its own temp directory, HOME and PATH, so
// the tests run in parallel and do not see a real agy installation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const RESULT_JSON =
  '{"protocolVersion":1,"agentCapabilities":{"loadSession":false,"promptCapabilities":{"image":false}},' +
  '"agentInfo":{"name":"fake-agy","title":"假 AGY ✓","version":"0.2.2"},"authMethods":[]}';
const INITIALIZE =
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n';
const EXPECTED_RESPONSE = Buffer.from(`{"jsonrpc":"2.0","id":0,"result":${RESULT_JSON}}\n`, 'utf8');

const EXPECTED_ACP_ARGS = ['--settings', '{"useG1Credits":false}', 'acp', '--disable-telemetry'];

const FAKE_AGY_SOURCE = `'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  if (process.env.FAKE_AGY_BROKEN === '1') {
    process.stderr.write('agy requires Node.js >= 24.9.0\\n');
    process.exit(1);
  }
  process.stdout.write('agy ' + (process.env.FAKE_AGY_VERSION || '0.2.2') + '\\n');
  process.exit(0);
}
if (args.includes('/usage')) {
  process.stdout.write(JSON.stringify({ status: 'SUCCESS', num_turns: 0,
    command: { name: 'usage', data: { groups: [{ name: process.env.FAKE_AGY_VERSION || '0.2.2', buckets: [{ window: '5h', remaining_fraction: 0.75 }] }] } } }));
  process.exit(0);
}
// Remote-workspace mode: the session process runs under the restricted agent of its working directory.
const REMOTE_ARGS = ${JSON.stringify(JSON.stringify([...EXPECTED_ACP_ARGS, '--agent', 'cindy-remote']))};
if (JSON.stringify(args) === REMOTE_ARGS) {
  const record = (extra) => fs.writeFileSync(process.env.FAKE_AGY_LAUNCHFILE, JSON.stringify(Object.assign({
    args, cwd: process.cwd(), files: fs.readdirSync(process.cwd()),
    definition: fs.readFileSync('.agents/agents/cindy-remote.md', 'utf8'),
  }, extra)));
  record({});
  if (process.env.FAKE_AGY_PIDFILE) fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, String(process.pid));
  const send = (message) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, message)) + '\\n');
  const MCP_CALL = { toolCallId: 'call-1', name: 'call_mcp_tool', kind: 'execute', title: 'MCP Tool Bash',
    args: { Arguments: { command: 'ls' }, ServerName: 'cindy_exec', ToolName: 'Bash' },
    rawInput: { Arguments: { command: 'ls' }, ServerName: 'cindy_exec', ToolName: 'Bash' } };
  // In a resumed session agy 1.5.13 reports the same call as a tool of its own name, with a summary it adds.
  const DIRECT_CALL = { toolCallId: 'call-1', name: 'mcp_cindy_exec_Bash', kind: 'other', title: 'Run mcp_cindy_exec_Bash',
    args: { command: 'ls', toolSummary: 'List files' }, rawInput: { command: 'ls', toolSummary: 'List files' } };
  let call = MCP_CALL;
  let promptId = null;
  let lines = '';
  process.stdin.on('data', (chunk) => {
    lines += chunk.toString('utf8');
    let index;
    while ((index = lines.indexOf('\\n')) !== -1) {
      const line = lines.slice(0, index);
      lines = lines.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
      } else if (message.method === 'session/new' || message.method === 'session/resume') {
        record({ method: message.method, session: message.params });
        if (message.method === 'session/resume') call = DIRECT_CALL;
        send({ id: message.id, result: { sessionId: 'sess-1', configOptions: [] } });
      } else if (message.method === 'session/prompt' && process.env.FAKE_AGY_SCRIPT === 'native') {
        // An agy that ignored the agent's tool list: one of its own tools runs, and the turn stays open.
        send({ method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', toolCallId: 'call-n',
          name: 'write_to_file', kind: 'edit', title: 'note.txt', status: 'in_progress' } } });
      } else if (message.method === 'session/prompt') {
        promptId = message.id;
        send({ id: 'perm-1', method: 'session/request_permission', params: { sessionId: 'sess-1',
          toolCall: Object.assign({ sessionUpdate: 'tool_call', status: 'pending' }, call),
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
      } else if (message.id === 'perm-1') {
        send({ method: 'session/update', params: { sessionId: 'sess-1', update: Object.assign({ sessionUpdate: 'tool_call', status: 'in_progress' }, call) } });
        // A later update without the arguments still carries agy's own name for the call.
        send({ method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1',
          kind: call.kind, title: call.title, status: 'completed', rawOutput: 'a.txt\\n' } } });
        send({ id: promptId, result: { stopReason: 'end_turn', answered: message.result.outcome.optionId } });
      }
    }
  });
  process.stdin.on('end', () => process.stdout.write('', () => process.exit(0)));
  return;
}
// Every launch must pass the constant ACP args (including no paid credits and no telemetry).
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(EXPECTED_ACP_ARGS))}) {
  process.stderr.write('fake-agy: unexpected arguments ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}
if (process.env.FAKE_AGY_ARGSFILE) fs.writeFileSync(process.env.FAKE_AGY_ARGSFILE, JSON.stringify(args));
if (process.env.FAKE_AGY_PIDFILE) fs.writeFileSync(process.env.FAKE_AGY_PIDFILE, String(process.pid));
process.stderr.write('fake-agy: ready\\n');
const STATE = process.env.FAKE_AGY_STATE;
if (STATE) {
  // Sign-in mode: an agent that offers Google sign-in and logout (like agy 1.5.12), keeps its sign-in
  // in FAKE_AGY_STATE and logs every ACP method it receives to FAKE_AGY_STATE + '.log'.
  const signedIn = () => fs.existsSync(STATE) && fs.readFileSync(STATE, 'utf8') === 'signed-in';
  const TIER = { antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: 'https://example.test/upgrade' } } };
  const send = (message) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, message)) + '\\n');
  const authRequired = (id) => send({ id, error: { code: -32000, message: 'Authentication required' } });
  let lines = '';
  process.stdin.on('data', (chunk) => {
    lines += chunk.toString('utf8');
    let index;
    while ((index = lines.indexOf('\\n')) !== -1) {
      const line = lines.slice(0, index);
      lines = lines.slice(index + 1);
      if (!line.trim()) continue;
      const { id, method, params } = JSON.parse(line);
      fs.appendFileSync(STATE + '.log', method + (method === 'authenticate' ? ':' + params.methodId : '') + '\\n');
      if (method === 'initialize') {
        send({ id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
          agentCapabilities: { auth: { logout: {} }, sessionCapabilities: { list: {}, resume: {}, close: {} } } } });
      } else if (method === 'authenticate') {
        if (params.methodId !== 'oauth-personal') send({ id, error: { code: -32602, message: 'Unsupported auth method' } });
        else if (process.env.FAKE_AGY_LOGIN !== 'hang') {
          fs.writeFileSync(STATE, 'signed-in');
          send({ id, result: { _meta: TIER } });
        }
      } else if (method === 'logout') {
        fs.writeFileSync(STATE, 'signed-out');
        send({ id, result: {} });
      } else if (method === 'session/list' || method === 'session/resume') {
        if (!signedIn()) authRequired(id);
        else send({ id, result: method === 'session/list' ? { sessions: [] } : { _meta: TIER } });
      } else if (method === 'session/new') {
        if (!signedIn()) authRequired(id);
        else send({ id, result: { sessionId: 'fake-session', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'fake-model',
          options: [{ value: 'fake-model', name: 'Fake ' + (process.env.FAKE_AGY_VERSION || '0.2.2') }] }] } });
      } else {
        send({ id, result: {} });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
const RESULT_JSON = ${JSON.stringify(RESULT_JSON)};
let buffered = '';
if (!STATE) process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let index;
  while ((index = buffered.indexOf('\\n')) !== -1) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method !== 'initialize') continue;
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":' + JSON.stringify(message.id) + ',"result":' + RESULT_JSON + '}\\n', 'utf8');
    // Split inside a multi-byte character: the bridge must relay bytes, not text.
    const cut = bytes.indexOf(Buffer.from('\\u2713', 'utf8')) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
  }
});
if (!STATE) process.stdin.on('end', () => {
  if (process.env.FAKE_AGY_IGNORE_EOF === '1') {
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write('', () => process.exit(0));
});
`;

function makeFixture(t, { withAgy = true, extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const script = path.join(dir, 'fake-agy.js');
  fs.writeFileSync(script, FAKE_AGY_SOURCE, 'utf8');
  let agyPath = null;
  if (withAgy) {
    if (isWin) {
      agyPath = path.join(bin, 'agy.cmd');
      fs.writeFileSync(agyPath, `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      agyPath = path.join(bin, 'agy');
      fs.writeFileSync(agyPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(agyPath, 0o755);
    }
  }
  const pidFile = path.join(dir, 'agy.pid');
  const env = { FAKE_AGY_PIDFILE: pidFile, ...extraEnv };
  if (isWin) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    Object.assign(env, {
      SystemRoot: systemRoot,
      PATH: [bin, path.join(systemRoot, 'System32')].join(';'),
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
    });
  } else {
    Object.assign(env, { PATH: [bin, '/usr/bin', '/bin'].join(':'), HOME: home, TMPDIR: os.tmpdir() });
  }
  return { dir, agyPath, pidFile, env };
}

/** Real installs in fixed system directories would make "not installed" untestable. */
function systemHasAgy() {
  if (isWin) return false;
  return ['/usr/local/bin', '/opt/homebrew/bin'].some((dir) => fs.existsSync(path.join(dir, 'agy')));
}

function samePath(a, b) {
  return isWin ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  return {
    bytes: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function waitClose(child) {
  return new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readPid(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return text ? Number(text) : null;
}

function startWorker(env) {
  const child = spawn(process.execPath, [path.join(root, 'worker.js')], { env, cwd: os.tmpdir(), stdio: 'pipe' });
  const stderr = collect(child.stderr);
  const closed = waitClose(child);
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const next = waiting.get(message.id);
    waiting.delete(message.id);
    if (next) next(message);
  });
  return {
    call(request) {
      return new Promise((resolve) => {
        waiting.set(request.id, resolve);
        child.stdin.write(JSON.stringify(request) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      const result = await closed;
      assert.equal(result.code, 0, `worker exit code (stderr: ${stderr.text()})`);
    },
  };
}

function startBridge(env, args = []) {
  const child = spawn(process.execPath, [path.join(root, 'agy-acp.js'), ...args], { env, cwd: os.tmpdir(), stdio: 'pipe' });
  return { child, stdout: collect(child.stdout), stderr: collect(child.stderr), closed: waitClose(child) };
}

describe('agy-acp plugin', { concurrency: true, timeout: 20_000 }, () => {
  test('detect finds agy on PATH and reports its version', async (t) => {
    const fixture = makeFixture(t);
    const worker = startWorker(fixture.env);
    const response = await worker.call({ jsonrpc: '2.0', id: 1, method: 'detect', params: { locale: 'zh-CN' } });
    assert.equal(response.id, 1);
    assert.equal(response.result.available, true);
    assert.equal(response.result.version, '0.2.2');
    assert.ok(samePath(response.result.path, fixture.agyPath), `path ${response.result.path}`);
    assert.equal(response.result.reason, undefined);

    const unknown = await worker.call({ jsonrpc: '2.0', id: 2, method: 'no/such-method' });
    assert.deepEqual(unknown, { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } });
    await worker.close();
  });

  test('detect reports not-installed with an install hint when agy is missing', async (t) => {
    if (systemHasAgy()) {
      t.skip('a real agy is installed in a fixed system directory on this machine');
      return;
    }
    const fixture = makeFixture(t, { withAgy: false });
    const worker = startWorker(fixture.env);
    const zh = await worker.call({ jsonrpc: '2.0', id: 'a', method: 'detect', params: { locale: 'zh-CN' } });
    assert.equal(zh.result.available, false);
    assert.equal(zh.result.reason, 'not-installed');
    assert.equal(zh.result.message, '未找到 Antigravity 命令行（agy）。请先从 https://antigravity.google 安装，然后点「重新检测」。');
    assert.equal(zh.result.path, undefined);
    const en = await worker.call({ jsonrpc: '2.0', id: 'b', method: 'detect', params: { locale: 'fr' } });
    assert.match(en.result.message, /^The Antigravity CLI \(agy\) was not found\. Install it from https:\/\/antigravity\.google/);
    assert.equal(en.result.messages['zh-CN'], zh.result.message);
    await worker.close();
  });

  test('detect reports not-runnable when agy --version fails', async (t) => {
    const fixture = makeFixture(t, { extraEnv: { FAKE_AGY_BROKEN: '1' } });
    const worker = startWorker(fixture.env);
    const response = await worker.call({ jsonrpc: '2.0', id: 3, method: 'detect', params: { locale: 'en' } });
    assert.equal(response.result.available, false);
    assert.equal(response.result.reason, 'not-runnable');
    assert.ok(samePath(response.result.path, fixture.agyPath));
    assert.match(response.result.detail, /exit code 1: agy requires Node\.js >= 24\.9\.0/);
    await worker.close();
  });

  test('agy-acp relays ACP bytes unchanged and exits with agy when stdin closes', async (t) => {
    const fixture = makeFixture(t);
    const bridge = startBridge(fixture.env);
    bridge.child.stdin.write(INITIALIZE);
    await waitFor(() => bridge.stdout.bytes().length >= EXPECTED_RESPONSE.length, 8_000, 'initialize response');
    assert.ok(bridge.stdout.bytes().equals(EXPECTED_RESPONSE), `stdout was ${JSON.stringify(bridge.stdout.text())}`);
    const pid = readPid(fixture.pidFile);
    assert.ok(pid, 'fake agy wrote its pid');
    assert.ok(isAlive(pid), 'fake agy is running before stdin closes');

    bridge.child.stdin.end();
    const { code } = await bridge.closed;
    assert.equal(code, 0);
    assert.ok(bridge.stdout.bytes().equals(EXPECTED_RESPONSE), 'no extra bytes on stdout');
    assert.match(bridge.stderr.text(), /fake-agy: ready/);
    await waitFor(() => !isAlive(pid), 3_000, 'fake agy to exit');
  });

  /**
   * Remote-workspace mode (`--cindy-remote-workspace`): the task's files and commands are on another
   * computer, so Antigravity's own file and command tools would act on the wrong one.
   * Why these tests: the mode replaces the byte-for-byte relay with one that reads ACP, starts agy
   * twice and rewrites what Cindy sees; the existing relay tests cover none of it. Each case below is
   * the smallest input for one promise of the mode: tools only through Cindy, no session without them,
   * a stop when agy uses a tool of its own, and no start on an agy that was never checked.
   */
  const remoteSession = (t, extraEnv = {}) => {
    const launchFile = path.join(os.tmpdir(), `agy-acp-launch-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    t.after(() => fs.rmSync(launchFile, { force: true }));
    const fixture = makeFixture(t, { extraEnv: { FAKE_AGY_VERSION: '1.5.13', FAKE_AGY_LAUNCHFILE: launchFile, ...extraEnv } });
    const bridge = startBridge(fixture.env, ['--cindy-remote-workspace']);
    // A failing case must not leave the entry (and the fake agy behind it) running.
    t.after(() => bridge.child.kill());
    const messages = () => bridge.stdout.text().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const send = (message) => bridge.child.stdin.write(JSON.stringify(message) + '\n');
    const reply = async (id, what) => {
      await waitFor(() => messages().some((m) => m.id === id && !m.method), 8_000, what);
      return messages().find((m) => m.id === id && !m.method);
    };
    const server = (name) => ({ type: 'http', name, url: `http://127.0.0.1:4711/mcp/${name}`, headers: [{ name: 'Authorization', value: 'Bearer task-secret' }] });
    return { launchFile, fixture, bridge, messages, send, reply, server };
  };

  test('remote-workspace mode runs the session under an agent that only has Cindy’s tools', async (t) => {
    const { launchFile, bridge, messages, send, reply, server } = remoteSession(t);
    bridge.child.stdin.write(INITIALIZE);
    const init = await reply(0, 'initialize answer');
    // agy connects to HTTP MCP servers without declaring it; Cindy hands its tools only to an agent that does.
    assert.deepEqual(init.result.agentCapabilities.mcpCapabilities, { http: true });
    assert.equal(init.result.agentInfo.title, '假 AGY ✓');

    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/shadow/p',
      mcpServers: [server('cindy_exec'), server('cindy'), server('not a name'), { name: 'local', command: 'tool', args: [], env: [] }] } });
    assert.deepEqual((await reply(1, 'session/new answer')).result, { sessionId: 'sess-1', configOptions: [] });
    const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
    assert.deepEqual(launch.args.slice(-2), ['--agent', 'cindy-remote']);
    assert.deepEqual(launch.files, ['.agents'], 'agy runs in a directory holding only the agent definition');
    assert.ok(!samePath(launch.cwd, os.tmpdir()), 'not the shared temp folder');
    // One harmless tool of agy's own; the servers by name only. Their address and the task token stay in session/new.
    assert.match(launch.definition, /^tools:\n  - search_web\nmcpServers:\n  - name: cindy_exec\n  - name: cindy\n---$/m);
    assert.doesNotMatch(launch.definition, /task-secret|127\.0\.0\.1/);
    assert.deepEqual(launch.session, { cwd: '/shadow/p', mcpServers: [server('cindy_exec'), server('cindy')] });

    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'list the files' }] } });
    await waitFor(() => messages().some((m) => m.method === 'session/request_permission'), 8_000, 'permission request');
    const permission = messages().find((m) => m.method === 'session/request_permission');
    // agy reports its generic MCP caller; Cindy must see (and check) its own Bash tool with the real arguments.
    const asked = permission.params.toolCall;
    assert.deepEqual({ title: asked.title, kind: asked.kind, rawInput: asked.rawInput, args: asked.args },
      { title: 'Bash', kind: 'execute', rawInput: { command: 'ls' }, args: undefined });
    send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    assert.deepEqual((await reply(2, 'prompt answer')).result, { stopReason: 'end_turn', answered: 'allow' });
    const updates = messages().filter((m) => m.method === 'session/update').map((m) => m.params.update);
    assert.deepEqual(updates.map((update) => [update.sessionUpdate, update.title, update.kind]),
      [['tool_call', 'Bash', 'execute'], ['tool_call_update', 'Bash', 'execute']]);
    assert.deepEqual(updates[0].rawInput, { command: 'ls' });

    bridge.child.stdin.end();
    assert.equal((await bridge.closed).code, 0);
    assert.ok(!fs.existsSync(launch.cwd), 'the private directory is removed when the task ends');
  });

  // Why: a task is resumed every time it is reopened (and after Cindy releases an idle connection). agy then
  // reports Cindy's tools in another form than in a new session; left as it is, Cindy would show
  // "Run mcp_cindy_exec_Bash" and could not match an approved command to the one that runs.
  test('remote-workspace mode names Cindy’s tools the same way in a resumed session', async (t) => {
    const { launchFile, bridge, messages, send, reply, server } = remoteSession(t);
    bridge.child.stdin.write(INITIALIZE);
    await reply(0, 'initialize answer');
    send({ jsonrpc: '2.0', id: 1, method: 'session/resume', params: { sessionId: 'sess-1', cwd: '/shadow/p', mcpServers: [server('cindy_exec')] } });
    await reply(1, 'session/resume answer');
    const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
    assert.equal(launch.method, 'session/resume');
    assert.deepEqual(launch.args.slice(-2), ['--agent', 'cindy-remote'], 'a resumed session runs under the restricted agent too');

    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'list the files' }] } });
    await waitFor(() => messages().some((m) => m.method === 'session/request_permission'), 8_000, 'permission request');
    const permission = messages().find((m) => m.method === 'session/request_permission');
    const asked = permission.params.toolCall;
    assert.deepEqual({ title: asked.title, kind: asked.kind, rawInput: asked.rawInput, args: asked.args },
      { title: 'Bash', kind: 'execute', rawInput: { command: 'ls' }, args: undefined });
    send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await reply(2, 'prompt answer');
    const updates = messages().filter((m) => m.method === 'session/update').map((m) => m.params.update);
    assert.deepEqual(updates.map((update) => [update.sessionUpdate, update.title, update.kind]),
      [['tool_call', 'Bash', 'execute'], ['tool_call_update', 'Bash', 'execute']]);
    bridge.child.stdin.end();
    assert.equal((await bridge.closed).code, 0);
  });

  test('remote-workspace mode does not start a session without Cindy’s file and command tools', async (t) => {
    const { launchFile, bridge, send, reply, server } = remoteSession(t);
    bridge.child.stdin.write(INITIALIZE);
    await reply(0, 'initialize answer');
    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/shadow/p', mcpServers: [server('cindy')] } });
    const refused = await reply(1, 'session/new answer');
    assert.equal(refused.error.code, -32602);
    assert.match(refused.error.message, /cindy_exec/);
    assert.ok(!fs.existsSync(launchFile), 'the session process was never started');
    bridge.child.stdin.end();
    assert.equal((await bridge.closed).code, 0);
  });

  test('remote-workspace mode stops the task when Antigravity uses a tool of its own', async (t) => {
    const { fixture, bridge, messages, send, reply, server } = remoteSession(t, { FAKE_AGY_SCRIPT: 'native' });
    bridge.child.stdin.write(INITIALIZE);
    await reply(0, 'initialize answer');
    send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/shadow/p', mcpServers: [server('cindy_exec')] } });
    await reply(1, 'session/new answer');
    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'write a note' }] } });
    // Nothing else ends this turn: the entry has to stop the task by itself.
    const closed = await Promise.race([bridge.closed, new Promise((resolve) => setTimeout(() => resolve(null), 8_000))]);
    assert.ok(closed, 'the entry ended the task');
    assert.equal(closed.code, 78);
    assert.match(bridge.stderr.text(), /its own tool "write_to_file"/);
    // The user is told why the task ended; the call is not passed on as work that was done.
    const updates = messages().filter((m) => m.method === 'session/update').map((m) => m.params.update);
    assert.deepEqual(updates.map((update) => update.sessionUpdate), ['agent_message_chunk']);
    const pid = readPid(fixture.pidFile);
    assert.ok(pid, 'the session process had started');
    await waitFor(() => !isAlive(pid), 4_000, 'fake agy to be stopped');
  });

  test('remote-workspace mode refuses an Antigravity CLI older than the version it was checked with', async (t) => {
    const fixture = makeFixture(t); // the fake reports 0.2.2
    const bridge = startBridge(fixture.env, ['--cindy-remote-workspace']);
    const { code } = await bridge.closed;
    assert.equal(code, 78);
    assert.equal(bridge.stdout.bytes().length, 0);
    assert.match(bridge.stderr.text(), /needs 1\.5\.13 or later/);
    assert.equal(readPid(fixture.pidFile), null, 'agy was never started for ACP');
  });

  // Why: Cindy shows 「允许被远程调用」 only for an engine that reports remoteWorkspace. main.js runs in the
  // plugin page and cannot load remote-workspace.js, so it carries its own copy of the version check; if
  // the two drift apart the switch is offered for an agy the entry then refuses (or never offered).
  test('main.js offers the engine to other computers exactly from the agy version the entry accepts', async () => {
    const { versionSupported } = (await import(pathToFileURL(path.join(root, 'remote-workspace.js')).href)).default;
    const published = async (version) => {
      const puts = [];
      class Channel { constructor() { this.onmessage = null; } postMessage() {} }
      const context = vm.createContext({
        BroadcastChannel: Channel,
        setTimeout,
        clearTimeout,
        cindy: {
          request: async () => ({ ok: true, context: { locale: 'en', uiLocale: 'en' } }),
          node: {
            request: async (request) => (request.method === 'detect'
              ? { ok: true, result: { available: true, version } }
              : { ok: true, result: { supported: true, sessionId: 'probe-1', models: [], modes: [] } }),
          },
          onHostMessage: () => () => {},
        },
        fetch: async (url, init) => {
          if (url === '/kv' && !init) return { ok: true, json: async () => ({}) };
          if (url === '/harnesses') puts.push(JSON.parse(init.body));
          return { ok: true, status: 204 };
        },
      });
      vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
      await waitFor(() => puts.some((body) => body.harnesses[0].available), 3_000, `engine published for ${version}`);
      return puts.findLast((body) => body.harnesses[0].available).harnesses[0];
    };
    assert.deepEqual(['1.5.12', '1.5.13', '1.6.0', '2.0.1'].map(versionSupported), [false, true, true, true]);
    for (const version of ['1.5.12', '1.5.13', '1.6.0', '2.0.1']) {
      assert.equal((await published(version)).remoteWorkspace === true, versionSupported(version), version);
    }
  });

  test('stopping agy-acp leaves no agy process behind', async (t) => {
    // POSIX: the SIGTERM handler must stop a agy that ignores stdin EOF.
    // Windows: TerminateProcess skips handlers; agy must see EOF on its stdin and exit.
    const fixture = makeFixture(t, { extraEnv: isWin ? {} : { FAKE_AGY_IGNORE_EOF: '1' } });
    const bridge = startBridge(fixture.env);
    await waitFor(() => readPid(fixture.pidFile) !== null, 8_000, 'fake agy to start');
    const pid = readPid(fixture.pidFile);
    assert.ok(isAlive(pid), 'fake agy is running before the stop');
    bridge.child.kill('SIGTERM');
    const { code } = await bridge.closed;
    if (!isWin) assert.equal(code, 143);
    await waitFor(() => !isAlive(pid), 4_000, 'fake agy to be stopped');
    assert.equal(bridge.stdout.bytes().length, 0);
  });

  test('agy-acp force-stops a agy that lingers after stdin closes', async (t) => {
    // Windows: exercises the taskkill /T tree kill (cmd.exe shim and node).
    const fixture = makeFixture(t, { extraEnv: { FAKE_AGY_IGNORE_EOF: '1' } });
    const bridge = startBridge(fixture.env);
    await waitFor(() => readPid(fixture.pidFile) !== null, 8_000, 'fake agy to start');
    const pid = readPid(fixture.pidFile);
    assert.ok(isAlive(pid), 'fake agy is running before stdin closes');
    bridge.child.stdin.end();
    const { code } = await bridge.closed;
    assert.notEqual(code, 0);
    await waitFor(() => !isAlive(pid), 3_000, 'fake agy to be stopped');
  });

  test('main.js publishes detection with PUT /harnesses and answers the settings page', async (t) => {
    const ZH = '未找到 Antigravity 命令行（agy）。请先从 https://antigravity.google 安装，然后点「重新检测」。';
    const EN = 'The Antigravity CLI (agy) was not found. Install it from https://antigravity.google, then select Check again.';
    const channels = [];
    class TrackedChannel extends BroadcastChannel {
      constructor(name) {
        super(name);
        channels.push(this);
      }
    }
    t.after(() => channels.forEach((channel) => channel.close()));
    const puts = [];
    const nodeCalls = [];
    const hostListeners = [];
    let putStatus = 404; // an older Cindy without the endpoint
    const context = vm.createContext({
      BroadcastChannel: TrackedChannel,
      setTimeout,
      clearTimeout,
      cindy: {
        request: async (request) =>
          request.kind === 'app-context' ? { ok: true, context: { region: 'cn', locale: 'zh-CN', uiLocale: 'zh-CN' } } : { ok: false },
        node: {
          request: async (request) => {
            nodeCalls.push(JSON.parse(JSON.stringify(request))); // copy out of the vm realm
            return {
              ok: true,
              result: { available: false, reason: 'not-installed', message: ZH, messages: { 'zh-CN': ZH, en: EN } },
            };
          },
        },
        onHostMessage: (listener) => {
          hostListeners.push(listener);
          return () => {};
        },
      },
      fetch: async (url, init) => {
        puts.push({ url, method: init && init.method, body: JSON.parse(init.body) });
        return { ok: putStatus < 300, status: putStatus };
      },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });

    await waitFor(() => puts.length === 1, 3_000, 'publish on start');
    assert.deepEqual(nodeCalls[0], { method: 'detect', params: { locale: 'zh-CN' }, timeoutMs: 30_000 });
    assert.deepEqual(puts[0], {
      url: '/harnesses',
      method: 'PUT',
      body: { harnesses: [{ id: 'agy', available: false, reason: 'not-installed', message: ZH }] },
    });

    const page = new TrackedChannel('agy-acp');
    const received = [];
    page.onmessage = (event) => received.push(event.data);
    putStatus = 204;
    page.postMessage({ type: 'detect-request', reqId: 'r1' });
    await waitFor(() => received.some((m) => m.type === 'detect-result'), 3_000, 'detect-result');
    assert.ok(received.some((m) => m.type === 'detect-ack' && m.reqId === 'r1'));
    const { snapshot } = received.find((m) => m.type === 'detect-result');
    assert.equal(snapshot.result.reason, 'not-installed');
    assert.deepEqual(snapshot.publish, { status: 'published' });
    assert.equal(nodeCalls.length, 2);

    // A resent request is only acknowledged again, never detected twice.
    page.postMessage({ type: 'detect-request', reqId: 'r1' });
    await waitFor(() => received.filter((m) => m.type === 'detect-ack').length === 2, 3_000, 'second ack');
    assert.equal(nodeCalls.length, 2);

    // Switching Cindy to English republishes the stored hint in English without re-detecting.
    hostListeners[0]({ type: 'host-context-changed', ok: true, context: { region: 'cn', locale: 'en', uiLocale: 'en' } });
    await waitFor(() => puts.length === 3, 3_000, 'republish after language change');
    assert.equal(puts[2].body.harnesses[0].message, EN);
    assert.equal(nodeCalls.length, 2);
  });

  // 2026-11-19:agy 未登录时会话起不来；登录后点「重新检测」要立即恢复，并发布模型与 Agent 自己的模式。
  test('main.js shows a sign-in hint until agy signs in, then publishes its models and modes', async () => {
    class Channel {
      static all = [];
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        Channel.all.push(this);
      }
      postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of Channel.all) {
          if (other !== this && other.name === this.name && other.onmessage) setTimeout(() => other.onmessage({ data: copy }), 0);
        }
      }
    }
    const nodeCalls = [];
    const puts = [];
    let savedState = null;
    let signedIn = false;
    const context = vm.createContext({
      BroadcastChannel: Channel,
      setTimeout,
      clearTimeout,
      cindy: {
        request: async () => ({ ok: true, context: { locale: 'en', uiLocale: 'en' } }),
        node: {
          request: async (request) => {
            nodeCalls.push(JSON.parse(JSON.stringify(request)));
            if (request.method === 'detect') return { ok: true, result: { available: true, version: '1.5.12' } };
            if (!signedIn) return { ok: true, result: { supported: false, reason: 'not-signed-in' } };
            return { ok: true, result: { supported: true, sessionId: 'probe-1',
              models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }],
              modes: ['default', 'acceptEdits', 'auto', 'plan', 'yolo'], defaultMode: 'default' } };
          },
        },
        onHostMessage: () => () => {},
      },
      fetch: async (url, init) => {
        if (url === '/kv' && !init) return { ok: true, json: async () => ({}) };
        if (url === '/kv') savedState = JSON.parse(init.body);
        if (url === '/harnesses') puts.push(JSON.parse(init.body));
        return { ok: true, status: 204 };
      },
    });
    const calls = (method) => nodeCalls.filter((call) => call.method === method);
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });

    // Start-up: agy is installed but refuses a session: unavailable with the sign-in hint.
    await waitFor(() => puts.some((body) => body.harnesses[0].reason === 'not-signed-in'), 3_000, 'sign-in hint');
    assert.deepEqual(puts.at(-1), { harnesses: [{ id: 'agy', available: false, reason: 'not-signed-in', version: '1.5.12',
      message: 'Antigravity is not signed in. Open the Antigravity plugin settings and select Sign in with Google.' }] });

    // Signed in, then "Check again": listed right away (no one-minute wait) and published with the modes.
    signedIn = true;
    const page = new Channel('agy-acp');
    const received = [];
    page.onmessage = (event) => received.push(event.data);
    page.postMessage({ type: 'detect-request', reqId: 'r1' });
    await waitFor(() => puts.some((body) => body.harnesses[0].modes), 3_000, 'models and modes published');
    assert.deepEqual(puts.at(-1), { harnesses: [{ id: 'agy', available: true, reportsUsage: true, version: '1.5.12',
      models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }],
      modes: ['default', 'acceptEdits', 'auto', 'plan'], defaultMode: 'default' }] });
    assert.equal(calls('listModels').length, 2);
    assert.deepEqual(savedState.modes, ['default', 'acceptEdits', 'auto', 'plan']);
    assert.equal(savedState.modelSessionId, 'probe-1');
    // The page hears the cleared hint without asking again.
    await waitFor(() => received.some((m) => m.type === 'detect-result' && m.snapshot.signInRequired === false), 3_000, 'updated snapshot');
  });

  // 2026-11-19 实测 agy 1.5.12:ACP 的 authenticate(oauth-personal)由 agy 打开浏览器登录；logout 一调用就登出。
  test('the worker signs agy in and out over ACP and reports only the sign-in and the tier', async (t) => {
    const fixture = makeFixture(t);
    const state = path.join(fixture.dir, 'agy-state');
    fixture.env.FAKE_AGY_STATE = state;
    const worker = startWorker(fixture.env);
    const call = async (id, method, params) => (await worker.call({ jsonrpc: '2.0', id, method, params })).result;
    const capabilities = { canSignIn: true, canSignOut: true };
    assert.deepEqual(await call(1, 'account', {}), { supported: true, ...capabilities, signedIn: false });
    assert.deepEqual(await call(2, 'login', {}), { ok: true, tier: { name: 'Google AI Pro' } });
    assert.deepEqual(await call(3, 'account', { sessionId: 'probe-1' }),
      { supported: true, ...capabilities, signedIn: true, tier: { name: 'Google AI Pro' } });
    assert.deepEqual(await call(4, 'logout', {}), { ok: true });
    assert.deepEqual(await call(5, 'account', {}), { supported: true, ...capabilities, signedIn: false });
    const sent = fs.readFileSync(state + '.log', 'utf8').trim().split('\n');
    assert.deepEqual(sent.filter((method) => method.startsWith('authenticate') || method === 'logout'),
      ['authenticate:oauth-personal', 'logout']);
    await worker.close();
  });

  test('cancelling a sign-in stops agy and reports it as cancelled', async (t) => {
    const fixture = makeFixture(t, { extraEnv: { FAKE_AGY_LOGIN: 'hang' } });
    const state = path.join(fixture.dir, 'agy-state');
    fixture.env.FAKE_AGY_STATE = state;
    const worker = startWorker(fixture.env);
    const login = worker.call({ jsonrpc: '2.0', id: 1, method: 'login' });
    await waitFor(() => fs.existsSync(state + '.log') && fs.readFileSync(state + '.log', 'utf8').includes('authenticate'),
      5_000, 'sign-in sent to agy');
    const agyPid = readPid(fixture.pidFile);
    assert.deepEqual((await worker.call({ jsonrpc: '2.0', id: 2, method: 'cancelLogin' })).result, { ok: true, cancelled: true });
    assert.deepEqual((await login).result, { ok: false, error: 'cancelled' });
    await waitFor(() => !isAlive(agyPid), 5_000, 'agy stopped');
    await worker.close();
  });

  // 登录前就开始读取模型时，它晚于登录返回的「未登录」不能把引擎改回未登录。
  test('main.js signs in and out for the settings page and keeps Cindy’s engine status in step', async () => {
    class Channel {
      static all = [];
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        Channel.all.push(this);
      }
      postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of Channel.all) {
          if (other !== this && other.name === this.name && other.onmessage) setTimeout(() => other.onmessage({ data: copy }), 0);
        }
      }
    }
    const nodeCalls = [];
    const puts = [];
    let finishFirstListing = null;
    const context = vm.createContext({
      BroadcastChannel: Channel,
      setTimeout,
      clearTimeout,
      cindy: {
        request: async () => ({ ok: true, context: { locale: 'zh-CN', uiLocale: 'zh-CN' } }),
        node: {
          request: async (request) => {
            nodeCalls.push(JSON.parse(JSON.stringify(request)));
            if (request.method === 'detect') return { ok: true, result: { available: true, version: '1.5.12' } };
            if (request.method === 'listModels' && !finishFirstListing) {
              // The start-up listing began while agy was signed out and answers only after the sign-in.
              return new Promise((resolve) => {
                finishFirstListing = () => resolve({ ok: true, result: { supported: false, reason: 'not-signed-in' } });
              });
            }
            if (request.method === 'listModels') {
              return { ok: true, result: { supported: true, sessionId: 'probe-1', tier: { name: 'Google AI Pro' },
                models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }] } };
            }
            if (request.method === 'login') return { ok: true, result: { ok: true, tier: { name: 'Google AI Pro' } } };
            if (request.method === 'logout') return { ok: true, result: { ok: true } };
            return { ok: false };
          },
        },
        onHostMessage: () => () => {},
      },
      fetch: async (url, init) => {
        if (url === '/kv' && !init) return { ok: true, json: async () => ({}) };
        if (url === '/harnesses') puts.push(JSON.parse(init.body).harnesses[0]);
        return { ok: true, status: 204 };
      },
    });
    const calls = (method) => nodeCalls.filter((call) => call.method === method);
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
    await waitFor(() => finishFirstListing, 3_000, 'start-up listing');

    const page = new Channel('agy-acp');
    const received = [];
    page.onmessage = (event) => received.push(event.data);
    const result = (reqId) => received.find((m) => m.type === 'account-result' && m.reqId === reqId);
    page.postMessage({ type: 'account-request', reqId: 'a1', op: 'login' });
    page.postMessage({ type: 'account-request', reqId: 'a1', op: 'login' }); // resent before the ack
    await waitFor(() => result('a1'), 3_000, 'sign-in result');
    assert.deepEqual(calls('login'), [{ method: 'login', params: {}, timeoutMs: 30_000, maxTotalMs: 330_000 }]);
    assert.deepEqual(result('a1').account, { signedIn: true, tier: 'Google AI Pro', canSignIn: true, canSignOut: true, busy: null });

    finishFirstListing();
    await waitFor(() => puts.length && puts.at(-1).models, 3_000, 'models read again after the sign-in');
    assert.ok(puts.every((entry) => entry.available), 'the late listing never marks the engine signed out');
    assert.deepEqual(puts.at(-1), { id: 'agy', available: true, reportsUsage: true, version: '1.5.12', models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }] });

    page.postMessage({ type: 'account-request', reqId: 'a2', op: 'logout' });
    await waitFor(() => result('a2'), 3_000, 'sign-out result');
    assert.equal(calls('logout').length, 1);
    assert.equal(result('a2').account.signedIn, false);
    assert.deepEqual(puts.at(-1), { id: 'agy', available: false, reason: 'not-signed-in', version: '1.5.12',
      message: 'Antigravity 还没有登录。请打开 Antigravity 插件设置，点「用 Google 登录」。' });
  });

  // agy 的 logout 一调用就登出(2026-11-19 实测)：设置页只在用户确认后才发出退出请求。
  test('the settings page resumes a CLI update after reopening and confirms sign-out', async () => {
    class Channel {
      static all = [];
      constructor(name) {
        this.name = name;
        this.onmessage = null;
        this.listeners = [];

        Channel.all.push(this);
      }
      addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
      postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of Channel.all) {
          if (other === this || other.name !== this.name) continue;
          setTimeout(() => {
            other.onmessage?.({ data: copy });
            for (const listener of other.listeners) listener({ data: copy });
          }, 0);
        }
      }
    }
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) {
        const listeners = {};
        elements.set(id, { id, textContent: '', hidden: false, disabled: false, attributes: {}, dataset: {}, listeners,
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(type, listener) { listeners[type] = listener; },
          focus() {},
          click() { listeners.click(); } });
      }
      return elements.get(id);
    };
    const context = vm.createContext({
      BroadcastChannel: Channel, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval,
      document: { getElementById: element, documentElement: {}, visibilityState: 'visible', addEventListener() {} },
      fetch: async (url) => ({ ok: true,
        json: async () => (url === '/app-context' ? { context: { uiLocale: 'zh-CN' } } : { state: 'on' }) }),
    });
    // Stands in for main.js: agy is installed and signed in.
    const main = new Channel('agy-acp');
    const requests = [];
    const maintenance = [];
    let version = '1.5.11';
    let maintenanceState = { type: 'cli-state' };
    let finishUpdate;
    const account = { signedIn: true, tier: 'Google AI Pro', canSignIn: true, canSignOut: true, busy: null };
    main.onmessage = ({ data }) => {
      if (data.type === 'detect-request') {
        main.postMessage({ type: 'detect-ack', reqId: data.reqId });
        main.postMessage({ type: 'detect-result', reqId: data.reqId, snapshot: { ok: true, account,
          result: { available: true, version }, signInRequired: false, publish: { status: 'published' }, checkedAt: 1 } });
      }
      if (data.type === 'cli-state-request') main.postMessage(maintenanceState);
      if (data.type === 'cli-maintenance') {
        maintenance.push(data);
        const status = { type: 'cli-state', reqId: data.reqId, action: data.action };
        if (data.action === 'check') {
          maintenanceState = { ...status, result: { state: 'newer', version: '1.5.12' } };
        } else {
          maintenanceState = { ...status, active: true };
          finishUpdate = () => {
            version = data.version;
            maintenanceState = { ...status, result: { state: 'installed', version } };
            main.postMessage(maintenanceState);
          };
        }
        main.postMessage(maintenanceState);
      }
      if (data.type === 'account-request') {
        requests.push(data.op);
        main.postMessage({ type: 'account-ack', reqId: data.reqId });
        main.postMessage({ type: 'account-result', reqId: data.reqId, op: data.op, account });
      }
    };
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(root, 'cli-settings.js'), 'utf8'), context, { filename: 'cli-settings.js' });
    const openSettings = () => vm.runInContext(fs.readFileSync(path.join(root, 'settings.js'), 'utf8'), context, { filename: 'settings.js' });
    openSettings();

    await waitFor(() => element('account-status').textContent === '已登录 · Google AI Pro', 3_000, 'signed-in status');
    assert.equal(element('badge').textContent, '可以使用');
    assert.equal(element('account-logout').hidden, false);
    assert.equal(element('account-login').hidden, true);
    // After each detection the page also asks once whether agy is signed in.
    await waitFor(() => requests.length > 0, 3_000, 'sign-in check after detection');
    assert.deepEqual(requests, ['status']);
    element('account-logout').click();
    assert.equal(element('account-confirm').hidden, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(requests, ['status'], 'choosing Sign out only asks for confirmation');
    element('account-confirm-yes').click();
    await waitFor(() => requests.includes('logout'), 3_000, 'sign-out request after confirming');

    await waitFor(() => element('cli-action').textContent === '更新到 1.5.12', 3_000, 'automatic update check');
    assert.deepEqual(maintenance.map(item => item.action), ['check']);
    assert.equal(element('recheck').attributes['aria-label'], '检测 CLI 版本和更新');
    element('recheck').click();
    await waitFor(() => maintenance.length === 2 && !element('recheck').disabled, 3_000, 'manual check completed');
    assert.deepEqual(maintenance.map(item => item.action), ['check', 'check']);
    element('cli-action').click();
    await waitFor(() => !!finishUpdate, 3_000, 'CLI update started');
    await waitFor(() => maintenanceState.active, 3_000, 'active state published');
    Channel.all = [main];
    elements.clear();
    openSettings();
    await waitFor(() => element('cli-status').textContent === '正在更新…', 3_000, 'restored update in progress');
    assert.equal(element('recheck').disabled, true);
    assert.equal(element('cli-action').hidden, true);
    finishUpdate();
    await waitFor(() => element('version').textContent === '1.5.12', 3_000, 'local CLI version after refresh');
    assert.equal(element('recheck').disabled, false);
    assert.equal(element('cli-action').hidden, true);
    assert.deepEqual(maintenance.map(item => item.action), ['check', 'check', 'update']);
    assert.equal(maintenance[2].version, '1.5.12');
  });

  test('listModels reads the model option agy offers, flattening its groups', async () => {
    const { modelsFromConfigOptions } = await import(pathToFileURL(path.join(root, 'agy-models.js')).href);
    assert.deepEqual(modelsFromConfigOptions([
      { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
      { id: 'model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [
        { name: 'Models', options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: 'Anthropic via Antigravity' },
          { value: 'claude-opus-5-5', name: 'duplicate' },
          { name: 'no value' },
        ] },
      ] },
    ]), [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', group: 'Models' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', description: 'Anthropic via Antigravity', group: 'Models' },
    ]);
    assert.deepEqual(modelsFromConfigOptions(undefined), []);
  });

  // 测试的是与 DSH 插件同一套档位规则(DSH 的 off 在 Cindy 中没有对应档)；agy 1.5.12 是 low / medium / high / xhigh。
  test('reasoning levels come from the thought_level option, keeping only Cindy level ids', async () => {
    const { effortsFromConfigOptions } = await import(pathToFileURL(path.join(root, 'agy-models.js')).href);
    const thought = (currentValue, values) => [{ id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue,
      options: values.map((value) => ({ value, name: value })) }];
    assert.deepEqual(effortsFromConfigOptions(thought('high', ['off', 'low', 'high', 'max'])),
      { efforts: ['low', 'high', 'max'], defaultEffort: 'high' });
    assert.deepEqual(effortsFromConfigOptions(thought('off', ['max', 'off', 'low'])), { efforts: ['low', 'max'] });
    assert.deepEqual(effortsFromConfigOptions(thought('off', ['off'])), {});
    assert.deepEqual(effortsFromConfigOptions(undefined), {});
  });

  // agy 1.5.12 的 mode 配置项：default / accept-edits / auto / plan(2026-11-19 实测)。
  test('working modes map to Cindy permission mode ids in agy’s order', async () => {
    const { modesFromConfigOptions } = await import(pathToFileURL(path.join(root, 'agy-models.js')).href);
    const mode = (currentValue, values) => [{ id: 'mode', category: 'mode', type: 'select', currentValue,
      options: values.map((value) => ({ value, name: value })) }];
    assert.deepEqual(modesFromConfigOptions(mode('default', ['default', 'accept-edits', 'auto', 'plan', 'yolo'])),
      { modes: ['default', 'acceptEdits', 'auto', 'plan'], defaultMode: 'default' });
    assert.deepEqual(modesFromConfigOptions(mode('yolo', ['plan', 'yolo'])), { modes: ['plan'] });
    assert.deepEqual(modesFromConfigOptions(mode('yolo', ['yolo'])), {});
    assert.deepEqual(modesFromConfigOptions(undefined), {});
  });

  test('agy-acp exits 127 with a single stderr line when agy is missing', async (t) => {
    if (systemHasAgy()) {
      t.skip('a real agy is installed in a fixed system directory on this machine');
      return;
    }
    const fixture = makeFixture(t, { withAgy: false });
    const bridge = startBridge(fixture.env);
    const { code } = await bridge.closed;
    assert.equal(code, 127);
    assert.equal(bridge.stdout.bytes().length, 0);
    assert.match(bridge.stderr.text(), /^\[agy-acp\] [^\n]*https:\/\/antigravity\.google[^\n]*\n$/);
  });

  test('custom agy path is shared by detect, account, login, listModels, usage, and agy-acp, and blocks unsafe fallbacks', async (t) => {
    const stateFile = path.join(os.tmpdir(), `agy-custom-state-${process.pid}-${Date.now()}`);
    t.after(() => {
      fs.rmSync(stateFile, { force: true });
      fs.rmSync(stateFile + '.log', { force: true });
    });
    const fixture = makeFixture(t, { extraEnv: { FAKE_AGY_STATE: stateFile } });
    const customDir = path.join(fixture.dir, 'custom');
    fs.mkdirSync(customDir);
    const customScript = path.join(customDir, 'custom-agy.js');
    fs.writeFileSync(customScript, FAKE_AGY_SOURCE, 'utf8');
    const callsFile = path.join(fixture.dir, 'custom.calls');
    const argsFile = path.join(fixture.dir, 'custom.args');
    let customBin;
    let brokenBin;
    if (isWin) {
      customBin = path.join(customDir, 'my-agy.cmd');
      fs.writeFileSync(customBin, `@set FAKE_AGY_VERSION=9.9.9\r\n@echo %*>>"${callsFile}"\r\n@"${process.execPath}" "${customScript}" %*\r\n`);
      brokenBin = path.join(customDir, 'broken-agy.cmd');
      fs.writeFileSync(brokenBin, `@set FAKE_AGY_BROKEN=1\r\n@"${process.execPath}" "${customScript}" %*\r\n`);
    } else {
      customBin = path.join(customDir, 'my-agy');
      fs.writeFileSync(customBin, `#!/bin/sh\necho "$@" >> "${callsFile}"\nFAKE_AGY_VERSION=9.9.9 exec "${process.execPath}" "${customScript}" "$@"\n`);
      fs.chmodSync(customBin, 0o755);
      brokenBin = path.join(customDir, 'broken-agy');
      fs.writeFileSync(brokenBin, `#!/bin/sh\nFAKE_AGY_BROKEN=1 exec "${process.execPath}" "${customScript}" "$@"\n`);
      fs.chmodSync(brokenBin, 0o755);
    }

    const env = { ...fixture.env, FAKE_AGY_ARGSFILE: argsFile };
    const worker = startWorker(env);
    t.after(() => worker.close());

    // Malformed, relative, missing, and non-runnable paths are rejected without saving config.json.
    const badMissingParam = await worker.call({ jsonrpc: '2.0', id: 1, method: 'setCustomPath', params: {} });
    assert.deepEqual(badMissingParam.result, { ok: false, error: 'not-absolute' });
    const badType = await worker.call({ jsonrpc: '2.0', id: 2, method: 'setCustomPath', params: { path: 42 } });
    assert.deepEqual(badType.result, { ok: false, error: 'not-absolute' });
    const badRel = await worker.call({ jsonrpc: '2.0', id: 3, method: 'setCustomPath', params: { path: 'agy', locale: 'en' } });
    assert.deepEqual(badRel.result, { ok: false, error: 'not-absolute' });
    const badMissing = await worker.call({ jsonrpc: '2.0', id: 4, method: 'setCustomPath', params: { path: path.join(customDir, 'nope'), locale: 'en' } });
    assert.deepEqual(badMissing.result, { ok: false, error: 'not-found' });
    const badProbe = await worker.call({ jsonrpc: '2.0', id: 5, method: 'setCustomPath', params: { path: brokenBin, locale: 'en' } });
    assert.equal(badProbe.result.ok, false);
    assert.equal(badProbe.result.error, 'not-runnable');
    const afterFailedSave = await worker.call({ jsonrpc: '2.0', id: 6, method: 'detect', params: { locale: 'en' } });
    assert.equal(afterFailedSave.result.customPath, undefined);
    assert.equal(afterFailedSave.result.version, '0.2.2');

    // Saving a quoted custom path succeeds and routes detect, account, login, listModels, usage, and agy-acp to it.
    const saved = await worker.call({ jsonrpc: '2.0', id: 7, method: 'setCustomPath', params: { path: `"${customBin}"`, locale: 'en' } });
    assert.equal(saved.result.ok, true);
    assert.ok(samePath(saved.result.customPath, customBin));
    assert.equal(saved.result.detection.available, true);
    assert.equal(saved.result.detection.version, '9.9.9');
    assert.equal(saved.result.detection.customPathConfigured, true);
    assert.ok(samePath(saved.result.detection.path, customBin));
    assert.ok(samePath(saved.result.detection.customPath, customBin));

    // Malformed setCustomPath must NOT clear the saved config.
    const badTypeAfterSave = await worker.call({ jsonrpc: '2.0', id: 8, method: 'setCustomPath', params: {} });
    assert.deepEqual(badTypeAfterSave.result, { ok: false, error: 'not-absolute' });

    const acctBefore = await worker.call({ jsonrpc: '2.0', id: 9, method: 'account', params: {} });
    assert.equal(acctBefore.result.supported, true);
    assert.equal(acctBefore.result.signedIn, false);
    const loginRes = await worker.call({ jsonrpc: '2.0', id: 10, method: 'login', params: {} });
    assert.equal(loginRes.result.ok, true);
    const modelsRes = await worker.call({ jsonrpc: '2.0', id: 11, method: 'listModels', params: {} });
    assert.equal(modelsRes.result.supported, true);
    assert.equal(modelsRes.result.models[0]?.name, 'Fake 9.9.9');
    const usageRes = await worker.call({ jsonrpc: '2.0', id: 12, method: 'usage', params: {} });
    assert.equal(usageRes.result.windows[0].label, '9.9.9 · 5h');

    // agy-acp launches the custom binary with constant ACP_ARGS.
    const bridgeEnv = { ...env };
    delete bridgeEnv.FAKE_AGY_STATE;
    const bridge = startBridge(bridgeEnv);
    bridge.child.stdin.write(INITIALIZE);
    await waitFor(() => bridge.stdout.bytes().length >= EXPECTED_RESPONSE.length, 8_000, 'custom agy initialize');
    bridge.child.stdin.end();
    const { code } = await bridge.closed;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), EXPECTED_ACP_ARGS);
    const customCalls = fs.readFileSync(callsFile, 'utf8').trim().split(/\r?\n/);
    assert.ok(customCalls.length >= 6, `expected detect/account/login/listModels/usage/agy-acp calls, got ${customCalls.length}`);

    // If the configured custom binary is removed, never fall back to PATH and refuse standard install.
    fs.rmSync(customBin);
    const missingDetect = await worker.call({ jsonrpc: '2.0', id: 13, method: 'detect', params: { locale: 'en' } });
    assert.equal(missingDetect.result.available, false);
    assert.equal(missingDetect.result.reason, 'custom-path-unavailable');
    assert.equal(missingDetect.result.customPathConfigured, true);
    assert.equal(missingDetect.result.path, undefined);
    assert.ok(samePath(missingDetect.result.customPath, customBin));
    assert.doesNotMatch(missingDetect.result.message, /antigravity\.google/i);
    const blockedInstall = await worker.call({ jsonrpc: '2.0', id: 14, method: 'cliMaintenance', params: { action: 'install' } });
    assert.deepEqual(blockedInstall.result, { error: 'custom-path' });
    const brokenBridge = startBridge(bridgeEnv);
    const brokenClosed = await brokenBridge.closed;
    assert.equal(brokenClosed.code, 127);
    assert.match(brokenBridge.stderr.text(), /configured Antigravity CLI path/);

    // A corrupt config.json also refuses PATH fallback and blocks standard install.
    const { configFilePath } = await import(pathToFileURL(path.join(root, 'resolve-agy.js')).href);
    const cfgFile = configFilePath({ env });
    fs.writeFileSync(cfgFile, '{"customPath":', 'utf8');
    const corruptDetect = await worker.call({ jsonrpc: '2.0', id: 15, method: 'detect', params: { locale: 'en' } });
    assert.equal(corruptDetect.result.available, false);
    assert.equal(corruptDetect.result.reason, 'custom-path-unavailable');
    assert.equal(corruptDetect.result.customPathConfigured, true);
    assert.equal(corruptDetect.result.path, undefined);
    const blockedCorruptInstall = await worker.call({ jsonrpc: '2.0', id: 16, method: 'cliMaintenance', params: { action: 'install' } });
    assert.deepEqual(blockedCorruptInstall.result, { error: 'custom-path' });

    // Clearing the custom path restores PATH auto-discovery.
    const cleared = await worker.call({ jsonrpc: '2.0', id: 17, method: 'setCustomPath', params: { path: '', locale: 'en' } });
    assert.equal(cleared.result.ok, true);
    assert.equal(cleared.result.customPath, null);
    assert.equal(cleared.result.detection.available, true);
    assert.equal(cleared.result.detection.version, '0.2.2');
    assert.equal(cleared.result.detection.customPath, undefined);
    assert.ok(samePath(cleared.result.detection.path, fixture.agyPath));
    await worker.close();
  });

  test('validateCustomPath and configFilePath enforce Windows drive/UNC, cmd safety, LOCALAPPDATA, and POSIX permissions', async (t) => {
    const { configFilePath, validateCustomPath } = await import(pathToFileURL(path.join(root, 'resolve-agy.js')).href);
    assert.deepEqual(validateCustomPath('\\bin\\agy.cmd', { platform: 'win32', env: {} }), { ok: false, error: 'not-absolute' });
    assert.deepEqual(validateCustomPath('C:bin\\agy.cmd', { platform: 'win32', env: {} }), { ok: false, error: 'not-absolute' });
    assert.deepEqual(validateCustomPath('C:\\bad%path\\agy.cmd', { platform: 'win32', env: {} }), { ok: false, error: 'unsafe-path' });
    assert.deepEqual(validateCustomPath('relative/agy', { platform: 'darwin', env: { HOME: '/tmp' } }), { ok: false, error: 'not-absolute' });
    assert.equal(
      configFilePath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }),
      'C:\\Users\\a\\AppData\\Local\\cindy-agy-acp\\config.json',
    );
    if (!isWin) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-perm-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const plain = path.join(dir, 'agy');
      fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
      assert.deepEqual(validateCustomPath(plain, { platform: process.platform, env: {} }), { ok: false, error: 'not-executable' });
    }
  });

  test('main.js discards stale detect/listModels from the old binary, refreshes usage, and never leaks paths', async () => {
    class Channel {
      static all = [];
      constructor(name) { this.name = name; this.onmessage = null; Channel.all.push(this); }
      postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of Channel.all) {
          if (other !== this && other.name === this.name && other.onmessage) setTimeout(() => other.onmessage({ data: copy }), 0);
        }
      }
    }
    const puts = [];
    const nodeCalls = [];
    let resolveListA;
    let resolveDetectA;
    let listCount = 0;
    let detectCount = 0;
    const context = vm.createContext({
      BroadcastChannel: Channel, setTimeout, clearTimeout,
      cindy: {
        request: async () => ({ ok: true, context: { locale: 'en', uiLocale: 'en' } }),
        node: {
          request: async (request) => {
            nodeCalls.push(JSON.parse(JSON.stringify(request)));
            if (request.method === 'detect') {
              detectCount += 1;
              if (detectCount === 1) {
                return { ok: true, result: { available: true, path: '/bin/agy-a', version: '1.0.0' } };
              }
              return new Promise((resolve) => { resolveDetectA = resolve; });
            }
            if (request.method === 'listModels') {
              listCount += 1;
              if (listCount === 1) return new Promise((resolve) => { resolveListA = resolve; });
              return { ok: true, result: { supported: true, models: [{ id: 'model-b', name: 'Model B' }], sessionId: 'sess-b' } };
            }
            if (request.method === 'setCustomPath') {
              if (request.params.path === '/missing/agy') {
                return { ok: true, result: { ok: true, customPath: '/missing/agy', detection: {
                  available: false, reason: 'custom-path-unavailable', customPath: '/missing/agy', customPathConfigured: true,
                  message: 'The configured Antigravity CLI path is unavailable. Open the Antigravity plugin settings to update it or switch back to auto-detect.',
                  messages: { en: 'The configured Antigravity CLI path is unavailable. Open the Antigravity plugin settings to update it or switch back to auto-detect.' },
                } } };
              }
              return { ok: true, result: { ok: true, customPath: '/opt/agy-b', detection: {
                available: true, path: '/opt/agy-b', customPath: '/opt/agy-b', customPathConfigured: true, version: '2.0.0',
              } } };
            }
            if (request.method === 'usage') {
              return { ok: true, result: { updatedAt: 1, windows: [{ label: 'B · 5h', remainingPercent: 80 }] } };
            }
            return { ok: false };
          },
        },
        onHostMessage: () => () => {},
      },
      fetch: async (url, init) => {
        if (url === '/kv' && !init) return { ok: true, json: async () => ({}) };
        if (url === '/harnesses') puts.push(JSON.parse(init.body).harnesses[0]);
        return { ok: true, status: 204 };
      },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
    await waitFor(() => listCount === 1, 3_000, 'initial listModels for A in flight');

    const page = new Channel('agy-acp');
    const received = [];
    page.onmessage = (event) => received.push(event.data);

    // Start a slow detect on A, then switch to B before either detect or listModels(A) settles.
    page.postMessage({ type: 'detect-request', reqId: 'd-stale' });
    await waitFor(() => typeof resolveDetectA === 'function', 3_000, 'slow detect A in flight');
    page.postMessage({ type: 'custom-path-request', reqId: 'p1', path: '/opt/agy-b' });
    await waitFor(() => received.some((m) => m.type === 'custom-path-result' && m.reqId === 'p1'), 3_000, 'custom-path-result B');
    await waitFor(() => listCount === 2, 3_000, 'fresh listModels for B');

    // Now release the stale detect(A) and listModels(A); neither may overwrite B.
    resolveDetectA({ ok: true, result: { available: true, path: '/bin/agy-a', version: '1.0.0' } });
    resolveListA({ ok: true, result: { supported: true, models: [{ id: 'model-a', name: 'Model A' }], sessionId: 'sess-a' } });
    await waitFor(() => puts.some((entry) => entry.version === '2.0.0' && entry.models?.[0]?.id === 'model-b'), 3_000, 'published B models');
    await waitFor(() => received.some((m) => m.type === 'harness-usage' && m.usage?.windows?.[0]?.label === 'B · 5h'), 3_000, 'refreshed usage for B');

    const latest = puts.at(-1);
    assert.equal(latest.version, '2.0.0');
    assert.deepEqual(latest.models, [{ id: 'model-b', name: 'Model B' }]);
    assert.equal(latest.path, undefined);
    assert.equal(latest.customPath, undefined);
    assert.ok(!puts.some((entry) => entry.version === '2.0.0' && entry.models?.[0]?.id === 'model-a'), 'never pairs B version with A models');

    // Unavailable custom path publishes a path-free settings message, never an antigravity.google install prompt.
    page.postMessage({ type: 'custom-path-request', reqId: 'p2', path: '/missing/agy' });
    await waitFor(() => received.some((m) => m.type === 'custom-path-result' && m.reqId === 'p2'), 3_000, 'unavailable custom path');
    const unavailablePut = puts.at(-1);
    assert.equal(unavailablePut.available, false);
    assert.match(unavailablePut.message, /plugin settings/i);
    assert.doesNotMatch(unavailablePut.message, /\/missing\/agy|antigravity\.google/i);
  });

  test('settings.js + cli-settings.js disable unchanged save, re-translate notes, hide install for unavailable custom path, and reset', async () => {
    class Channel {
      static all = [];
      constructor(name) { this.name = name; this.onmessage = null; this.listeners = []; Channel.all.push(this); }
      addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
      postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of Channel.all) {
          if (other === this || other.name !== this.name) continue;
          setTimeout(() => {
            other.onmessage?.({ data: copy });
            for (const listener of other.listeners) listener({ data: copy });
          }, 0);
        }
      }
    }
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) {
        const listeners = {};
        elements.set(id, { id, value: '', placeholder: '', textContent: '', hidden: false, disabled: false, attributes: {}, dataset: {}, listeners,
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(type, listener) { listeners[type] = listener; },
          focus() {},
          click() { listeners.click(); } });
      }
      return elements.get(id);
    };
    let currentLocale = 'en';
    const context = vm.createContext({
      BroadcastChannel: Channel, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval,
      document: { getElementById: element, documentElement: {}, visibilityState: 'visible', addEventListener() {} },
      fetch: async (url) => ({ ok: true, json: async () => (url === '/app-context' ? { context: { uiLocale: currentLocale } } : { state: 'on' }) }),
    });
    const main = new Channel('agy-acp');
    const savedPaths = [];
    const cliActions = [];
    const account = { signedIn: true, canSignIn: true, canSignOut: true, busy: null };
    main.onmessage = ({ data }) => {
      if (data.type === 'detect-request') {
        main.postMessage({ type: 'detect-ack', reqId: data.reqId });
        main.postMessage({ type: 'detect-result', reqId: data.reqId, snapshot: { ok: true, account,
          result: { available: true, version: '1.5.9', path: '/usr/local/bin/agy' }, signInRequired: false, publish: { status: 'published' }, checkedAt: 1 } });
      }
      if (data.type === 'cli-state-request') main.postMessage({ type: 'cli-state' });
      if (data.type === 'cli-maintenance') {
        cliActions.push(data.action);
        main.postMessage({ type: 'cli-state', reqId: data.reqId, action: data.action, active: false, result: { state: 'current', version: '1.5.9' } });
      }
      if (data.type === 'account-request') {
        main.postMessage({ type: 'account-ack', reqId: data.reqId });
        main.postMessage({ type: 'account-result', reqId: data.reqId, op: data.op, account });
      }
      if (data.type === 'custom-path-request') {
        savedPaths.push(data.path);
        main.postMessage({ type: 'custom-path-ack', reqId: data.reqId });
        if (data.path === 'bad') {
          main.postMessage({ type: 'custom-path-result', reqId: data.reqId, ok: false, error: 'not-absolute' });
        } else if (data.path === '/gone/agy') {
          main.postMessage({ type: 'custom-path-result', reqId: data.reqId, ok: true, snapshot: { ok: true, account,
            result: { available: false, reason: 'custom-path-unavailable', customPath: '/gone/agy', customPathConfigured: true },
            signInRequired: false, publish: { status: 'published' }, checkedAt: 2 } });
        } else {
          const customPath = data.path || undefined;
          main.postMessage({ type: 'custom-path-result', reqId: data.reqId, ok: true, snapshot: { ok: true, account,
            result: { available: true, version: customPath ? '9.9.9' : '1.5.9', path: customPath || '/usr/local/bin/agy', ...(customPath ? { customPath, customPathConfigured: true } : {}) },
            signInRequired: false, publish: { status: 'published' }, checkedAt: 3 } });
        }
      }
    };
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(root, 'cli-settings.js'), 'utf8'), context, { filename: 'cli-settings.js' });
    vm.runInContext(fs.readFileSync(path.join(root, 'settings.js'), 'utf8'), context, { filename: 'settings.js' });

    await waitFor(() => element('version').textContent === '1.5.9', 3_000, 'initial detect');
    assert.equal(element('custom-path-reset').hidden, true);
    assert.equal(element('custom-path-save').disabled, true, 'Save is disabled when unchanged');

    // IME Enter must not submit; typing enables Save and invalid path surfaces inline error that re-translates on locale change.
    element('custom-path-input').value = 'bad';
    element('custom-path-input').listeners.input();
    assert.equal(element('custom-path-save').disabled, false);
    element('custom-path-input').listeners.keydown({ key: 'Enter', isComposing: true });
    assert.deepEqual(savedPaths, []);
    element('custom-path-save').click();
    await waitFor(() => element('custom-path-note').textContent.includes('absolute path'), 3_000, 'validation error');
    assert.equal(element('custom-path-note').attributes['data-tone'], 'error');
    currentLocale = 'zh-CN';
    main.postMessage({ type: 'locale-changed' });
    await waitFor(() => element('custom-path-note').textContent.includes('绝对路径'), 3_000, 'note re-translated to zh-CN');
    currentLocale = 'en';
    main.postMessage({ type: 'locale-changed' });
    await waitFor(() => element('custom-path-note').textContent.includes('absolute path'), 3_000, 'note re-translated back to en');

    // Valid path updates version, triggers a fresh CLI update check, and shows Reset button.
    element('custom-path-input').value = '/opt/custom/agy';
    element('custom-path-input').listeners.input();
    element('custom-path-save').click();
    await waitFor(() => element('version').textContent === '9.9.9', 3_000, 'saved custom path');
    await waitFor(() => cliActions.filter((a) => a === 'check').length >= 1, 3_000, 'CLI update check re-ran after path change');
    assert.equal(element('custom-path-reset').hidden, false);
    assert.equal(element('custom-path-save').disabled, true);

    // Unavailable custom path hides "Install from official source" and shows Path unavailable badge.
    element('custom-path-input').value = '/gone/agy';
    element('custom-path-input').listeners.input();
    element('custom-path-save').click();
    await waitFor(() => element('badge').textContent === 'Path unavailable', 3_000, 'unavailable badge');
    assert.equal(element('cli-action').hidden, true, 'Install button is hidden when custom path is unavailable');
    assert.equal(element('custom-path-reset').hidden, false);

    // Reset sends empty path and restores auto-detection.
    element('custom-path-reset').click();
    await waitFor(() => element('version').textContent === '1.5.9', 3_000, 'reset to auto-detect');
    assert.equal(element('custom-path-reset').hidden, true);
    assert.deepEqual(savedPaths, ['bad', '/opt/custom/agy', '/gone/agy', '']);

    // After installing A, selecting an older B clears "Installed" and triggers a fresh update check;
    // active install/update locks the custom path controls.
    const checksBefore = cliActions.filter((a) => a === 'check').length;
    main.postMessage({ type: 'cli-state', reqId: 'inst-1', action: 'update', active: true });
    await waitFor(() => element('custom-path-input').disabled === true, 3_000, 'path locked during update');
    assert.equal(element('custom-path-save').disabled, true);
    assert.equal(element('custom-path-reset').disabled, true);
    main.postMessage({ type: 'cli-state', reqId: 'inst-1', action: 'update', active: false, result: { state: 'installed', version: '2.0.0' } });
    await waitFor(() => element('cli-status').textContent === 'Installed 2.0.0', 3_000, 'installed status shown');
    assert.equal(element('custom-path-input').disabled, false);

    element('custom-path-input').value = '/opt/older/agy';
    element('custom-path-input').listeners.input();
    element('custom-path-save').click();
    await waitFor(() => cliActions.filter((a) => a === 'check').length > checksBefore, 3_000, 'fresh check triggered after switching from installed binary');
    assert.notEqual(element('cli-status').textContent, 'Installed 2.0.0');
  });

  test('worker.js serializes overlapping setCustomPath calls and cancels active login on path switch', async (t) => {
    const stateFile = path.join(os.tmpdir(), `agy-serial-state-${process.pid}-${Date.now()}`);
    t.after(() => {
      fs.rmSync(stateFile, { force: true });
      fs.rmSync(stateFile + '.log', { force: true });
    });
    const fixture = makeFixture(t, { extraEnv: { FAKE_AGY_STATE: stateFile, FAKE_AGY_LOGIN: 'hang' } });
    const dir = path.join(fixture.dir, 'bins');
    fs.mkdirSync(dir);
    const script = path.join(dir, 'fake.js');
    fs.writeFileSync(script, FAKE_AGY_SOURCE, 'utf8');
    let binA;
    let binB;
    if (isWin) {
      binA = path.join(dir, 'agy-a.cmd');
      fs.writeFileSync(binA, `@set FAKE_AGY_VERSION=1.1.1\r\n@"${process.execPath}" -e "setTimeout(()=>{}, 150)"\r\n@"${process.execPath}" "${script}" %*\r\n`);
      binB = path.join(dir, 'agy-b.cmd');
      fs.writeFileSync(binB, `@set FAKE_AGY_VERSION=2.2.2\r\n@set FAKE_AGY_LOGIN=\r\n@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      binA = path.join(dir, 'agy-a');
      fs.writeFileSync(binA, `#!/bin/sh\nsleep 0.15\nFAKE_AGY_VERSION=1.1.1 exec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(binA, 0o755);
      binB = path.join(dir, 'agy-b');
      fs.writeFileSync(binB, `#!/bin/sh\nFAKE_AGY_VERSION=2.2.2 FAKE_AGY_LOGIN= exec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(binB, 0o755);
    }

    const worker = startWorker(fixture.env);
    t.after(() => worker.close());

    // Start a hanging login on the default binary, then fire overlapping saves A (slow) and B (fast).
    const loginPending = worker.call({ jsonrpc: '2.0', id: 1, method: 'login', params: {} });
    await waitFor(() => fs.existsSync(stateFile + '.log') && fs.readFileSync(stateFile + '.log', 'utf8').includes('authenticate:oauth-personal'), 5_000, 'login started');

    const saveA = worker.call({ jsonrpc: '2.0', id: 2, method: 'setCustomPath', params: { path: binA, locale: 'en' } });
    const saveB = worker.call({ jsonrpc: '2.0', id: 3, method: 'setCustomPath', params: { path: binB, locale: 'en' } });
    const [loginResult, resA, resB] = await Promise.all([loginPending, saveA, saveB]);
    assert.deepEqual(loginResult.result, { ok: false, error: 'cancelled' });
    assert.equal(resA.result.ok, true);
    assert.equal(resA.result.detection.version, '1.1.1');
    assert.equal(resB.result.ok, true);
    assert.equal(resB.result.detection.version, '2.2.2');

    const finalDetect = await worker.call({ jsonrpc: '2.0', id: 4, method: 'detect', params: { locale: 'en' } });
    assert.equal(finalDetect.result.version, '2.2.2');
    assert.ok(samePath(finalDetect.result.customPath, binB));

    // A new login on B must succeed right away (never stuck as 'busy').
    const loginB = await worker.call({ jsonrpc: '2.0', id: 5, method: 'login', params: {} });
    assert.equal(loginB.result.ok, true);
  });

  test('main.js serializes saves, drops stale login after path switch, and blocks path changes during update', async () => {
    class Channel {
      static all = [];
      constructor(name) { this.name = name; this.onmessage = null; Channel.all.push(this); }
      postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of Channel.all) {
          if (other !== this && other.name === this.name && other.onmessage) setTimeout(() => other.onmessage({ data: copy }), 0);
        }
      }
    }
    const puts = [];
    const cancels = [];
    let resolveLoginA;
    let resolveSaveA;
    let resolveUpdate;
    let loginCalls = 0;
    const context = vm.createContext({
      BroadcastChannel: Channel, setTimeout, clearTimeout,
      cindy: {
        request: async () => ({ ok: true, context: { locale: 'en', uiLocale: 'en' } }),
        node: {
          request: async (request) => {
            if (request.method === 'detect') return { ok: true, result: { available: true, path: '/bin/agy', version: '1.0.0' } };
            if (request.method === 'listModels') return { ok: true, result: { supported: true, models: [{ id: 'm', name: 'M' }] } };
            if (request.method === 'usage') return { ok: true, result: null };
            if (request.method === 'login') {
              loginCalls += 1;
              if (loginCalls === 1) return new Promise((resolve) => { resolveLoginA = resolve; });
              return { ok: true, result: { ok: true, tier: { name: 'New Tier' } } };
            }
            if (request.method === 'cancelLogin') {
              cancels.push(true);
              return { ok: true, result: { ok: true, cancelled: true } };
            }
            if (request.method === 'setCustomPath') {
              if (request.params.path === '/opt/agy-a') {
                return new Promise((resolve) => {
                  resolveSaveA = () => resolve({ ok: true, result: { ok: true, customPath: '/opt/agy-a',
                    detection: { available: true, path: '/opt/agy-a', customPath: '/opt/agy-a', customPathConfigured: true, version: '1.5.0' } } });
                });
              }
              return { ok: true, result: { ok: true, customPath: '/opt/agy-b',
                detection: { available: true, path: '/opt/agy-b', customPath: '/opt/agy-b', customPathConfigured: true, version: '2.0.0' } } };
            }
            if (request.method === 'cliMaintenance' && request.params.action === 'update') {
              return new Promise((resolve) => {
                resolveUpdate = () => resolve({ ok: true, result: { state: 'installed', version: '2.1.0' } });
              });
            }
            return { ok: false };
          },
        },
        onHostMessage: () => () => {},
      },
      fetch: async (url, init) => {
        if (url === '/kv' && !init) return { ok: true, json: async () => ({}) };
        if (url === '/harnesses') puts.push(JSON.parse(init.body).harnesses[0]);
        return { ok: true, status: 204 };
      },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
    await waitFor(() => puts.length > 0, 3_000, 'initial publish');

    const page = new Channel('agy-acp');
    const received = [];
    page.onmessage = (event) => received.push(event.data);

    // Start login on initial binary, then fire overlapping saves A (slow) and B (fast).
    page.postMessage({ type: 'account-request', reqId: 'login-a', op: 'login' });
    await waitFor(() => typeof resolveLoginA === 'function', 3_000, 'login A started');

    page.postMessage({ type: 'custom-path-request', reqId: 'save-a', path: '/opt/agy-a' });
    page.postMessage({ type: 'custom-path-request', reqId: 'save-b', path: '/opt/agy-b' });
    await waitFor(() => typeof resolveSaveA === 'function', 3_000, 'save A started');
    resolveSaveA();
    await waitFor(() => received.some((m) => m.type === 'custom-path-result' && m.reqId === 'save-b'), 3_000, 'save B finished after A');

    // Final published version must be B (2.0.0), and old login must have been cancelled.
    assert.equal(puts.at(-1).version, '2.0.0');
    assert.ok(cancels.length >= 1, 'cancelLogin was called on path switch');

    // Late resolution of A's login must not taint B or block a new login on B.
    resolveLoginA({ ok: true, result: { ok: true, tier: { name: 'Old Tier' } } });
    await waitFor(() => received.some((m) => m.type === 'account-result' && m.reqId === 'login-a'), 3_000, 'stale login settled');
    assert.equal(received.find((m) => m.type === 'account-result' && m.reqId === 'login-a').error, 'cancelled');

    page.postMessage({ type: 'account-request', reqId: 'login-b', op: 'login' });
    await waitFor(() => received.some((m) => m.type === 'account-result' && m.reqId === 'login-b'), 3_000, 'login B succeeded');
    const loginBResult = received.find((m) => m.type === 'account-result' && m.reqId === 'login-b');
    assert.equal(loginBResult.error, undefined);
    assert.equal(loginBResult.account.tier, 'New Tier');

    // Path changes are rejected with 'busy' while a CLI update is active.
    page.postMessage({ type: 'cli-maintenance', reqId: 'upd-1', action: 'update', version: '2.1.0' });
    await waitFor(() => typeof resolveUpdate === 'function', 3_000, 'update active');
    page.postMessage({ type: 'custom-path-request', reqId: 'save-during-upd', path: '/opt/agy-b' });
    await waitFor(() => received.some((m) => m.type === 'custom-path-result' && m.reqId === 'save-during-upd'), 3_000, 'blocked during update');
    assert.equal(received.find((m) => m.type === 'custom-path-result' && m.reqId === 'save-during-upd').error, 'busy');
    resolveUpdate();
  });
});

test('native /usage preserves exhausted groups and ignores model turns and disabled buckets', async () => {
  const { usageFromReport } = await import('../agy-usage.js');
  const command = { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
    { window: 'weekly', remaining_fraction: 0, reset_time: '2030-01-01T00:00:00Z' },
    { window: '5h', remaining_fraction: 0.5, disabled: true },
    { window: 'unreported', remaining_fraction: null },
  ] }, { name: 'Claude/GPT', buckets: [{ window: '5h', remaining_fraction: 1 }] }] } };
  const usage = usageFromReport({ status: 'SUCCESS', num_turns: 0, command });
  assert.deepEqual(usage.windows, [
    { label: 'Gemini · weekly', remainingPercent: 0, resetsAt: Date.UTC(2030, 0, 1) },
    { label: 'Claude/GPT · 5h', remainingPercent: 100 },
  ]);
  assert.equal(usageFromReport({ status: 'SUCCESS', num_turns: 1, command }), null);
});
