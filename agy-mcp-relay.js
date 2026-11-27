'use strict';

/**
 * Loopback relay between agy and a few of Cindy's local HTTP MCP servers. agy 1.5.x keeps only
 * about 60 KB of MCP tool definitions per session and silently drops the rest, so the large servers
 * (FACADE_SERVERS) are shown as `list_tools`/`call_tool`, and a few long descriptions
 * (COMPACT_TOOLS) are shortened. A gateway call only runs with Cindy's approval of exactly that tool
 * and those arguments (see grant()).
 *
 * Everything else, including all headers (authorization, MCP session ids) and event streams, is
 * forwarded unchanged. The relay keeps no credentials.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { canonicalJson, facadeCall, isObject } = require('./agy-mcp.js');

const LIST_TOOLS_NOTE = '（完整用法见 list_tools）';
/** Server -> { tool: note appended to its one-sentence description }. */
const COMPACT_TOOLS = {
  cindy_browser: { call_tool: LIST_TOOLS_NOTE, list_tools: '' },
  cindy_ssh: { call_tool: LIST_TOOLS_NOTE, list_tools: '' },
  cindy_scheduler: { call_tool: LIST_TOOLS_NOTE, list_tools: '' },
  // Only used when custom_github cannot go through the gateway (see FACADE_SERVERS).
  custom_github: { add_issue_comment: '', search_repositories: '' },
};
const FACADE_SERVERS = new Set(['cindy', 'cindy_orca', 'custom_github']);
const FACADE_TOOLS = [
  {
    name: 'list_tools',
    description: 'List the tools of this MCP server. Without arguments: each tool name with a one-line summary. '
      + 'With name: that tool\'s full description and input schema. Read a tool here before calling it with call_tool.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Tool name to show in full' } } },
  },
  {
    name: 'call_tool',
    description: 'Call one tool of this MCP server by name, with the arguments its input schema (from list_tools) asks for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name from list_tools' },
        args: { type: 'object', description: 'Arguments for the tool, as a JSON object' },
      },
      required: ['name'],
    },
  },
];
const FACADE_NAMES = new Set(FACADE_TOOLS.map((tool) => tool.name));
const MAX_DESCRIPTION = 120;
const MAX_BUFFERED = 16 * 1024 * 1024;
/** Tool lists kept per relay route, one per MCP session; the oldest is dropped beyond this. */
const MAX_DIRECTORIES = 16;
const GRANT_TTL_MS = 2 * 60 * 1000;
const LIST_CHANGED = 'notifications/tools/list_changed';
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'];

/** Keep the first sentence (at most MAX_DESCRIPTION characters) and append the note. */
function compactDescription(text, note = '') {
  if (typeof text !== 'string') return text;
  const line = text.split('\n')[0].trim();
  const end = line.search(/[。；]|\.(\s|$)/);
  let head = end >= 0 ? line.slice(0, end + 1) : line;
  if (head.length > MAX_DESCRIPTION) head = head.slice(0, MAX_DESCRIPTION);
  const short = head + note;
  return short.length < text.length ? short : text;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function withoutHopByHop(headers) {
  const next = { ...headers };
  for (const name of HOP_BY_HOP) delete next[name];
  return next;
}

const isEventStream = (contentType) => /^text\/event-stream\b/i.test(String(contentType ?? '').trim());

/** End of an SSE event: a blank line, with any of the three line endings. */
const EVENT_END = /(?:\r\n|\r(?!\n)|\n){2}/g;
const LINE_END = /\r\n|\r|\n/;

/** The data of one SSE event (its data lines joined with \n), or null when it has none. */
function eventData(event) {
  const lines = event.split(LINE_END).filter((line) => line.startsWith('data:'));
  return lines.length ? lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n') : null;
}

function mapJson(text, mapMessage) {
  const parsed = parseJson(text);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const mapped = messages.map(mapMessage);
  if (!mapped.some((message, index) => message !== messages[index])) return null;
  return JSON.stringify(Array.isArray(parsed) ? mapped : mapped[0]);
}

function findResponse(text, id) {
  return [parseJson(text)].flat().find((message) => isObject(message) && message.id === id && !message.method);
}

/** A real JSON-RPC tools/list_changed notification (not a request, response or text mentioning it). */
function hasListChangedNotification(text) {
  const parsed = parseJson(text);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some((message) => isObject(message) && message.jsonrpc === '2.0'
    && message.method === LIST_CHANGED && !Object.hasOwn(message, 'id')
    && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')
    && (message.params === undefined || isObject(message.params) || Array.isArray(message.params)));
}

/** Read complete SSE events across chunks while bounding an unfinished event. */
function sseEventReader(onEvent) {
  const decoder = new StringDecoder('utf8');
  const eventEnd = new RegExp(EVENT_END.source, 'g');
  let pending = '';
  let oversized = false;
  let skipLf = false;
  return {
    write(chunk) {
      const text = decoder.write(chunk);
      if (!text) return true;
      eventEnd.lastIndex = Math.max(0, pending.length - 3);
      // A CR at the end of the previous chunk may have completed the event.
      pending += skipLf && text.startsWith('\n') ? text.slice(1) : text;
      skipLf = false;
      let start = 0;
      let end;
      let withinLimit = true;
      while ((end = eventEnd.exec(pending))) {
        if (!oversized) {
          if (end.index - start <= MAX_BUFFERED) onEvent(pending.slice(start, end.index));
          else withinLimit = false;
        }
        oversized = false;
        start = eventEnd.lastIndex;
        skipLf = start === pending.length && end[0].endsWith('\r');
      }
      pending = pending.slice(start);
      if (pending.length > MAX_BUFFERED) {
        withinLimit = false;
        oversized = true;
        pending = pending.slice(-3);
      }
      return withinLimit;
    },
    remainder: () => pending + decoder.end(),
  };
}

function mapSseStream(mapMessage) {
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      callback(events.write(chunk) ? null : new Error('SSE event too large'));
    },
    flush(callback) {
      callback(null, events.remainder());
    },
  });
  const events = sseEventReader((event) => {
    const data = eventData(event);
    const mapped = data === null ? null : mapJson(data, mapMessage);
    const body = mapped === null ? event
      : [...event.split(LINE_END).filter((line) => !line.startsWith('data:')), 'data: ' + mapped].join('\n');
    stream.push(body + '\n\n');
  });
  return stream;
}

/** Observe notifications without delaying or altering the original stream. */
function listChangedEventTap(onChange) {
  const events = sseEventReader((event) => {
    const data = eventData(event);
    if (data !== null && hasListChangedNotification(data)) onChange();
  });
  return new Transform({
    transform(chunk, _encoding, callback) {
      events.write(chunk);
      callback(null, chunk);
    },
  });
}

/** Same for a JSON body; only a batch can carry a notification next to the response. */
function listChangedJsonTap(onChange) {
  const chunks = [];
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size <= MAX_BUFFERED) chunks.push(chunk);
      else chunks.length = 0;
      callback(null, chunk);
    },
    flush(callback) {
      if (size <= MAX_BUFFERED && hasListChangedNotification(Buffer.concat(chunks).toString('utf8'))) onChange();
      callback();
    },
  });
}

const toolResult = (id, text) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
/** The ACP session a tools/call belongs to: agy names it in _meta (subagents carry their root session). */
function callSession(params) {
  const meta = isObject(params?._meta) ? params._meta : {};
  const id = meta['antigravity.google/root_conversation_id'] ?? meta['antigravity.google/conversation_id'];
  return typeof id === 'string' && id ? id : null;
}
const grantKey = (tool, args) => crypto.createHash('sha256').update(canonicalJson({ tool, args })).digest('hex');

/** What list_tools without a name shows: each tool's name and first sentence. */
function directoryIndex(tools) {
  return [...tools.values()].map((tool) => ({ name: tool.name, summary: compactDescription(tool.description || '') }));
}

function createMcpRelay({ log = (line) => process.stderr.write(line + '\n') } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const targets = new Map();
  const routes = new Map();
  let grants = [];
  let port = null;
  let nextTarget = 0;
  let nextInternalId = 0;

  /** The tool list of the MCP session a request belongs to, or null when it has to be read again. */
  function currentDirectory(target, sessionId) {
    const dir = target.dirs.get(sessionId);
    return dir && !dir.stale ? dir : null;
  }

  function adoptToolList(target, sessionId, result) {
    const tools = isObject(result) && Array.isArray(result.tools) ? result.tools : null;
    const usable = tools && !result.nextCursor
      && tools.every((tool) => isObject(tool) && typeof tool.name === 'string' && tool.name && !FACADE_NAMES.has(tool.name))
      && new Set(tools.map((tool) => tool.name)).size === tools.length;
    target.dirs.delete(sessionId);
    if (usable) {
      target.dirs.set(sessionId, { stale: false, tools: new Map(tools.map((tool) => [tool.name, tool])) });
      if (target.dirs.size > MAX_DIRECTORIES) target.dirs.delete(target.dirs.keys().next().value);
      if (target.facade !== 'on') log(`[agy-acp] ${target.server}: tools reached through list_tools/call_tool (${tools.length}).`);
      target.facade = 'on';
      return true;
    }
    if (target.facade === 'on') {
      log(`[agy-acp] ${target.server}: its tool list can no longer be read; gateway calls are refused.`);
    } else {
      target.facade = 'off';
      log(`[agy-acp] ${target.server}: tools passed directly (paged, duplicate or reserved tool names).`);
    }
    return false;
  }

  function mapToolList(target, sessionId, message) {
    if (!isObject(message) || message.method || !('result' in message)) return message;
    if (target.facadeCandidate && target.facade !== 'off') {
      adoptToolList(target, sessionId, message.result);
      if (target.facade === 'on') {
        const { nextCursor: _cursor, ...rest } = message.result;
        return { ...message, result: { ...rest, tools: FACADE_TOOLS } };
      }
    }
    const rule = target.rule;
    const tools = message.result?.tools;
    if (!rule || !Array.isArray(tools)) return message;
    return {
      ...message,
      result: {
        ...message.result,
        tools: tools.map((tool) => (typeof tool?.name === 'string' && Object.hasOwn(rule, tool.name)
          ? { ...tool, description: compactDescription(tool.description, rule[tool.name]) }
          : tool)),
      },
    };
  }

  function forward(target, req, res, body, sessionId, { rewriteBody, mapMessage } = {}) {
    const headers = withoutHopByHop(req.headers);
    headers.host = target.url.host;
    const payload = rewriteBody ?? body;
    if (rewriteBody || req.method === 'POST') headers['content-length'] = String(payload.length);
    if (mapMessage) headers['accept-encoding'] = 'identity';
    const upstream = (target.url.protocol === 'https:' ? https : http).request(target.url, { method: req.method, headers }, (up) => {
      if (!mapMessage) {
        res.writeHead(up.statusCode, withoutHopByHop(up.headers));
        const contentType = up.headers['content-type']?.split(';')[0].trim().toLowerCase();
        // A notification on one MCP session's stream only concerns that session's tool list.
        const invalidate = () => { const dir = target.dirs.get(sessionId); if (dir) dir.stale = true; };
        const tap = target.facadeCandidate && (contentType === 'text/event-stream' ? listChangedEventTap(invalidate)
          : contentType === 'application/json' ? listChangedJsonTap(invalidate) : null);
        (tap ? up.pipe(tap) : up).pipe(res);
        up.on('error', () => res.destroy());
        return;
      }
      const outHeaders = withoutHopByHop(up.headers);
      delete outHeaders['content-encoding'];
      up.on('error', () => res.destroy());
      if (isEventStream(up.headers['content-type'])) {
        delete outHeaders['content-length'];
        res.writeHead(up.statusCode, outHeaders);
        const mapped = mapSseStream(mapMessage);
        mapped.on('error', () => res.destroy());
        up.pipe(mapped).pipe(res);
        return;
      }
      const parts = [];
      let size = 0;
      up.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BUFFERED) up.destroy(new Error('response too large'));
        else parts.push(chunk);
      });
      up.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        const out = Buffer.from(mapJson(text, mapMessage) ?? text, 'utf8');
        outHeaders['content-length'] = String(out.length);
        res.writeHead(up.statusCode, outHeaders);
        res.end(out);
      });
    });
    upstream.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    res.on('close', () => upstream.destroy());
    upstream.end(payload);
  }

  /** Reads the server's tool list again with the headers of agy's current request. */
  function refreshDirectory(target, req, sessionId) {
    return new Promise((resolve) => {
      const id = `cindy-relay-${++nextInternalId}`;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }));
      const headers = withoutHopByHop(req.headers);
      headers.host = target.url.host;
      headers['content-length'] = String(payload.length);
      headers['accept-encoding'] = 'identity';
      const upstream = (target.url.protocol === 'https:' ? https : http).request(target.url, { method: 'POST', headers }, (up) => {
        const accept = (message) => resolve(message && adoptToolList(target, sessionId, message.result) ? target.dirs.get(sessionId) : null);
        up.on('error', () => resolve(null));
        if (isEventStream(up.headers['content-type'])) {
          let found = false;
          const events = sseEventReader((event) => {
            if (found) return;
            const message = findResponse(eventData(event), id);
            if (!message) return;
            found = true;
            accept(message);
            up.destroy();
          });
          up.on('data', (chunk) => {
            if (!events.write(chunk) && !found) up.destroy(new Error('SSE event too large'));
          });
          up.on('end', () => resolve(null));
          return;
        }
        const parts = [];
        let size = 0;
        up.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BUFFERED) up.destroy(new Error('response too large'));
          else parts.push(chunk);
        });
        up.on('end', () => accept(findResponse(Buffer.concat(parts).toString('utf8'), id)));
      });
      upstream.on('error', () => resolve(null));
      upstream.end(payload);
    });
  }

  function answer(res, message) {
    const out = Buffer.from(JSON.stringify(message), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(out.length) });
    res.end(out);
  }

  /** Uses up one approval of exactly this tool and these arguments, given in the same session. */
  function takeGrant(target, tool, args, sessionId) {
    if (sessionId === null) return false;
    const key = grantKey(tool, args);
    const now = Date.now();
    grants = grants.filter((grant) => grant.expires > now);
    const index = grants.findIndex((grant) => grant.targetId === target.id && grant.key === key && grant.sessionId === sessionId);
    if (index < 0) return false;
    grants.splice(index, 1);
    return true;
  }

  async function handleGatewayCall(target, req, res, message, sessionId) {
    const { id, params } = message;
    const name = params?.name;
    if (name === 'list_tools') {
      const dir = currentDirectory(target, sessionId) ?? await refreshDirectory(target, req, sessionId);
      if (!dir) return answer(res, toolResult(id, 'The tool list of this server could not be read. Try list_tools again later.'));
      const wanted = isObject(params.arguments) ? params.arguments.name : undefined;
      if (wanted === undefined || wanted === null || wanted === '') {
        return answer(res, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(directoryIndex(dir.tools)) }] } });
      }
      const tool = typeof wanted === 'string' ? dir.tools.get(wanted) : undefined;
      if (!tool) return answer(res, toolResult(id, `This server has no tool named ${JSON.stringify(wanted)}. Call list_tools without arguments for the list.`));
      return answer(res, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(tool) }] } });
    }
    if (name !== 'call_tool') return answer(res, toolResult(id, `Unknown tool ${JSON.stringify(name)}. Use list_tools and call_tool.`));
    const call = facadeCall(params.arguments);
    if (!call) return answer(res, toolResult(id, 'call_tool needs name (a tool name from list_tools) and args (a JSON object), and nothing else. It was not run.'));
    const dir = currentDirectory(target, sessionId);
    if (!dir) return answer(res, toolResult(id, 'The tool list of this server changed or was not read yet. Call list_tools, then call the tool again. It was not run.'));
    if (!dir.tools.has(call.tool)) return answer(res, toolResult(id, `This server has no tool named ${JSON.stringify(call.tool)}. It was not run.`));
    // A call that does not name its session cannot be matched to an approval.
    if (!takeGrant(target, call.tool, call.args, callSession(params))) {
      log(`[agy-acp] ${target.server}: refused ${call.tool}: no matching approval from Cindy in this session.`);
      return answer(res, toolResult(id, 'This call was not approved in Cindy with these exact arguments in this session, so it was not run.'));
    }
    const rewritten = { ...message, params: { ...params, name: call.tool, arguments: call.args } };
    return forward(target, req, res, null, sessionId, { rewriteBody: Buffer.from(JSON.stringify(rewritten), 'utf8') });
  }

  const server = http.createServer((req, res) => {
    const match = /^\/([0-9a-f]+)\/(\d+)$/.exec(new URL(req.url, 'http://relay').pathname);
    const target = match && match[1] === token ? targets.get(match[2]) : undefined;
    if (!target) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => res.destroy());
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : null;
      if (req.method === 'DELETE') target.dirs.delete(sessionId);
      const message = req.method === 'POST' ? parseJson(body.toString('utf8')) : undefined;
      if (target.facade === 'on' && Array.isArray(message)) {
        answer(res, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batched requests are not supported here.' } });
        return;
      }
      if (isObject(message) && message.method === 'tools/call' && target.facade === 'on') {
        handleGatewayCall(target, req, res, message, sessionId).catch(() => res.destroy());
        return;
      }
      const listIds = [message].flat().filter((m) => m?.method === 'tools/list' && m.id !== undefined).map((m) => m.id);
      if (listIds.length && (target.rule || target.facadeCandidate)) {
        forward(target, req, res, body, sessionId, {
          mapMessage: (m) => listIds.includes(m?.id) ? mapToolList(target, sessionId, m) : m,
        });
        return;
      }
      forward(target, req, res, body, sessionId);
    });
  });
  server.on('error', (error) => log(`[agy-acp] MCP relay unavailable: ${error.message}`));
  const ready = new Promise((resolve) => {
    server.once('listening', () => { port = server.address().port; resolve(true); });
    server.once('error', () => resolve(false));
  });
  server.listen(0, '127.0.0.1');
  server.unref();

  /**
   * Routes the servers the relay handles through it. Returns the new list and, per server name,
   * the relay target that serves it. A server keeps its relay URL for the life of the process: agy
   * renames a server that comes back under a known name with another URL (a loaded session would
   * then call tools by names nobody approves). Anything else stays as it was.
   */
  function rewriteServers(servers) {
    const routed = {};
    if (port === null) return { servers, targets: routed };
    const next = servers.map((entry) => {
      if (!isObject(entry) || entry.type !== 'http' || typeof entry.name !== 'string') return entry;
      const rule = Object.hasOwn(COMPACT_TOOLS, entry.name) ? COMPACT_TOOLS[entry.name] : null;
      const facadeCandidate = FACADE_SERVERS.has(entry.name);
      if (!rule && !facadeCandidate) return entry;
      let url;
      try {
        url = new URL(entry.url);
      } catch {
        return entry;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return entry;
      const route = `${entry.name}\n${url.href}`;
      let id = routes.get(route);
      if (id === undefined) {
        id = String(nextTarget++);
        routes.set(route, id);
        targets.set(id, { id, server: entry.name, url, rule, facadeCandidate, facade: 'unknown', dirs: new Map() });
      }
      routed[entry.name] = id;
      return { ...entry, url: `http://127.0.0.1:${port}/${token}/${id}` };
    });
    return { servers: next, targets: routed };
  }

  return {
    ready,
    rewriteServers,
    /** 'on' once the server's tools are reached through list_tools/call_tool in this session. */
    facadeState: (id) => targets.get(id)?.facade ?? 'off',
    /** One approval from Cindy: lets exactly one call of `tool` with exactly `args` run in that session. */
    grant(id, tool, args, { sessionId, toolCallId }) {
      if (targets.has(id)) grants.push({ targetId: id, key: grantKey(tool, args), sessionId, toolCallId, expires: Date.now() + GRANT_TTL_MS });
    },
    /** Drops the session's approvals that were not used: one call's, or all of them. */
    revoke(sessionId, toolCallId) {
      grants = grants.filter((grant) => grant.sessionId !== sessionId || (toolCallId !== undefined && grant.toolCallId !== toolCallId));
    },
    close: () => server.close(),
  };
}

module.exports = { createMcpRelay, compactDescription };
