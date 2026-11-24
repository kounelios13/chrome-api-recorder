/**
 * IndexedDB persistence for recorded requests.
 *
 * Metadata (`entries`) and response bodies (`bodies`) live in separate stores
 * so the UIs and the replay index can load metadata cheaply without pulling
 * megabytes of response bodies into memory.
 *
 * Record id = `${scenarioId}:${matchKey}` so re-recording the same logical
 * request overwrites the previous capture (latest wins).
 */
import { DB } from '../shared/constants.js';

/** @type {Promise<IDBDatabase>|null} */
let openPromise = null;

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  if (openPromise) return openPromise;

  openPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB.NAME, DB.VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DB.ENTRIES)) {
        const entries = database.createObjectStore(DB.ENTRIES, { keyPath: 'id' });
        entries.createIndex('scenarioId', 'scenarioId', { unique: false });
      }
      if (!database.objectStoreNames.contains(DB.BODIES)) {
        database.createObjectStore(DB.BODIES, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(DB.WS_FRAMES)) {
        const frames = database.createObjectStore(DB.WS_FRAMES, { keyPath: 'id' });
        frames.createIndex('entryId', 'entryId', { unique: false });
        frames.createIndex('scenarioId', 'scenarioId', { unique: false });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        openPromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Could not open the recording database'));
    };
    request.onblocked = () => {
      reject(new Error('The recording database is blocked by another extension page'));
    };
  });

  return openPromise;
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** @param {IDBTransaction} transaction */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * @param {string} scenarioId
 * @param {string} matchKey
 */
export function entryId(scenarioId, matchKey) {
  return `${scenarioId}:${matchKey}`;
}

/**
 * Save one recorded request and its response body.
 * @param {object} entry metadata (must include id, scenarioId, matchKey)
 * @param {string} bodyBase64 base64 of the exact response bytes
 */
export async function saveEntry(entry, bodyBase64) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES], 'readwrite');
  transaction.objectStore(DB.ENTRIES).put(entry);
  transaction.objectStore(DB.BODIES).put({ id: entry.id, body: bodyBase64 });
  await transactionDone(transaction);
  return entry;
}

/**
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
export async function getEntry(id) {
  const database = await openDb();
  const transaction = database.transaction(DB.ENTRIES, 'readonly');
  return requestToPromise(transaction.objectStore(DB.ENTRIES).get(id));
}

/**
 * @param {string} id
 * @returns {Promise<{id: string, body: string}|undefined>}
 */
export async function getBody(id) {
  const database = await openDb();
  const transaction = database.transaction(DB.BODIES, 'readonly');
  return requestToPromise(transaction.objectStore(DB.BODIES).get(id));
}

/**
 * Replace an entry's response body and refresh its metadata in one
 * transaction. The first edit keeps a copy of the original body so the user can
 * restore the recorded payload later.
 *
 * @param {object} entry updated metadata (same id)
 * @param {string} bodyBase64 new response body
 * @param {{preserveOriginal?: boolean}} [options]
 * @returns {Promise<{hasOriginal: boolean}>}
 */
export async function updateEntryBody(entry, bodyBase64, { preserveOriginal = true } = {}) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES], 'readwrite');
  const bodyStore = transaction.objectStore(DB.BODIES);
  const entryStore = transaction.objectStore(DB.ENTRIES);

  let hasOriginal = false;
  const request = bodyStore.get(entry.id);
  request.onsuccess = () => {
    const record = request.result ?? { id: entry.id, body: '' };
    if (preserveOriginal && typeof record.originalBody !== 'string') {
      record.originalBody = typeof record.body === 'string' ? record.body : '';
    }
    record.id = entry.id;
    record.body = bodyBase64;
    hasOriginal = typeof record.originalBody === 'string';
    bodyStore.put(record);
    entryStore.put(entry);
  };

  await transactionDone(transaction);
  return { hasOriginal };
}

/**
 * Restore the original (recorded) body of an entry, discarding the edit.
 * @param {object} entry updated metadata (same id)
 * @returns {Promise<boolean>} false when there is no original to restore
 */
export async function restoreEntryBody(entry) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES], 'readwrite');
  const bodyStore = transaction.objectStore(DB.BODIES);
  const entryStore = transaction.objectStore(DB.ENTRIES);

  let restored = false;
  const request = bodyStore.get(entry.id);
  request.onsuccess = () => {
    const record = request.result;
    if (!record || typeof record.originalBody !== 'string') return;
    record.body = record.originalBody;
    delete record.originalBody;
    bodyStore.put(record);
    entryStore.put(entry);
    restored = true;
  };

  await transactionDone(transaction);
  return restored;
}

/**
 * Persist many entries and bodies in a single transaction (used by scenario
 * import so large files do not pay one transaction per request).
 *
 * @param {Array<{entry: object, body: string, originalBody?: string}>} records
 */
export async function saveEntriesBulk(records) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES, DB.WS_FRAMES], 'readwrite');
  const entryStore = transaction.objectStore(DB.ENTRIES);
  const bodyStore = transaction.objectStore(DB.BODIES);
  const frameStore = transaction.objectStore(DB.WS_FRAMES);

  for (const record of records) {
    entryStore.put(record.entry);
    if (record.entry.kind !== 'ws') {
      const bodyRecord = { id: record.entry.id, body: record.body };
      if (typeof record.originalBody === 'string') bodyRecord.originalBody = record.originalBody;
      bodyStore.put(bodyRecord);
    }
    if (Array.isArray(record.frames) && record.frames.length > 0) {
      record.frames.forEach((frame, index) => {
        const seq = Number.isFinite(Number(frame.seq)) ? Number(frame.seq) : index;
        frameStore.put({
          ...frame,
          seq,
          id: wsFrameId(record.entry.id, seq),
          entryId: record.entry.id,
          scenarioId: record.entry.scenarioId,
        });
      });
    }
  }

  await transactionDone(transaction);
}

/**
 * All metadata for one scenario (bodies are not loaded).
 * @param {string} scenarioId
 * @returns {Promise<object[]>}
 */
export async function listEntries(scenarioId) {
  const database = await openDb();
  const transaction = database.transaction(DB.ENTRIES, 'readonly');
  const index = transaction.objectStore(DB.ENTRIES).index('scenarioId');
  const entries = await requestToPromise(index.getAll(IDBKeyRange.only(scenarioId)));
  return entries ?? [];
}

/**
 * @param {string} scenarioId
 * @returns {Promise<number>}
 */
export async function countEntries(scenarioId) {
  const database = await openDb();
  const transaction = database.transaction(DB.ENTRIES, 'readonly');
  const index = transaction.objectStore(DB.ENTRIES).index('scenarioId');
  return requestToPromise(index.count(IDBKeyRange.only(scenarioId)));
}

/**
 * Delete one recorded request and its response body.
 * @param {string} id
 */
export async function deleteEntry(id) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES, DB.WS_FRAMES], 'readwrite');
  transaction.objectStore(DB.ENTRIES).delete(id);
  transaction.objectStore(DB.BODIES).delete(id);
  deleteWsFramesByIndex(transaction.objectStore(DB.WS_FRAMES), 'entryId', id);
  await transactionDone(transaction);
}

/**
 * Delete every recorded request (and body, and WS frames) of a scenario.
 * @param {string} scenarioId
 */
export async function deleteScenario(scenarioId) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES, DB.WS_FRAMES], 'readwrite');
  const entryStore = transaction.objectStore(DB.ENTRIES);
  const bodyStore = transaction.objectStore(DB.BODIES);
  const frameStore = transaction.objectStore(DB.WS_FRAMES);
  const index = entryStore.index('scenarioId');
  const request = index.getAllKeys(IDBKeyRange.only(scenarioId));
  request.onsuccess = () => {
    for (const key of request.result) {
      entryStore.delete(key);
      bodyStore.delete(key);
    }
  };
  deleteWsFramesByIndex(frameStore, 'scenarioId', scenarioId);
  await transactionDone(transaction);
}

/** Remove all recorded data (all scenarios). */
export async function deleteAllEntries() {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES, DB.WS_FRAMES], 'readwrite');
  transaction.objectStore(DB.ENTRIES).clear();
  transaction.objectStore(DB.BODIES).clear();
  transaction.objectStore(DB.WS_FRAMES).clear();
  await transactionDone(transaction);
}

// ---------------------------------------------------------------------------
// WebSocket recordings
// ---------------------------------------------------------------------------

/**
 * Frames are addressed by `${entryId}:${seq}` so they cascade with their entry.
 * @param {string} entryIdValue
 * @param {number} seq
 */
export function wsFrameId(entryIdValue, seq) {
  return `${entryIdValue}:${seq}`;
}

/**
 * Delete every WS frame that matches an index value.
 * @param {IDBObjectStore} store
 * @param {string} indexName
 * @param {IDBValidKey} value
 */
function deleteWsFramesByIndex(store, indexName, value) {
  const index = store.index(indexName);
  const request = index.getAllKeys(IDBKeyRange.only(value));
  request.onsuccess = () => {
    for (const key of request.result) store.delete(key);
  };
}

/**
 * Append frames to a staging entry id. Recording flushes in batches so a
 * service-worker restart cannot lose an entire long-lived connection; the
 * staging rows are replaced when the connection is finalized.
 *
 * @param {string} stagingEntryId
 * @param {string} scenarioId
 * @param {object[]} frames normalized frames (see wsRecorder.js)
 */
export async function appendWsFrames(stagingEntryId, scenarioId, frames) {
  if (!Array.isArray(frames) || frames.length === 0) return;
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readwrite');
  const store = transaction.objectStore(DB.WS_FRAMES);
  for (const frame of frames) {
    store.put({
      ...frame,
      id: wsFrameId(stagingEntryId, frame.seq),
      entryId: stagingEntryId,
      scenarioId,
    });
  }
  await transactionDone(transaction);
}

/**
 * Persist a finished WebSocket recording.
 *
 * Only non-empty connections are promoted, so a reconnect that fails before
 * receiving a single frame never overwrites a good recording ("latest
 * non-empty wins"). Staging rows for the same connection are removed.
 *
 * @param {object} entry metadata (id, scenarioId, kind:'ws', matchKey, ...)
 * @param {object[]} frames normalized frames
 * @param {string} [stagingEntryId]
 * @returns {Promise<boolean>} whether the recording was saved
 */
export async function saveWsRecording(entry, frames, stagingEntryId) {
  if (!Array.isArray(frames) || frames.length === 0) {
    if (stagingEntryId) await deleteWsFrames(stagingEntryId);
    return false;
  }

  const database = await openDb();

  // Collect the keys to clear first (read transaction), then issue deletes
  // before the puts: IndexedDB runs requests in issue order, so deleting after
  // the puts would remove the recording that was just written.
  const readTransaction = database.transaction(DB.WS_FRAMES, 'readonly');
  const readStore = readTransaction.objectStore(DB.WS_FRAMES);
  const previousKeys = await requestToPromise(
    readStore.index('entryId').getAllKeys(IDBKeyRange.only(entry.id)),
  );
  let stagedKeys = [];
  if (stagingEntryId && stagingEntryId !== entry.id) {
    const stagedTransaction = database.transaction(DB.WS_FRAMES, 'readonly');
    stagedKeys = await requestToPromise(
      stagedTransaction.objectStore(DB.WS_FRAMES).index('entryId').getAllKeys(IDBKeyRange.only(stagingEntryId)),
    );
  }

  const transaction = database.transaction([DB.ENTRIES, DB.WS_FRAMES], 'readwrite');
  const entryStore = transaction.objectStore(DB.ENTRIES);
  const frameStore = transaction.objectStore(DB.WS_FRAMES);

  for (const key of [...(previousKeys ?? []), ...(stagedKeys ?? [])]) frameStore.delete(key);
  entryStore.put(entry);
  frames.forEach((frame, index) => {
    const seq = Number.isFinite(Number(frame.seq)) ? Number(frame.seq) : index;
    frameStore.put({
      ...frame,
      seq,
      id: wsFrameId(entry.id, seq),
      entryId: entry.id,
      scenarioId: entry.scenarioId,
    });
  });

  await transactionDone(transaction);
  return true;
}

/**
 * Every frame of a recorded connection, in capture order.
 * @param {string} entryIdValue
 * @returns {Promise<object[]>}
 */
export async function listWsFrames(entryIdValue) {
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readonly');
  const index = transaction.objectStore(DB.WS_FRAMES).index('entryId');
  const frames = await requestToPromise(index.getAll(IDBKeyRange.only(entryIdValue)));
  return (frames ?? []).sort((left, right) => (Number(left.seq) || 0) - (Number(right.seq) || 0));
}

/**
 * @param {string} frameId
 * @returns {Promise<object|undefined>}
 */
export async function getWsFrame(frameId) {
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readonly');
  return requestToPromise(transaction.objectStore(DB.WS_FRAMES).get(frameId));
}

/**
 * Persist one edited frame. Mirrors `updateEntryBody`: the first edit keeps the
 * recorded payload so the user can restore it.
 *
 * @param {object} frame frame metadata (same id)
 * @param {string} payloadBase64
 * @returns {Promise<{hasOriginal: boolean}>}
 */
export async function updateWsFramePayload(frame, payloadBase64) {
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readwrite');
  const store = transaction.objectStore(DB.WS_FRAMES);

  let hasOriginal = false;
  const request = store.get(frame.id);
  request.onsuccess = () => {
    const record = request.result ?? { ...frame, payload: '' };
    if (typeof record.originalPayload !== 'string') {
      record.originalPayload = typeof record.payload === 'string' ? record.payload : '';
    }
    Object.assign(record, frame, { payload: payloadBase64 });
    hasOriginal = typeof record.originalPayload === 'string';
    store.put(record);
  };

  await transactionDone(transaction);
  return { hasOriginal };
}

/**
 * Restore a frame's recorded payload, discarding the edit.
 * @param {object} frame frame metadata (same id)
 * @returns {Promise<boolean>}
 */
export async function restoreWsFramePayload(frame) {
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readwrite');
  const store = transaction.objectStore(DB.WS_FRAMES);

  let restored = false;
  const request = store.get(frame.id);
  request.onsuccess = () => {
    const record = request.result;
    if (!record || typeof record.originalPayload !== 'string') return;
    record.payload = record.originalPayload;
    delete record.originalPayload;
    Object.assign(record, frame, { payload: record.payload });
    store.put(record);
    restored = true;
  };

  await transactionDone(transaction);
  return restored;
}

/**
 * Delete a single recorded frame.
 * @param {string} frameId
 */
export async function deleteWsFrame(frameId) {
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readwrite');
  transaction.objectStore(DB.WS_FRAMES).delete(frameId);
  await transactionDone(transaction);
}

/**
 * Delete every frame of a connection (used to drop staging rows).
 * @param {string} entryIdValue
 */
export async function deleteWsFrames(entryIdValue) {
  const database = await openDb();
  const transaction = database.transaction(DB.WS_FRAMES, 'readwrite');
  deleteWsFramesByIndex(transaction.objectStore(DB.WS_FRAMES), 'entryId', entryIdValue);
  await transactionDone(transaction);
}

/**
 * Persist an entry's metadata without touching its bodies or frames.
 * @param {object} entry
 */
export async function putEntry(entry) {
  const database = await openDb();
  const transaction = database.transaction(DB.ENTRIES, 'readwrite');
  transaction.objectStore(DB.ENTRIES).put(entry);
  await transactionDone(transaction);
}

