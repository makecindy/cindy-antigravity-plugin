'use strict';

const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { completeInitializeResult, facadeToolCall, isObject, isSessionOpen, normalizeMcpToolCall } = require('./agy-mcp.js');
const { createMcpRelay } = require('./agy-mcp-relay.js');

function lineTransform(handle) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function drain(stream) {
    let start = 0;
    let end;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, end + 1);
      const forwarded = handle(line);
      if (forwarded !== null) stream.push(forwarded);
      start = end + 1;
    }
    pending = pending.slice(start);
    if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error('ACP line exceeds 16 MiB');
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        pending += decoder.write(chunk);
        drain(this);
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      pending += decoder.end();
      callback(null, pending);
    },
  });
}

const encode = (message) => JSON.stringify(message) + '\n';
function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function supportsSteering(agentVersion) {
  const version = /^1\.(\d+)\.\d+$/.exec(agentVersion);
  return !!version && Number(version[1]) >= 5;
}

/** Permission options a gateway call keeps: an always-rule would be stored by agy for the whole server. */
const ONCE_KINDS = new Set(['allow_once', 'reject_once']);
const DONE_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const idKey = (id) => JSON.stringify(id);

/**
 * agy accepts concurrent session/prompt requests. The previous request may end
 * as soon as a new one takes over. Keep Cindy's original request open until
 * the newest prompt finishes and relay all of the session's streamed updates.
 */
function attachSteering(input, output, child, stop) {
  const turns = new Map();
  const requests = new Map();
  const openingSessions = new Map();
  const mcpSessions = new Map();
  let nextSteerId = 0;
  let initializeId;
  let isAntigravity = false;
  let offered = false;
  // Gateway (agy-mcp-relay.js): pending permission requests by id, prompt ids by session.
  let relay = null;
  let relaySettled = false;
  let held = null;
  const permissions = new Map();
  const prompts = new Map();

  const isFacadeIn = (session) => (server) => {
    const id = session.targets?.[server];
    return id !== undefined && relay.facadeState(id) === 'on';
  };
  /**
   * Unused approvals of a session lapse when its turn ends, it is cancelled, replaced or closed.
   * Questions still open in Cindy then go stale: a late allow is refused and grants nothing.
   */
  function revokeSession(sessionId, toolCallId) {
    if (!relay || typeof sessionId !== 'string') return;
    relay.revoke(sessionId, toolCallId);
    for (const pending of permissions.values()) {
      if (pending.sessionId === sessionId && (toolCallId === undefined || pending.toolCallId === toolCallId)) pending.stale = true;
    }
  }

  /** A gateway call asks Cindy about the real tool, with once-only options, and remembers what it asked. */
  function gatewayPermission(message, session, toolCall) {
    const raw = message.params.toolCall;
    if (!isObject(raw)) return null;
    // agy may leave out the name it already reported for this call.
    const name = raw.name ?? session.seen.get(raw.toolCallId)?.sourceName;
    const gateway = facadeToolCall(name, raw.rawInput, session.serverNames, isFacadeIn(session));
    if (!gateway) return null;
    const call = gateway.call && { server: gateway.server, ...gateway.call };
    const options = Array.isArray(message.params.options) ? message.params.options.filter((option) => ONCE_KINDS.has(option?.kind)) : [];
    permissions.set(idKey(message.id), {
      sessionId: message.params.sessionId, call, toolCallId: raw.toolCallId, targetId: call && session.targets[call.server],
      kinds: new Map(options.map((option) => [option.optionId, option.kind])),
      rejectId: options.find((option) => option.kind === 'reject_once')?.optionId,
    });
    return { ...message, params: { ...message.params, toolCall, options } };
  }

  /** Cindy's answer: an allow becomes one single-use approval; an option that was not offered is refused. */
  function gatewayAnswer(message, pending) {
    const outcome = message.result?.outcome;
    if (outcome?.outcome !== 'selected') return null;
    const kind = pending.kinds.get(outcome.optionId);
    if (kind === 'allow_once' && !pending.stale) {
      if (pending.call && pending.targetId !== undefined) {
        relay.grant(pending.targetId, pending.call.tool, pending.call.args, { sessionId: pending.sessionId, toolCallId: pending.toolCallId });
      }
      return null;
    }
    if (kind && kind !== 'allow_once') return null;
    const refused = pending.rejectId !== undefined
      ? { outcome: 'selected', optionId: pending.rejectId } : { outcome: 'cancelled' };
    return { ...message, result: { ...message.result, outcome: refused } };
  }

  function normalizeToolMessage(message) {
    const { method, params } = message;
    const updateKind = params?.update?.sessionUpdate;
    let key;
    if (method === 'session/request_permission' && message.id !== undefined) key = 'toolCall';
    if (method === 'session/update' && (updateKind === 'tool_call' || updateKind === 'tool_call_update')) key = 'update';
    if (!key || typeof params?.sessionId !== 'string') return null;
    const { sessionId } = params;
    // agy can replay updates while it loads a known session, before its open response.
    const opening = [...openingSessions.values()].find((session) => session.sessionId === sessionId);
    const session = opening ?? mcpSessions.get(sessionId);
    if (!session) return null;
    const isFacade = relay ? isFacadeIn(session) : undefined;
    const toolCall = normalizeMcpToolCall(params[key], session.seen, session.serverNames, { isFacade });
    if (key === 'update' && relay && DONE_STATUSES.has(params.update.status) && params.update.toolCallId !== undefined) {
      revokeSession(sessionId, params.update.toolCallId);
    }
    if (key === 'toolCall' && relay) {
      const gated = gatewayPermission(message, session, toolCall ?? params.toolCall);
      if (gated) return gated;
    }
    return toolCall ? { ...message, params: { ...params, [key]: toolCall } } : null;
  }

  const toClient = lineTransform((line) => {
    const message = parse(line);
    if (!message) return line;
    if (message.method) {
      const normalized = isAntigravity && normalizeToolMessage(message);
      return normalized ? encode(normalized) : line;
    }
    if (message.id === undefined) return line;
    const promptSession = prompts.get(idKey(message.id));
    if (promptSession !== undefined && !requests.has(message.id)) {
      prompts.delete(idKey(message.id));
      revokeSession(promptSession);
    }
    if (message.id === initializeId) {
      initializeId = undefined;
      const { agentInfo } = message.result ?? {};
      isAntigravity = agentInfo?.name === 'Antigravity ACP Server';
      if (isAntigravity) {
        const result = completeInitializeResult(message.result);
        offered = supportsSteering(agentInfo.version);
        if (offered) result._meta = { ...result._meta, steering: { ...result._meta?.steering, supported: true } };
        return encode({ ...message, result });
      }
    }
    const opening = openingSessions.get(message.id);
    if (opening) {
      openingSessions.delete(message.id);
      const sessionId = opening.sessionId ?? message.result?.sessionId;
      if (isObject(message.result) && typeof sessionId === 'string') {
        if (mcpSessions.has(sessionId)) revokeSession(sessionId);
        mcpSessions.set(sessionId, opening);
      }
    }

    const turn = requests.get(message.id);
    if (!turn) return line;
    requests.delete(message.id);
    if (message.id === turn.latestId) turn.result = message;
    if (--turn.pending !== 0) return null;
    turns.delete(turn.sessionId);
    prompts.delete(idKey(turn.originalId));
    revokeSession(turn.sessionId);
    return encode({ ...turn.result, id: turn.originalId });
  });

  function toAgentLine(line) {
    const message = parse(line);
    if (relay && message && !message.method && message.id !== undefined) {
      const pending = permissions.get(idKey(message.id));
      if (pending) {
        permissions.delete(idKey(message.id));
        const answered = gatewayAnswer(message, pending);
        return answered ? encode(answered) : line;
      }
    }
    if (message?.method === 'session/cancel') revokeSession(message.params?.sessionId);
    if (!message?.method || message.id === undefined) return line;
    const params = message.params;
    if (message.method === 'initialize') {
      initializeId = message.id;
      if (!relay) {
        relay = createMcpRelay();
        relay.ready.then(() => { relaySettled = true; });
      }
    }
    if (message.method === 'session/close') {
      revokeSession(params?.sessionId);
      mcpSessions.delete(params?.sessionId);
    }
    if (relay && message.method === 'session/prompt' && typeof params?.sessionId === 'string') {
      prompts.set(idKey(message.id), params.sessionId);
    }
    if (isAntigravity && isSessionOpen(message.method)) {
      const servers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
      const serverNames = servers.map((server) => server?.name).filter((name) => typeof name === 'string' && name);
      const routed = relay ? relay.rewriteServers(servers) : { servers, targets: {} };
      openingSessions.set(message.id, {
        sessionId: params?.sessionId, serverNames, seen: new Map(), targets: routed.targets,
      });
      if (routed.servers !== servers && routed.servers.some((server, index) => server !== servers[index])) {
        return encode({ ...message, params: { ...params, mcpServers: routed.servers } });
      }
    }
    if (!offered) return line;
    if (message.method === 'session/prompt' && typeof params?.sessionId === 'string' && !turns.has(params.sessionId)) {
      const turn = { sessionId: params.sessionId, originalId: message.id, latestId: message.id, pending: 1 };
      turns.set(params.sessionId, turn);
      requests.set(message.id, turn);
    }
    if (message.method !== '_session/steering') return line;
    const turn = turns.get(params?.sessionId);
    if (!turn || turn.result) {
      toClient.push(encode({ jsonrpc: '2.0', id: message.id, result: {
        outcome: 'promptRequired', reason: 'noRunningTurn',
      } }));
      return null;
    }
    const id = 'cindy-steer-' + ++nextSteerId;
    turn.latestId = id;
    turn.pending++;
    requests.set(id, turn);
    // Acknowledge the bridge accepting input before agy can emit its output.
    // Native submission failures then surface on the original prompt.
    toClient.push(encode({ jsonrpc: '2.0', id: message.id, result: { outcome: 'injected' } }));
    return encode({ jsonrpc: '2.0', id, method: 'session/prompt', params: {
      sessionId: turn.sessionId, prompt: params.prompt,
    } });
  }

  // A session must not reach agy before the relay listens: hold it, and everything after it, in order.
  const toAgent = lineTransform((line) => {
    if (held) {
      held.push(line);
      return null;
    }
    if (isAntigravity && relay && !relaySettled && isSessionOpen(parse(line)?.method)) {
      held = [line];
      relay.ready.then(() => {
        const lines = held;
        held = null;
        for (const next of lines) {
          const forwarded = toAgentLine(next);
          if (forwarded !== null && !toAgent.readableEnded) toAgent.push(forwarded);
        }
      });
      return null;
    }
    return toAgentLine(line);
  });
  toAgent.on('error', stop);
  toClient.on('error', stop);
  input.pipe(toAgent).pipe(child.stdin);
  child.stdout.pipe(toClient).pipe(output, { end: false });
  // `relay` ends once everything agy wrote has been handed to `output`.
  return { detach: () => { input.unpipe(toAgent); relay?.close(); }, relay: toClient };
}

module.exports = { attachSteering };
