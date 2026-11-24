/**
 * Scenario import/export format.
 *
 * Two document kinds exist:
 *  - single scenario:   format "api-recorder-scenario"   (per-scenario export)
 *  - scenario collection: format "api-recorder-scenarios" (export-all)
 *
 * Both are plain JSON carrying recorded request metadata and response bodies
 * (base64). The match key travels with each entry — it was derived from the
 * original request and cannot be recomputed from the export — so replay keeps
 * working on the importing machine. Entry ids are regenerated on import, which
 * means importing the same file twice creates independent scenarios.
 *
 * Pure module so the format and validation can be unit tested.
 */
import { base64ToBytes, isBase64 } from './bytes.js';

export const SCENARIO_EXPORT_FORMAT = 'api-recorder-scenario';
export const SCENARIOS_EXPORT_FORMAT = 'api-recorder-scenarios';
export const SCENARIO_EXPORT_VERSION = 2;
/** Documents written by older versions are still importable. */
const SUPPORTED_IMPORT_VERSIONS = [1, 2];

/** Upper bound for one scenario's imported payload (bodies + WS frames). */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

const EXPORTED_ENTRY_FIELDS = [
  'kind',
  'matchKey',
  'method',
  'url',
  'status',
  'statusText',
  'mimeType',
  'resourceType',
  'size',
  'capturedAt',
  'bodyKind',
  'edited',
  'editedAt',
  'requestPreview',
  'responsePreview',
  'responseHeaders',
  'wsAdapter',
  'negotiatedProtocol',
  'frameCount',
  'sentCount',
  'recvCount',
  'durationMs',
  'truncated',
];

const EXPORTED_FRAME_FIELDS = ['seq', 'direction', 'opcode', 'offsetMs', 'size', 'payload', 'originalPayload', 'edited'];

/**
 * @param {object} frame
 */
function buildExportedFrame(frame) {
  /** @type {any} */
  const out = {};
  for (const field of EXPORTED_FRAME_FIELDS) {
    if (frame?.[field] !== undefined) out[field] = frame[field];
  }
  return out;
}

/**
 * One scenario section inside a document: metadata + entries with bodies.
 * @param {{
 *   name: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   hosts?: string[],
 * }} scenario
 * @param {object[]} entries
 * @param {Record<string, {body:string, originalBody?:string}|undefined>} bodiesById
 * @param {Record<string, object[]>} [framesById]
 */
function buildScenarioSection(scenario, entries, bodiesById, framesById) {
  return {
    scenario: {
      name: scenario.name,
      createdAt: scenario.createdAt,
      updatedAt: scenario.updatedAt,
      hosts: scenario.hosts ?? [],
    },
    entries: (Array.isArray(entries) ? entries : []).map((entry) => {
      const out = {};
      for (const field of EXPORTED_ENTRY_FIELDS) {
        if (entry[field] !== undefined) out[field] = entry[field];
      }
      if (entry.kind === 'ws') {
        out.kind = 'ws';
        out.frames = (framesById?.[entry.id] ?? []).map(buildExportedFrame);
        return out;
      }
      const record = bodiesById?.[entry.id] ?? {};
      out.body = typeof record.body === 'string' ? record.body : '';
      if (typeof record.originalBody === 'string') out.originalBody = record.originalBody;
      return out;
    }),
  };
}

/**
 * Assemble the JSON document for one scenario.
 * @param {{
 *   scenario: {id:string, name:string, createdAt:number, updatedAt:number, hosts?:string[]},
 *   entries: object[],
 *   bodiesById: Record<string, {body:string, originalBody?:string}|undefined>,
 *   framesById?: Record<string, object[]>,
 *   exportedAt: number,
 *   extensionVersion: string,
 * }} input
 */
export function buildExportDocument({ scenario, entries, bodiesById, framesById, exportedAt, extensionVersion }) {
  return {
    format: SCENARIO_EXPORT_FORMAT,
    formatVersion: SCENARIO_EXPORT_VERSION,
    exportedAt,
    extensionVersion,
    ...buildScenarioSection(scenario, entries, bodiesById, framesById),
  };
}

/**
 * Assemble the JSON document for every scenario that has recorded requests.
 * @param {{
 *   scenarios: Array<{id:string, name:string, createdAt:number, updatedAt:number, hosts?:string[]}>,
 *   entriesById: Record<string, object[]>,
 *   bodiesById: Record<string, {body:string, originalBody?:string}|undefined>,
 *   framesById?: Record<string, object[]>,
 *   exportedAt: number,
 *   extensionVersion: string,
 * }} input
 */
export function buildCollectionExportDocument({
  scenarios,
  entriesById,
  bodiesById,
  framesById,
  exportedAt,
  extensionVersion,
}) {
  return {
    format: SCENARIOS_EXPORT_FORMAT,
    formatVersion: SCENARIO_EXPORT_VERSION,
    exportedAt,
    extensionVersion,
    scenarios: (Array.isArray(scenarios) ? scenarios : []).map((scenario) =>
      buildScenarioSection(scenario, entriesById?.[scenario.id] ?? [], bodiesById, framesById),
    ),
  };
}

/**
 * Which document kind is this?
 * @param {unknown} data
 * @returns {'single'|'collection'|null}
 */
export function detectExportKind(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.format === SCENARIO_EXPORT_FORMAT) return 'single';
  if (data.format === SCENARIOS_EXPORT_FORMAT) return 'collection';
  return null;
}

/**
 * Structural validation of a parsed import document (either kind).
 * @param {unknown} data
 * @returns {{ok: boolean, reason: string|null, kind: 'single'|'collection'|null}}
 */
export function validateScenarioImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'The file is not a JSON object.', kind: null };
  }
  const kind = detectExportKind(data);
  if (!kind) return { ok: false, reason: 'This file was not created by API Recorder.', kind: null };
  if (!SUPPORTED_IMPORT_VERSIONS.includes(Number(data.formatVersion))) {
    return { ok: false, reason: `Unsupported export version: ${String(data.formatVersion)}.`, kind };
  }

  if (kind === 'single') {
    if (!data.scenario || typeof data.scenario.name !== 'string' || !data.scenario.name.trim()) {
      return { ok: false, reason: 'The export has no scenario name.', kind };
    }
    if (!Array.isArray(data.entries)) {
      return { ok: false, reason: 'The export has no recorded requests.', kind };
    }
    return { ok: true, reason: null, kind };
  }

  if (!Array.isArray(data.scenarios) || data.scenarios.length === 0) {
    return { ok: false, reason: 'The export has no scenarios.', kind };
  }
  for (const section of data.scenarios) {
    if (!section || typeof section !== 'object' || !section.scenario || typeof section.scenario.name !== 'string' || !section.scenario.name.trim()) {
      return { ok: false, reason: 'A scenario in the export has no name.', kind };
    }
    if (!Array.isArray(section.entries)) {
      return { ok: false, reason: `Scenario “${String(section.scenario?.name ?? '?')}” has no recorded requests.`, kind };
    }
  }
  return { ok: true, reason: null, kind };
}

/**
 * @param {string} body base64
 * @param {number} maxBodyBytes
 */
function bodySizeOrNull(body, maxBodyBytes) {
  if (!isBase64(body)) return null;
  try {
    const bytes = base64ToBytes(body);
    if (bytes.length > maxBodyBytes) return -1;
    return bytes.length;
  } catch {
    return null;
  }
}

/**
 * Normalize one scenario section (name, timestamps, entries, skip reasons).
 * @param {{scenario: any, entries: any[]}} section
 * @param {{now: number, maxBodyBytes: number}} options
 * @returns {{name: string, createdAt: number, updatedAt: number, records: Array<{entry: object, body: string, originalBody?: string, frames?: object[]}>, skipped: Array<{index: number, reason: string}>}}
 */
function normalizeScenarioSection(section, { now, maxBodyBytes, maxFrameBytes }) {
  const name = String(section.scenario.name)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  const createdAt = Number(section.scenario.createdAt) || now;
  const updatedAt = Number(section.scenario.updatedAt) || createdAt;

  const records = [];
  const skipped = [];
  let totalBytes = 0;
  let exhausted = false;

  section.entries.forEach((raw, index) => {
    if (exhausted) {
      skipped.push({ index, reason: 'the export is larger than the import limit' });
      return;
    }
    const normalized = normalizeImportedEntry(raw, { now, maxBodyBytes, maxFrameBytes });
    if (normalized.error) {
      skipped.push({ index, reason: normalized.error });
      return;
    }

    // Per-entry caps are not enough for WS scenarios: 2000 frames at the body
    // limit is unbounded memory in the options page.
    const entryBytes =
      normalized.entry.kind === 'ws'
        ? (normalized.frames ?? []).reduce(
            (sum, frame) =>
              sum + (Number(frame.size) || 0) + (frame.originalPayload ? frame.originalPayload.length : 0),
            0,
          )
        : (Number(normalized.entry.size) || 0) +
          (normalized.originalBody ? normalized.originalBody.length : 0);
    if (totalBytes + entryBytes > MAX_IMPORT_BYTES) {
      exhausted = true;
      skipped.push({ index, reason: 'the export is larger than the import limit' });
      return;
    }

    totalBytes += entryBytes;
    records.push(normalized);
  });

  return { name, createdAt, updatedAt, records, skipped };
}

/**
 * Normalize every scenario of a validated import document (either kind).
 *
 * @param {any} data a document that passed validateScenarioImport
 * @param {{now?: number, maxBodyBytes?: number}} [options]
 * @returns {Array<{name: string, createdAt: number, updatedAt: number, records: Array<{entry: object, body: string, originalBody?: string}>, skipped: Array<{index: number, reason: string}>}>}
 */
export function normalizeImportedScenarios(
  data,
  { now = Date.now(), maxBodyBytes = Infinity, maxFrameBytes = maxBodyBytes } = {},
) {
  const validation = validateScenarioImport(data);
  if (!validation.ok) throw new Error(validation.reason);

  const sections =
    validation.kind === 'single'
      ? [{ scenario: data.scenario, entries: data.entries }]
      : data.scenarios;
  return sections.map((section) =>
    normalizeScenarioSection(section, { now, maxBodyBytes, maxFrameBytes }),
  );
}

/**
 * Single-scenario convenience wrapper (kept for callers of the old shape).
 * @param {any} data
 * @param {{now?: number, maxBodyBytes?: number}} [options]
 */
export function normalizeImportedScenario(data, options) {
  const results = normalizeImportedScenarios(data, options);
  return (
    results[0] ?? {
      name: 'Imported scenario',
      createdAt: options?.now ?? Date.now(),
      updatedAt: options?.now ?? Date.now(),
      records: [],
      skipped: [],
    }
  );
}

/**
 * @param {any} raw
 * @param {{now: number, maxBodyBytes: number}} options
 * @returns {{error: string}|{entry: object, body: string, originalBody?: string, frames?: object[]}}
 */
function normalizeImportedEntry(raw, { now, maxBodyBytes, maxFrameBytes = maxBodyBytes }) {
  if (!raw || typeof raw !== 'object') return { error: 'entry is not an object' };
  if (typeof raw.matchKey !== 'string' || !/^[0-9a-f]{64}$/.test(raw.matchKey)) {
    return { error: 'entry has a missing or invalid match key' };
  }
  if (typeof raw.url !== 'string' || !raw.url.trim()) return { error: 'entry has no URL' };

  if (raw.kind === 'ws') return normalizeImportedWsEntry(raw, { now, maxBodyBytes, maxFrameBytes });

  const body = typeof raw.body === 'string' ? raw.body : '';
  const size = bodySizeOrNull(body, maxBodyBytes);
  if (size === null) return { error: 'response body is not valid base64' };
  if (size === -1) return { error: 'response body is larger than the configured limit' };

  const method = typeof raw.method === 'string' && /^[A-Za-z]+$/.test(raw.method)
    ? raw.method.toUpperCase()
    : 'GET';
  const status = Number(raw.status);
  const edited = raw.edited === true;
  const originalBody =
    typeof raw.originalBody === 'string' && isBase64(raw.originalBody) ? raw.originalBody : undefined;

  return {
    entry: {
      kind: 'http',
      matchKey: raw.matchKey,
      method,
      url: String(raw.url),
      status: Number.isFinite(status) ? Math.trunc(status) : 200,
      statusText: typeof raw.statusText === 'string' ? raw.statusText : '',
      mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
      resourceType: raw.resourceType === 'XHR' ? 'XHR' : 'Fetch',
      size,
      capturedAt: Number(raw.capturedAt) || now,
      bodyKind: raw.bodyKind === 'binary' ? 'binary' : 'text',
      edited,
      editedAt: edited ? Number(raw.editedAt) || now : null,
      requestPreview: typeof raw.requestPreview === 'string' ? raw.requestPreview : '',
      responsePreview: typeof raw.responsePreview === 'string' ? raw.responsePreview : '',
      responseHeaders: Array.isArray(raw.responseHeaders)
        ? raw.responseHeaders
            .filter(
              (header) =>
                header && typeof header.name === 'string' && typeof header.value === 'string',
            )
            .map((header) => ({ name: header.name, value: header.value }))
        : [],
    },
    body,
    originalBody,
  };
}

/**
 * Normalize a WebSocket entry and its frames. Frames are validated like bodies:
 * base64 payloads within the configured size limit.
 *
 * @param {any} raw
 * @param {{now: number, maxBodyBytes: number}} options
 */
function normalizeImportedWsEntry(raw, { now, maxBodyBytes, maxFrameBytes = maxBodyBytes }) {
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) {
    return { error: 'WebSocket entry has no frames' };
  }

  /** @type {object[]} */
  const frames = [];
  for (const [index, frame] of raw.frames.entries()) {
    if (!frame || typeof frame !== 'object') return { error: 'WebSocket frame is not an object' };
    if (typeof frame.payload !== 'string' || !isBase64(frame.payload)) {
      return { error: `WebSocket frame ${index} has an invalid payload` };
    }
    const size = bodySizeOrNull(frame.payload, maxFrameBytes);
    if (size === null) return { error: `WebSocket frame ${index} has an invalid payload` };
    if (size === -1) return { error: `WebSocket frame ${index} is larger than the configured limit` };

    const seq = Number(frame.seq);
    const direction = frame.direction === 'send' ? 'send' : 'recv';
    const opcode = Number(frame.opcode) === 2 ? 2 : 1;
    const originalPayload =
      typeof frame.originalPayload === 'string' && isBase64(frame.originalPayload)
        ? frame.originalPayload
        : undefined;

    /** @type {any} */
    const normalized = {
      seq: Number.isFinite(seq) ? Math.trunc(seq) : index,
      direction,
      opcode,
      offsetMs: Math.max(0, Number(frame.offsetMs) || 0),
      size,
      payload: frame.payload,
      edited: frame.edited === true,
    };
    if (originalPayload) normalized.originalPayload = originalPayload;
    frames.push(normalized);
  }

  frames.sort((left, right) => left.seq - right.seq);
  const sent = frames.filter((frame) => frame.direction === 'send').length;
  const status = Number(raw.status);

  return {
    entry: {
      kind: 'ws',
      matchKey: raw.matchKey,
      method: 'WS',
      url: String(raw.url),
      status: Number.isFinite(status) && status > 0 ? Math.trunc(status) : 101,
      statusText: typeof raw.statusText === 'string' ? raw.statusText : '',
      mimeType: 'websocket',
      resourceType: 'WebSocket',
      wsAdapter: typeof raw.wsAdapter === 'string' ? raw.wsAdapter : 'generic',
      negotiatedProtocol: typeof raw.negotiatedProtocol === 'string' ? raw.negotiatedProtocol : '',
      frameCount: frames.length,
      sentCount: sent,
      recvCount: frames.length - sent,
      durationMs: Math.max(0, Number(raw.durationMs) || 0),
      truncated: raw.truncated === true,
      size: frames.reduce((sum, frame) => sum + frame.size, 0),
      capturedAt: Number(raw.capturedAt) || now,
      bodyKind: 'text',
      edited: raw.edited === true,
      editedAt: raw.edited === true ? Number(raw.editedAt) || now : null,
      requestPreview: typeof raw.requestPreview === 'string' ? raw.requestPreview : '',
      responsePreview: typeof raw.responsePreview === 'string' ? raw.responsePreview : '',
      responseHeaders: [],
    },
    body: '',
    frames,
  };
}


/**
 * A scenario name that does not collide with existing local scenario names.
 * @param {string} requested
 * @param {string[]} existingNames
 */
export function uniqueImportedName(requested, existingNames) {
  const taken = new Set((existingNames ?? []).map((name) => String(name).toLowerCase()));
  const base = String(requested ?? '').trim() || 'Imported scenario';
  if (!taken.has(base.toLowerCase())) return base;

  let suffix = 2;
  while (taken.has(`${base} (imported ${suffix})`.toLowerCase())) suffix += 1;
  return `${base} (imported ${suffix})`;
}

/**
 * File-name-safe scenario slug, e.g. "Checkout flow" -> "checkout-flow".
 * @param {string} name
 */
export function scenarioFileSlug(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'scenario';
}
