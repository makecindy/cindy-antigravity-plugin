'use strict';

const { isObject, isSessionOpen } = require('./agy-mcp.js');

const QUOTA_REASONS = new Set(['QUOTA_EXHAUSTED', 'SUBSCRIPTION_QUOTA_EXHAUSTED', 'MODEL_QUOTA_EXHAUSTED']);
const QUOTA_TEXT = /\b(?:subscription|model) quota (?:exhausted|exceeded)\b|\bexceeded (?:the |your )?(?:subscription|model) quota\b/i;

/**
 * Project explicit agy failures into Cindy's account protocol. A generic rate limit, capacity
 * error or 503 is not proof that the user's subscription window ran out.
 */
function classifyResponse(message) {
  const error = message?.error;
  if (!isObject(error) || (error.data !== undefined && !isObject(error.data))) return message;
  const data = error.data ?? {};
  if (data._meta !== undefined && !isObject(data._meta)) return message;
  const meta = data._meta ?? {};
  if (meta.cindy !== undefined) return message;
  let info;
  if (error.code === -32000 || data.reason === 'AUTH_REQUIRED') {
    info = { kind: 'auth-required' };
  } else if (QUOTA_REASONS.has(data.reason) || QUOTA_REASONS.has(data.status) || QUOTA_TEXT.test(error.message ?? '')) {
    info = { kind: 'usage-limit' };
    const reset = Number.isFinite(data.resetsAt) && data.resetsAt > Date.now() ? data.resetsAt : undefined;
    if (reset) info.resetsAt = reset;
  }
  if (!info) return message;
  return { ...message, error: { ...error, data: { ...data, _meta: { ...meta, cindy: info } } } };
}

/** Only responses to session open/prompt requests can inform account routing. */
function accountErrorRelay() {
  const pending = new Set();
  return {
    request(message) {
      if (message?.id !== undefined && (isSessionOpen(message.method) || message.method === 'session/prompt')) {
        pending.add(message.id);
      }
    },
    response(message) {
      if (!message?.method && pending.delete(message?.id)) return classifyResponse(message);
      return message;
    },
  };
}

module.exports = { accountErrorRelay };
