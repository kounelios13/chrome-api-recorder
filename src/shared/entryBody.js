/**
 * Pure helpers for editing a recorded response payload.
 *
 * Kept separate from the service worker so the metadata recalculation
 * (size / preview / body kind / edited flag) can be unit tested.
 */
import { bytesPreview, looksLikeText } from './bytes.js';
import { LIMITS } from './constants.js';

/**
 * Build the updated entry metadata after its response body changed.
 *
 * @param {object} entry existing entry metadata
 * @param {Uint8Array} bytes new response body bytes
 * @param {{edited: boolean, editedAt?: number}} options
 * @returns {object} new metadata object (the input is not mutated)
 */
export function buildEditedEntry(entry, bytes, { edited, editedAt = Date.now() } = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const isText = looksLikeText(body);

  return {
    ...entry,
    size: body.length,
    bodyKind: isText ? 'text' : 'binary',
    responsePreview: isText ? bytesPreview(body, LIMITS.MAX_PREVIEW_CHARS) : `<binary ${body.length} bytes>`,
    edited: Boolean(edited),
    editedAt: edited ? editedAt : null,
  };
}

/**
 * The subset of an entry that is safe to send to the options page (no body).
 * @param {object} entry
 */
export function summarizeEntry(entry) {
  return {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    resourceType: entry.resourceType,
    size: entry.size,
    capturedAt: entry.capturedAt,
    bodyKind: entry.bodyKind,
    edited: Boolean(entry.edited),
    editedAt: entry.editedAt ?? null,
    requestPreview: entry.requestPreview,
    responsePreview: entry.responsePreview,
  };
}
