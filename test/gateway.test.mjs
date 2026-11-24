// Run: node --test
//
// The MCP gateway relay (agy-mcp-relay.js) and its approval binding in agy-steering.js, against a
// fake HTTP MCP server. Nothing here reaches a real service.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';

const require = createRequire(import.meta.url);
const { createMcpRelay, compactDescription } = require('../agy-mcp-relay.js');
const { attachSteering } = require('../agy-steering.js');

const LONG = '调用浏览器工具:call_tool({name:"browser"})。常规读页面直接调用。\n' + '【读】'.repeat(300);
const GITHUB_TOOLS = [
  { name: 'add_issue_comment', description: 'Add a comment to an issue. Use with PRs too.', inputSchema: { type: 'object', required: ['owner'] } },
  { name: 'search_repositories', description: 'Find repositories. Perfect for discovery.', inputSchema: { type: 'object' } },
  { name: 'get_me', description: 'Get the user.', inputSchema: { type: 'object' } },
];
const BROWSER_TOOLS = [
  { name: 'list_tools', description: '探索浏览器工具(入口)。传 category 返回规则。', inputSchema: { type: 'object' } },
  { name: 'call_tool', description: LONG, inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
];

/** Fake Streamable HTTP MCP server. `state` controls its answers and records what it received. */
async function fakeServer(t, state = {}) {
  state.calls = [];
  state.requests = [];
  state.streams = [];
  state.streamOf = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        state.streams.push(res);
        state.streamOf.set(req.headers['mcp-session-id'], res);
        return;
      }
      if (req.method === 'DELETE') return res.writeHead(200).end();
      const message = JSON.parse(body);
      if (message.id === undefined) return res.writeHead(202).end();
      let result;
      if (message.method === 'tools/list') {
        const tools = state.tools ?? GITHUB_TOOLS;
        result = state.nextCursor ? { tools, nextCursor: 'page-2' } : { tools };
      } else if (message.method === 'tools/call') {
        state.calls.push({ name: message.params.name, arguments: message.params.arguments, headers: req.headers });
        result = { content: [{ type: 'text', text: state.callText ?? `ran ${message.params.name}` }] };
      } else {
        result = {};
      }
      const response = { jsonrpc: '2.0', id: message.id, result };
      const reply = JSON.stringify(message.method === 'tools/call' && state.callNotification
        ? [response, state.callNotification] : response);
      if (state.multiline) {
        // One message over several data lines, as SSE allows; `multiline` is the line ending.
        const eol = state.multiline;
        const lines = JSON.stringify(JSON.parse(reply), null, 1).split('\n');
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(`event: message${eol}id: e1${eol}${lines.map((line) => 'data: ' + line).join(eol)}${eol}${eol}`);
      } else if (state.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'S1' });
        res.end(`event: message\ndata: ${reply}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'S1' });
        res.end(reply);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const stream of state.streams) stream.end();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, state };
}

/** What agy does: JSON-RPC over HTTP to the URL it was given, with the headers Cindy gave it. */
function mcp(url, message, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'S1',
        authorization: 'Bearer custom_github', ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // SSE: the data lines of the first event, joined as the spec says.
        const sse = /^text\/event-stream/.test(res.headers['content-type'] ?? '')
          && data.split(/\r\n\r\n|\n\n/).map((event) => event.split(/\r\n|\n/).filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, '')).join('\n')).find(Boolean);
        resolve({ status: res.statusCode, headers: res.headers, message: data ? JSON.parse(sse || data) : null });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const listTools = (url) => mcp(url, { id: 'l', method: 'tools/list', params: {} });
/** agy names the ACP session in _meta of each call; `session` null leaves it out. */
const callTool = (url, name, args, id = 'c', session = 'one') => mcp(url, { id, method: 'tools/call', params: {
  name, arguments: args, ...(session ? { _meta: { 'antigravity.google/conversation_id': session } } : {}),
} });
const text = (reply) => reply.message.result.content[0].text;

async function relayFor(t, servers) {
  const relay = createMcpRelay({ log: () => {} });
  t.after(() => relay.close());
  assert.equal(await relay.ready, true);
  return { relay, ...relay.rewriteServers(servers) };
}
const httpServer = (name, url) => ({ type: 'http', name, url, headers: [{ name: 'Authorization', value: `Bearer ${name}` }] });

describe('MCP gateway relay', () => {
  test('shortens the eight listed descriptions and nothing else', async (t) => {
    const browser = await fakeServer(t, { tools: BROWSER_TOOLS });
    const github = await fakeServer(t, { nextCursor: true }); // paged: no gateway, shortened instead
    const { servers, targets } = await relayFor(t, [httpServer('cindy_browser', browser.url), httpServer('custom_github', github.url)]);
    const tools = (await listTools(servers[0].url)).message.result.tools;
    assert.equal(tools[0].description, '探索浏览器工具(入口)。');
    assert.equal(tools[1].description, '调用浏览器工具:call_tool({name:"browser"})。（完整用法见 list_tools）');
    assert.deepEqual(tools[1].inputSchema, BROWSER_TOOLS[1].inputSchema);
    const gh = (await listTools(servers[1].url)).message;
    assert.equal(gh.result.nextCursor, 'page-2');
    assert.deepEqual(gh.result.tools.map((tool) => tool.description),
      ['Add a comment to an issue.', 'Find repositories.', 'Get the user.']);
    assert.equal(compactDescription('Short.'), 'Short.');
    assert.ok(targets.cindy_browser && targets.custom_github);
  });

  test('leaves other servers, stdio servers and bad URLs as they were', async (t) => {
    const others = [httpServer('cindy_helper', 'http://127.0.0.1:1/x'), { name: 'cindy', command: 'x', args: [], env: [] },
      { type: 'http', name: 'cindy_orca', url: 'not a url', headers: [] }, { type: 'sse', name: 'custom_github', url: 'http://127.0.0.1:1/' }];
    const { servers, targets } = await relayFor(t, others);
    servers.forEach((entry, index) => assert.equal(entry, others[index]));
    assert.deepEqual(targets, {});
  });

  test('shows a large server as list_tools/call_tool and answers list_tools from its own list', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const listed = (await listTools(servers[0].url)).message.result.tools;
    assert.deepEqual(listed.map((tool) => tool.name), ['list_tools', 'call_tool']);
    assert.equal(relay.facadeState(targets.custom_github), 'on');
    const index = JSON.parse(text(await callTool(servers[0].url, 'list_tools', {})));
    assert.deepEqual(index, [
      { name: 'add_issue_comment', summary: 'Add a comment to an issue.' },
      { name: 'search_repositories', summary: 'Find repositories.' },
      { name: 'get_me', summary: 'Get the user.' },
    ]);
    // The full definition keeps the server's own description: no shortening behind the gateway.
    assert.deepEqual(JSON.parse(text(await callTool(servers[0].url, 'list_tools', { name: 'add_issue_comment' }))), GITHUB_TOOLS[0]);
    assert.equal((await callTool(servers[0].url, 'list_tools', { name: 'nope' })).message.result.isError, true);
    assert.equal(github.state.calls.length, 0);
  });

  test('runs a call only with a matching single-use approval and forwards it unchanged', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    await listTools(url);
    const args = { owner: 'o', repo: 'r', issue_number: 1, body: 'mock only' };

    let reply = await callTool(url, 'call_tool', { name: 'add_issue_comment', args });
    assert.equal(reply.message.result.isError, true, 'no approval');
    relay.grant(targets.custom_github, 'add_issue_comment', { ...args, body: 'other' }, { sessionId: 'one', toolCallId: 't1' });
    reply = await callTool(url, 'call_tool', { name: 'add_issue_comment', args });
    assert.equal(reply.message.result.isError, true, 'changed arguments');
    relay.grant(targets.custom_github, 'search_repositories', args, { sessionId: 'one', toolCallId: 't2' });
    reply = await callTool(url, 'call_tool', { name: 'add_issue_comment', args });
    assert.equal(reply.message.result.isError, true, 'other tool approved');
    assert.equal(github.state.calls.length, 0);

    // Key order does not matter; the approval is used once.
    relay.grant(targets.custom_github, 'add_issue_comment', { body: 'mock only', issue_number: 1, repo: 'r', owner: 'o' }, { sessionId: 'one', toolCallId: 't3' });
    reply = await callTool(url, 'call_tool', { name: 'add_issue_comment', args }, 77);
    assert.equal(reply.message.id, 77);
    assert.equal(text(reply), 'ran add_issue_comment');
    assert.deepEqual(github.state.calls.map((call) => [call.name, call.arguments, call.headers.authorization]),
      [['add_issue_comment', args, 'Bearer custom_github']]);
    assert.equal((await callTool(url, 'call_tool', { name: 'add_issue_comment', args })).message.result.isError, true, 'used once');
    assert.equal(github.state.calls.length, 1);
  });

  test('refuses malformed calls, unknown tools and anything but its two tools', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    await listTools(url);
    relay.grant(targets.custom_github, 'nope', {}, { sessionId: 'one', toolCallId: 'x' });
    for (const input of [{ args: {} }, { name: 'get_me', args: 'x' }, { name: 'get_me', args: {}, extra: 1 }, { name: 'nope', args: {} }]) {
      assert.equal((await callTool(url, 'call_tool', input)).message.result.isError, true, JSON.stringify(input));
    }
    assert.equal((await callTool(url, 'get_me', {})).message.result.isError, true);
    assert.equal(github.state.calls.length, 0);
  });

  test('concurrent identical calls run once per approval', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    await listTools(servers[0].url);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'a' });
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'b' });
    const replies = await Promise.all([1, 2, 3].map((id) => callTool(servers[0].url, 'call_tool', { name: 'get_me' }, id)));
    assert.equal(replies.filter((reply) => !reply.message.result.isError).length, 2);
    assert.equal(github.state.calls.length, 2);
  });

  test('an approval is used only by a call of the session it was given in', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    await listTools(servers[0].url);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'a' });
    assert.equal((await callTool(servers[0].url, 'call_tool', { name: 'get_me' }, 1, 'two')).message.result.isError, true, 'other session');
    assert.equal((await callTool(servers[0].url, 'call_tool', { name: 'get_me' }, 1, null)).message.result.isError, true, 'no session');
    for (const meta of [{}, { 'antigravity.google/conversation_id': '' }, { 'antigravity.google/conversation_id': 7 }]) {
      const reply = await mcp(servers[0].url, { id: 3, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'get_me' }, _meta: meta } });
      assert.equal(reply.message.result.isError, true, JSON.stringify(meta));
    }
    assert.equal(github.state.calls.length, 0);
    // The approval is still there for its own session; a subagent call names its root session.
    const sub = await mcp(servers[0].url, { id: 2, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'get_me' },
      _meta: { 'antigravity.google/conversation_id': 'sub', 'antigravity.google/root_conversation_id': 'one' } } });
    assert.equal(text(sub), 'ran get_me');
    assert.equal(github.state.calls.length, 1);
  });

  test('a server keeps its relay URL when a session lists it again', async (t) => {
    const relay = createMcpRelay({ log: () => {} });
    t.after(() => relay.close());
    await relay.ready;
    const entry = httpServer('custom_github', 'http://127.0.0.1:1/gh');
    const first = relay.rewriteServers([entry]);
    const again = relay.rewriteServers([{ ...entry, headers: [{ name: 'Authorization', value: 'Bearer rotated' }] }]);
    assert.equal(again.servers[0].url, first.servers[0].url);
    assert.equal(again.targets.custom_github, first.targets.custom_github);
    assert.deepEqual(again.servers[0].headers, [{ name: 'Authorization', value: 'Bearer rotated' }]);
    assert.notEqual(relay.rewriteServers([{ ...entry, url: 'http://127.0.0.1:2/gh' }]).servers[0].url, first.servers[0].url);
  });

  test('revoked approvals no longer run', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    await listTools(servers[0].url);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'a' });
    relay.grant(targets.custom_github, 'search_repositories', {}, { sessionId: 'one', toolCallId: 'b' });
    relay.revoke('one', 'a');
    assert.equal((await callTool(servers[0].url, 'call_tool', { name: 'get_me' })).message.result.isError, true);
    relay.revoke('one');
    assert.equal((await callTool(servers[0].url, 'call_tool', { name: 'search_repositories' })).message.result.isError, true);
    assert.equal(github.state.calls.length, 0);
  });

  for (const sse of [false, true]) {
    test(`tool output mentioning list_changed does not invalidate the directory (${sse ? 'SSE' : 'JSON'})`, async (t) => {
      const callText = 'A tool result mentioning notifications/tools/list_changed.';
      const github = await fakeServer(t, { sse, callText });
      const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
      const url = servers[0].url;
      await listTools(url);
      for (const id of ['first', 'second']) {
        relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: id });
        assert.equal(text(await callTool(url, 'call_tool', { name: 'get_me' }, id)), callText);
      }
      assert.equal(github.state.calls.length, 2);
    });
  }

  test('a list_changed notification in a JSON batch invalidates the directory', async (t) => {
    const callNotification = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
    const github = await fakeServer(t, { callNotification });
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    await listTools(url);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'first' });
    const first = await callTool(url, 'call_tool', { name: 'get_me' }, 'first');
    assert.deepEqual(first.message, [
      { jsonrpc: '2.0', id: 'first', result: { content: [{ type: 'text', text: 'ran get_me' }] } },
      callNotification,
    ]);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'second' });
    assert.equal((await callTool(url, 'call_tool', { name: 'get_me' }, 'second')).message.result.isError, true);
    assert.equal(github.state.calls.length, 1);
  });

  test('only a complete list_changed notification invalidates an SSE directory', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    await listTools(url);
    // agy's event stream through the relay carries the server's notification.
    const stream = await new Promise((resolve) => http.get(url, { headers: { accept: 'text/event-stream', 'mcp-session-id': 'S1' } }, resolve));
    t.after(() => stream.destroy());
    stream.setEncoding('utf8');
    const emit = async (chunk) => {
      const received = await new Promise((resolve) => {
        let text = '';
        function onData(data) {
          text += data;
          if (!text.endsWith(chunk)) return;
          stream.off('data', onData);
          resolve(text);
        }
        stream.on('data', onData);
        github.state.streams[0].write(chunk);
      });
      assert.ok(received === chunk || received === ': open\n\n' + chunk, 'the stream reaches agy unchanged');
    };
    await emit('event: message\r\ndata: {"jsonrpc":"2.0","id":7,"method":"notifications/tools/list_changed"}\r\n\r\n');
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'ordinary' });
    assert.equal(text(await callTool(url, 'call_tool', { name: 'get_me' })), 'ran get_me', 'a request is not a notification');

    github.state.tools = [...GITHUB_TOOLS, { name: 'new_tool', description: 'New.', inputSchema: { type: 'object' } }];
    await emit('event: message\r\ndata: {"jsonrpc":"2.0",\r');
    await emit('\ndata: "method":"notifications/tools/list_');
    await emit('changed"}\r\n');
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'before-delimiter' });
    assert.equal(text(await callTool(url, 'call_tool', { name: 'get_me' })), 'ran get_me', 'the event is not complete');
    await emit('\r\n');
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'after-delimiter' });
    assert.equal((await callTool(url, 'call_tool', { name: 'get_me' })).message.result.isError, true, 'stale list');
    assert.equal(github.state.calls.length, 2);
    const index = JSON.parse(text(await callTool(url, 'list_tools', {})));
    assert.ok(index.some((tool) => tool.name === 'new_tool'));
    relay.grant(targets.custom_github, 'new_tool', {}, { sessionId: 'one', toolCallId: 'n' });
    assert.equal(text(await callTool(url, 'call_tool', { name: 'new_tool' })), 'ran new_tool');
  });

  test('another MCP session or a DELETE needs the list read again', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    await listTools(url);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'a' });
    const other = await mcp(url, { id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'get_me' } } }, { 'mcp-session-id': 'S2' });
    assert.equal(other.message.result.isError, true);
    await new Promise((resolve) => {
      http.request(url, { method: 'DELETE', headers: { 'mcp-session-id': 'S1' } }, (res) => { res.resume(); res.on('end', resolve); }).end();
    });
    assert.equal((await callTool(url, 'call_tool', { name: 'get_me' })).message.result.isError, true);
    assert.equal(github.state.calls.length, 0);
  });

  test('works the same with SSE answers', async (t) => {
    const github = await fakeServer(t, { sse: true });
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const listed = await listTools(servers[0].url);
    assert.deepEqual(listed.message.result.tools.map((tool) => tool.name), ['list_tools', 'call_tool']);
    relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: 'a' });
    const reply = await callTool(servers[0].url, 'call_tool', { name: 'get_me' });
    assert.match(reply.headers['content-type'], /event-stream/);
    assert.equal(text(reply), 'ran get_me');
  });

  test('each MCP session on one relay route keeps its own tool list', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    const call = (session, id) => mcp(url, { id, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'get_me' },
      _meta: { 'antigravity.google/conversation_id': 'one' } } }, { 'mcp-session-id': session });
    const approve = (id) => relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: id });
    await mcp(url, { id: 'l1', method: 'tools/list', params: {} }, { 'mcp-session-id': 'S1' });
    await mcp(url, { id: 'l2', method: 'tools/list', params: {} }, { 'mcp-session-id': 'S2' });
    approve('a');
    assert.equal(text(await call('S1', 'a')), 'ran get_me', 'S2 reading its list did not replace S1');
    approve('b');
    assert.equal(text(await call('S2', 'b')), 'ran get_me');
    approve('c');
    assert.equal((await call('S3', 'c')).message.result.isError, true, 'a session that never read the list');

    // A notification on S2's own stream invalidates only S2's list.
    const stream = await new Promise((resolve) => http.get(url, { headers: { accept: 'text/event-stream', 'mcp-session-id': 'S2' } }, resolve));
    t.after(() => stream.destroy());
    stream.resume();
    await waitUntil(() => github.state.streamOf.has('S2'));
    github.state.streamOf.get('S2').write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await call('S2', 'c')).message.result.isError, true, 'S2 list is stale');
    assert.equal(text(await call('S1', 'c')), 'ran get_me', 'S1 list still valid');

    // DELETE of S1 forgets only S1's list.
    await new Promise((resolve) => {
      http.request(url, { method: 'DELETE', headers: { 'mcp-session-id': 'S1' } }, (res) => { res.resume(); res.on('end', resolve); }).end();
    });
    await mcp(url, { id: 'l3', method: 'tools/list', params: {} }, { 'mcp-session-id': 'S2' });
    approve('d');
    assert.equal((await call('S1', 'd')).message.result.isError, true, 'S1 deleted');
    assert.equal(text(await call('S2', 'd')), 'ran get_me', 'S2 read again');
    assert.equal(github.state.calls.length, 4);
  });

  test('tool lists are kept for a bounded number of MCP sessions', async (t) => {
    const github = await fakeServer(t);
    const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
    const url = servers[0].url;
    for (let n = 0; n <= 16; n++) await mcp(url, { id: n, method: 'tools/list', params: {} }, { 'mcp-session-id': `S${n}` });
    const call = (session) => {
      relay.grant(targets.custom_github, 'get_me', {}, { sessionId: 'one', toolCallId: session });
      return mcp(url, { id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'get_me' },
        _meta: { 'antigravity.google/conversation_id': 'one' } } }, { 'mcp-session-id': session });
    };
    assert.equal((await call('S0')).message.result.isError, true, 'the oldest list was dropped');
    relay.revoke('one');
    assert.equal(text(await call('S16')), 'ran get_me');
  });

  for (const [ending, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    test(`a tool list sent over several SSE data lines (${ending}) goes through the gateway and is read again`, async (t) => {
      const github = await fakeServer(t, { multiline: eol });
      const { relay, servers, targets } = await relayFor(t, [httpServer('custom_github', github.url)]);
      const url = servers[0].url;
      const raw = await new Promise((resolve) => {
        const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': 'S1' } }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve(data));
        });
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} }));
      });
      // The rewritten message is on one data line; the event's other fields are kept.
      const lines = raw.split(/\r\n|\n/);
      assert.deepEqual(lines.slice(0, 2), ['event: message', 'id: e1']);
      assert.deepEqual(JSON.parse(lines[2].slice(6)).result.tools.map((tool) => tool.name), ['list_tools', 'call_tool']);
      assert.equal(relay.facadeState(targets.custom_github), 'on');

      // Invalidated by a notification, the list is read again (still over several data lines).
      const stream = await new Promise((resolve) => http.get(url, { headers: { accept: 'text/event-stream', 'mcp-session-id': 'S1' } }, resolve));
      t.after(() => stream.destroy());
      stream.resume();
      await waitUntil(() => github.state.streamOf.has('S1'));
      github.state.tools = [...GITHUB_TOOLS, { name: 'new_tool', description: 'New.', inputSchema: { type: 'object' } }];
      github.state.streamOf.get('S1').write(`data: {"jsonrpc":"2.0",${eol}data: "method":"notifications/tools/list_changed"}${eol}${eol}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      relay.grant(targets.custom_github, 'new_tool', {}, { sessionId: 'one', toolCallId: 'n' });
      assert.equal((await callTool(url, 'call_tool', { name: 'new_tool' })).message.result.isError, true, 'stale');
      const index = JSON.parse(text(await callTool(url, 'list_tools', {})));
      assert.ok(index.some((tool) => tool.name === 'new_tool'));
      assert.equal(text(await callTool(url, 'call_tool', { name: 'new_tool' })), 'ran new_tool');
    });
  }

  test('a server with a reserved or duplicate tool name keeps its tools', async (t) => {
    for (const tools of [[...GITHUB_TOOLS, { name: 'call_tool', inputSchema: {} }], [GITHUB_TOOLS[0], GITHUB_TOOLS[0]]]) {
      const cindy = await fakeServer(t, { tools });
      const { relay, servers, targets } = await relayFor(t, [httpServer('cindy', cindy.url)]);
      assert.deepEqual((await listTools(servers[0].url)).message.result.tools, tools);
      assert.equal(relay.facadeState(targets.cindy), 'off');
      await callTool(servers[0].url, 'call_tool', { name: 'x' });
      assert.equal(cindy.state.calls.length, 1, 'passed through to the server');
    }
  });
});

/** In-process ACP relay (as agy-acp.js wires it) with a fake agy on the other side. */
function acpHarness(t) {
  const source = new PassThrough();
  const output = new PassThrough();
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const toAgy = [];
  const toCindy = [];
  child.stdin.on('data', (data) => String(data).split('\n').filter(Boolean).forEach((line) => toAgy.push(JSON.parse(line))));
  output.on('data', (data) => String(data).split('\n').filter(Boolean).forEach((line) => toCindy.push(JSON.parse(line))));
  const { detach } = attachSteering(source, output, child, (error) => { throw error; });
  const write = (stream, message) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  t.after(() => {
    detach();
    source.end();
    child.stdout.end();
  });
  return {
    toAgy, toCindy,
    cindy: (message) => write(source, message),
    agy: (message) => write(child.stdout, message),
  };
}
async function waitUntil(check, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
];

async function gatewaySession(t, { method = 'session/new', sessionId = 'one' } = {}) {
  const github = await fakeServer(t);
  const h = acpHarness(t);
  h.cindy({ id: 0, method: 'initialize', params: { protocolVersion: 1 } });
  h.agy({ id: 0, result: { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.15' } } });
  const mcpServers = [httpServer('custom_github', github.url), httpServer('cindy_helper', 'http://127.0.0.1:1/helper')];
  h.cindy({ id: 1, method, params: { cwd: '/p', mcpServers, ...(method === 'session/new' ? {} : { sessionId }) } });
  await waitUntil(() => h.toAgy.some((m) => m.id === 1));
  const sent = h.toAgy.find((m) => m.id === 1).params.mcpServers;
  assert.notEqual(sent[0].url, github.url);
  assert.deepEqual(sent[1], mcpServers[1]);
  h.agy({ id: 1, result: method === 'session/new' ? { sessionId } : {} });
  await listTools(sent[0].url); // agy reads the tool list when it connects
  let nextId = 0;
  const ask = (rawInput, toolCallId = `tc${++nextId}`) => {
    const id = `perm-${toolCallId}`;
    h.agy({ id, method: 'session/request_permission', params: {
      sessionId, options: OPTIONS,
      toolCall: { toolCallId, name: 'mcp_custom_github_call_tool', title: 'Run', kind: 'other', rawInput: { ...rawInput, toolSummary: 'Comment' } },
    } });
    return { id, toolCallId };
  };
  const answer = (id, optionId) => h.cindy({ id, result: { outcome: { outcome: 'selected', optionId } } });
  return { ...h, github, url: sent[0].url, ask, answer, sessionId };
}

describe('gateway approvals in ACP', () => {
  const args = { owner: 'o', repo: 'r', issue_number: 1, body: 'mock only' };

  test('Cindy is asked about the real tool and arguments, without always-options, and its allow runs that call once', async (t) => {
    const s = await gatewaySession(t);
    const { id } = s.ask({ name: 'add_issue_comment', args });
    const asked = s.toCindy.find((m) => m.id === id);
    assert.equal(asked.params.toolCall.title, 'mcp__custom_github__add_issue_comment');
    assert.equal(asked.params.toolCall.name, 'mcp__custom_github__add_issue_comment');
    assert.deepEqual(asked.params.toolCall.rawInput, args);
    assert.deepEqual(asked.params.options.map((option) => option.kind), ['allow_once', 'reject_once']);
    s.answer(id, 'yes');
    await waitUntil(() => s.toAgy.some((m) => m.id === id));
    assert.deepEqual(s.toAgy.find((m) => m.id === id).result.outcome, { outcome: 'selected', optionId: 'yes' });
    assert.equal(text(await callTool(s.url, 'call_tool', { name: 'add_issue_comment', args })), 'ran add_issue_comment');
    assert.equal((await callTool(s.url, 'call_tool', { name: 'add_issue_comment', args })).message.result.isError, true);
    assert.equal(s.github.state.calls.length, 1);
  });

  test('a rejection, a changed argument or an option that was not offered never reaches the server', async (t) => {
    const s = await gatewaySession(t);
    const first = s.ask({ name: 'add_issue_comment', args });
    s.answer(first.id, 'no');
    const second = s.ask({ name: 'add_issue_comment', args });
    s.answer(second.id, 'always'); // not offered: refused on Cindy's behalf
    await waitUntil(() => s.toAgy.some((m) => m.id === second.id));
    assert.deepEqual(s.toAgy.find((m) => m.id === second.id).result.outcome, { outcome: 'selected', optionId: 'no' });
    const third = s.ask({ name: 'add_issue_comment', args });
    s.answer(third.id, 'yes');
    await waitUntil(() => s.toAgy.some((m) => m.id === third.id));
    assert.equal((await callTool(s.url, 'call_tool', { name: 'add_issue_comment', args: { ...args, body: 'changed' } })).message.result.isError, true);
    assert.equal((await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })).message.result.isError, true);
    assert.equal(s.github.state.calls.length, 0);
  });

  test('unused approvals lapse when the call ends, the turn ends or the session is cancelled', async (t) => {
    const s = await gatewaySession(t);
    const run = async (lapse) => {
      const { id, toolCallId } = s.ask({ name: 'get_me', args: {} });
      s.answer(id, 'yes');
      await waitUntil(() => s.toAgy.some((m) => m.id === id));
      lapse(toolCallId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return (await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })).message.result.isError;
    };
    assert.equal(await run((toolCallId) => s.agy({ method: 'session/update', params: {
      sessionId: s.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' } } })), true);
    assert.equal(await run(() => s.cindy({ method: 'session/cancel', params: { sessionId: s.sessionId } })), true);
    s.cindy({ id: 'p1', method: 'session/prompt', params: { sessionId: s.sessionId, prompt: [] } });
    assert.equal(await run(() => s.agy({ id: 'p1', result: { stopReason: 'end_turn' } })), true);
    assert.equal(s.github.state.calls.length, 0);
  });

  for (const [what, lapse] of [
    ['the session is cancelled', (s) => s.cindy({ method: 'session/cancel', params: { sessionId: s.sessionId } })],
    ['the turn ends', (s) => s.agy({ id: 'p1', result: { stopReason: 'end_turn' } })],
    ['the session is loaded again', (s) => s.cindy({ id: 5, method: 'session/load', params: { sessionId: s.sessionId, cwd: '/p', mcpServers: [] } })],
    ['the call has ended', (s, toolCallId) => s.agy({ method: 'session/update', params: {
      sessionId: s.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'cancelled' } } })],
  ]) {
    test(`an allow that arrives after ${what} is refused and grants nothing`, async (t) => {
      const s = await gatewaySession(t);
      s.cindy({ id: 'p1', method: 'session/prompt', params: { sessionId: s.sessionId, prompt: [] } });
      const { id, toolCallId } = s.ask({ name: 'get_me', args: {} });
      lapse(s, toolCallId);
      if (what === 'the session is loaded again') {
        await waitUntil(() => s.toAgy.some((m) => m.id === 5));
        s.agy({ id: 5, result: {} });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      s.answer(id, 'yes');
      await waitUntil(() => s.toAgy.some((m) => m.id === id));
      assert.deepEqual(s.toAgy.find((m) => m.id === id).result.outcome, { outcome: 'selected', optionId: 'no' });
      assert.equal((await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })).message.result.isError, true);
      assert.equal(s.github.state.calls.length, 0);
    });
  }

  test('an allow answered in time still works next to a stale one', async (t) => {
    const s = await gatewaySession(t);
    const late = s.ask({ name: 'get_me', args: {} });
    s.cindy({ method: 'session/cancel', params: { sessionId: s.sessionId } });
    const fresh = s.ask({ name: 'get_me', args: {} });
    s.answer(fresh.id, 'yes');
    s.answer(late.id, 'yes');
    await waitUntil(() => s.toAgy.some((m) => m.id === late.id));
    assert.equal(text(await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })), 'ran get_me');
    assert.equal((await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })).message.result.isError, true, 'only one approval');
    assert.equal(s.github.state.calls.length, 1);
  });

  test('loading the session again keeps its relay URL, drops unused approvals and maps calls again', async (t) => {
    const s = await gatewaySession(t);
    const { id } = s.ask({ name: 'get_me', args: {} });
    s.answer(id, 'yes');
    await waitUntil(() => s.toAgy.some((m) => m.id === id));
    s.cindy({ id: 2, method: 'session/load', params: { sessionId: s.sessionId, cwd: '/p', mcpServers: [httpServer('custom_github', s.github.url)] } });
    await waitUntil(() => s.toAgy.some((m) => m.id === 2));
    assert.equal(s.toAgy.find((m) => m.id === 2).params.mcpServers[0].url, s.url, 'same URL: agy keeps the server name');
    s.agy({ id: 2, result: {} });
    await waitUntil(() => s.toCindy.some((m) => m.id === 2));
    assert.equal((await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })).message.result.isError, true, 'approval dropped');
    await listTools(s.url);
    const again = s.ask({ name: 'get_me', args: {} });
    assert.equal(s.toCindy.find((m) => m.id === again.id).params.toolCall.title, 'mcp__custom_github__get_me');
    s.answer(again.id, 'yes');
    await waitUntil(() => s.toAgy.some((m) => m.id === again.id));
    assert.equal(text(await callTool(s.url, 'call_tool', { name: 'get_me', args: {} })), 'ran get_me');
    assert.equal(s.github.state.calls.length, 1);
  });

  test('before the gateway is known for a server its calls are not rewritten and cannot be approved', async (t) => {
    const github = await fakeServer(t);
    const h = acpHarness(t);
    h.cindy({ id: 0, method: 'initialize', params: {} });
    h.agy({ id: 0, result: { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.15' } } });
    h.cindy({ id: 1, method: 'session/new', params: { cwd: '/p', mcpServers: [httpServer('custom_github', github.url)] } });
    await waitUntil(() => h.toAgy.some((m) => m.id === 1));
    h.agy({ id: 1, result: { sessionId: 'one' } });
    const toolCall = { toolCallId: 't', name: 'mcp_custom_github_call_tool', title: 'Run', kind: 'other', rawInput: { name: 'get_me', args: {} } };
    h.agy({ id: 'perm', method: 'session/request_permission', params: { sessionId: 'one', options: OPTIONS, toolCall } });
    const asked = h.toCindy.find((m) => m.id === 'perm');
    assert.equal(asked.params.toolCall.title, 'mcp__custom_github__call_tool');
    assert.equal(asked.params.options.length, 4, 'not a gateway call yet');
  });

  test('a session opened right after initialize waits for the relay instead of skipping it', async (t) => {
    const h = acpHarness(t);
    h.cindy({ id: 0, method: 'initialize', params: {} });
    h.agy({ id: 0, result: { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.15' } } });
    h.cindy({ id: 1, method: 'session/new', params: { cwd: '/p', mcpServers: [httpServer('cindy', 'http://127.0.0.1:1/c')] } });
    h.cindy({ id: 2, method: 'session/list', params: {} });
    await waitUntil(() => h.toAgy.some((m) => m.id === 2));
    const ids = h.toAgy.map((m) => m.id);
    assert.deepEqual(ids.slice(ids.indexOf(1)), [1, 2], 'order kept');
    assert.match(h.toAgy.find((m) => m.id === 1).params.mcpServers[0].url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/\d+$/);
  });
});
