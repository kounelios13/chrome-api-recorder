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
 * Delete every recorded request (and body) of a scenario.
 * @param {string} scenarioId
 */
export async function deleteScenario(scenarioId) {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES], 'readwrite');
  const entryStore = transaction.objectStore(DB.ENTRIES);
  const bodyStore = transaction.objectStore(DB.BODIES);
  const index = entryStore.index('scenarioId');
  const request = index.getAllKeys(IDBKeyRange.only(scenarioId));
  request.onsuccess = () => {
    for (const key of request.result) {
      entryStore.delete(key);
      bodyStore.delete(key);
    }
  };
  await transactionDone(transaction);
}

/** Remove all recorded data (all scenarios). */
export async function deleteAllEntries() {
  const database = await openDb();
  const transaction = database.transaction([DB.ENTRIES, DB.BODIES], 'readwrite');
  transaction.objectStore(DB.ENTRIES).clear();
  transaction.objectStore(DB.BODIES).clear();
  await transactionDone(transaction);
}
