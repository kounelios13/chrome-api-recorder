/**
 * Generic WebSocket adapter: exact frame matching, plus an optional structural
 * fallback for JSON protocols that are not Socket.IO or SignalR.
 *
 * When `smartFallback` is on, two JSON objects are considered the same request
 * when they agree on their discriminator (`type`/`action`/`event`/`method`/
 * `op`/`topic`) and arguments. Common correlation ids (`id`, `reqId`, ...) are
 * ignored for matching and rewritten in the recorded response when it echoed
 * the recorded request's id.
 */

const DISCRIMINATOR_KEYS = ['type', 'action', 'event', 'method', 'op', 'topic'];
const CORRELATION_KEYS = ['id', 'reqId', 'requestId', 'seq', 'correlationId'];

/** @param {string} text */
function parseJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {any} parsed */
function discriminatorOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of DISCRIMINATOR_KEYS) {
    if (typeof parsed[key] === 'string' || typeof parsed[key] === 'number') {
      return { key, value: parsed[key] };
    }
  }
  return null;
}

/** @param {any} parsed */
function correlationIdOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of CORRELATION_KEYS) {
    if (parsed[key] != null) return { key, value: parsed[key] };
  }
  return null;
}

/** Remove id-ish properties so they do not take part in matching. */
function withoutCorrelationIds(parsed) {
  const copy = { ...parsed };
  for (const key of CORRELATION_KEYS) delete copy[key];
  return copy;
}

/** @type {import('./index.js').WsAdapter} */
const generic = {
  name: 'generic',

  detect() {
    return true;
  },

  splitFrame(text) {
    const raw = String(text ?? '');
    return raw ? [raw] : [];
  },

  joinMessages(messages) {
    return (Array.isArray(messages) ? messages : []).join('');
  },

  isControlOrKeepalive() {
    return false;
  },

  handleControlMessage() {
    return null;
  },

  startKeepalive() {
    return null;
  },

  matchSignature(message) {
    const parsed = parseJsonObject(message);
    if (!parsed) return null;
    const discriminator = discriminatorOf(parsed);
    if (!discriminator) return null;
    const correlation = correlationIdOf(parsed);
    return {
      key: `${discriminator.key}=${JSON.stringify(discriminator.value)}|${JSON.stringify(withoutCorrelationIds(parsed))}`,
      correlationId: correlation ? String(correlation.value) : null,
      discriminatorKey: discriminator.key,
    };
  },

  rewriteCorrelationId(recordedRecvMessage, recordedSendId, liveSendId) {
    if (recordedSendId == null || liveSendId == null) return recordedRecvMessage;
    const parsed = parseJsonObject(recordedRecvMessage);
    if (!parsed) return recordedRecvMessage;
    const correlation = correlationIdOf(parsed);
    if (!correlation) return recordedRecvMessage;
    if (String(correlation.value) !== String(recordedSendId)) return recordedRecvMessage;

    let replaced = false;
    const live = numericIfPossible(liveSendId);
    const rewritten = { ...parsed, [correlation.key]: live };
    replaced = true;
    return replaced ? JSON.stringify(rewritten) : recordedRecvMessage;
  },

  prettyPrint(text) {
    const parsed = parseJsonObject(text);
    if (!parsed) return String(text ?? '');
    try {
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(text ?? '');
    }
  },
};

/** @param {string|number} value */
function numericIfPossible(value) {
  const text = String(value);
  return /^\d+$/.test(text) ? Number(text) : text;
}

export default generic;
