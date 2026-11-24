'use strict';

const MAX_TRACKED_CALLS = 2_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** agy connects to HTTP MCP servers without declaring it; Cindy only passes them if it does. */
function completeInitializeResult(result) {
  if (!isObject(result)) return result;
  const capabilities = isObject(result.agentCapabilities) ? result.agentCapabilities : {};
  const mcp = isObject(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
  return { ...result, agentCapabilities: { ...capabilities, mcpCapabilities: { ...mcp, http: true } } };
}

function isSessionOpen(method) {
  return method === 'session/new' || method === 'session/load' || method === 'session/resume';
}

function mcpArguments(input) {
  const value = input.Arguments;
  if (isObject(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isObject(parsed) ? parsed : { value: parsed };
    } catch {
      return { value };
    }
  }
  return {};
}

/** Keys sorted at every level, so the same arguments always give the same text. */
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

const FACADE_CALL_KEYS = new Set(['name', 'args', 'toolSummary']);

/**
 * The real tool behind a gateway `call_tool` input ({ name, args }). agy adds `toolSummary` to what
 * it reports, not to what it sends. Anything else makes the call invalid, so the approval shown in
 * Cindy and the call that runs are always read from the same two fields.
 */
function facadeCall(input) {
  if (!isObject(input) || Object.keys(input).some((key) => !FACADE_CALL_KEYS.has(key))) return null;
  if (typeof input.name !== 'string' || !input.name) return null;
  if (input.args !== undefined && input.args !== null && !isObject(input.args)) return null;
  return { tool: input.name, args: isObject(input.args) ? input.args : {} };
}

/** Use the longest matching server name because server names can themselves contain underscores. */
function directMcpTool(name, serverNames) {
  if (typeof name !== 'string' || !name.startsWith('mcp_')) return null;
  let found = null;
  for (const server of serverNames) {
    const prefix = `mcp_${server.replace(/[^A-Za-z0-9_]/g, '_')}_`;
    if (name.startsWith(prefix) && name.length > prefix.length && (!found || server.length > found.server.length)) {
      found = { server, tool: name.slice(prefix.length) };
    }
  }
  return found;
}

function nestedMcpTool(name, input, serverNames, allowLegacyEnvelope) {
  return isObject(input) && typeof input.ServerName === 'string' && typeof input.ToolName === 'string'
    && (allowLegacyEnvelope || (name === 'call_mcp_tool' && serverNames.includes(input.ServerName)))
    ? { server: input.ServerName, tool: input.ToolName }
    : null;
}

function gatewayCall(tool, input, isFacade) {
  if (tool?.tool !== 'call_tool' || !isFacade?.(tool.server)) return null;
  return { server: tool.server, call: facadeCall(input) };
}

/** Normalize agy's direct and nested MCP calls. Keep their identity on updates that omit it. */
/**
 * `isFacade(server)` (local sessions only) says a server is reached through the gateway; its
 * `call_tool` then takes the identity and arguments of the real tool it runs.
 */
function normalizeMcpToolCall(toolCall, seen, serverNames, { allowLegacyEnvelope = false, toolIdentity, isFacade } = {}) {
  if (!isObject(toolCall)) return null;
  const id = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
  const input = toolCall.rawInput;
  let known = id ? seen.get(id) : undefined;
  const name = allowLegacyEnvelope ? toolCall.name : toolCall.name ?? known?.sourceName;
  const nested = nestedMcpTool(name, input, serverNames, allowLegacyEnvelope);
  const direct = nested ? null : directMcpTool(name, serverNames);
  const args = nested ? mcpArguments(input) : input;
  const gateway = gatewayCall(nested ?? direct, args, isFacade);
  // An update without arguments keeps the identity its call already has.
  const call = gateway?.call ? { server: gateway.server, tool: gateway.call.tool }
    : gateway && known ? null : nested ?? direct;
  if (call) {
    const identity = toolIdentity?.(call) ?? { title: `mcp__${call.server}__${call.tool}`, kind: 'other' };
    known = { ...identity, sourceName: name };
    if (id) {
      if (seen.size >= MAX_TRACKED_CALLS && !seen.has(id)) seen.delete(seen.keys().next().value);
      seen.set(id, known);
    }
  }
  if (!known || (!allowLegacyEnvelope && name !== known.sourceName)) return null;

  const next = { ...toolCall };
  if ('title' in next) next.title = known.title;
  if ('name' in next) next.name = known.title;
  if ('kind' in next) next.kind = known.kind;
  if (gateway?.call) next.rawInput = gateway.call.args;
  else if (nested) next.rawInput = args;
  else if (direct && isObject(input)) {
    // agy adds a one-line summary to direct calls. Cindy uses the actual tool arguments.
    const { toolSummary: _summary, ...rest } = input;
    next.rawInput = rest;
  }
  if (isObject(next.args) && (typeof next.args.ServerName === 'string' || direct)) delete next.args;
  return next;
}

/**
 * A `call_tool` of a gateway server: its server and, when the input is valid, the real tool and
 * arguments (`call`). Null for any other tool.
 */
function facadeToolCall(name, rawInput, serverNames, isFacade) {
  const nested = nestedMcpTool(name, rawInput, serverNames);
  return gatewayCall(nested ?? directMcpTool(name, serverNames), nested ? mcpArguments(rawInput) : rawInput, isFacade);
}

module.exports = {
  canonicalJson, completeInitializeResult, facadeCall, facadeToolCall, isObject, isSessionOpen, normalizeMcpToolCall,
};
