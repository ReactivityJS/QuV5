/**
 * INDEXEDDB STORE — the browser CLIENT's own persistent tier, the missing
 * counterpart to `file-store.js`'s relay-side one: `Space`'s `storage`
 * constructor param and its own `_hydrateFromStorage()`/`useNode()` logic
 * (`@qu/space-core`'s `space.js`) already fully support a client reading
 * its own local cache FIRST (instant, no network) and only THEN sending a
 * subscribe request for whatever's newer - this adapter is simply the
 * FIRST real implementation of that param actually usable in a browser
 * (`@qu/app-shell`'s `shell.js` wires it in - see that file's own doc
 * comment on why "every reload/tab-open re-syncs everything from scratch"
 * was a real, previously-unaddressed cost this closes, at ZERO changes to
 * `Space`/`Node`/`Field` themselves).
 *
 * No `@qu/space-core`'s `encodeForWire()`/`decodeFromWire()` needed here,
 * unlike `file-store.js` - THAT adapter round-trips through `JSON.stringify`
 * (a real on-disk text file), which cannot represent a `Uint8Array` as
 * itself; IndexedDB stores values via the STRUCTURED CLONE algorithm
 * instead, which natively preserves `Uint8Array`/`ArrayBuffer` (and
 * anything nested inside a plain object/array) with no encoding step -
 * envelopes are stored and read back exactly as `@qu/space-core` produced
 * them, the same "objects passed by reference, never actually serialized"
 * posture `durable-store.js`'s own doc comment already describes for its
 * in-process PoC tier, just genuinely true here rather than simulated.
 *
 * SCHEMA: one object store (`envelopes`), one record per envelope,
 * `{seq (auto-increment primary key), nodeId, envelope}`, with a `nodeId`
 * index for `load()`/`replace()` to query by. `IDBIndex.getAll(nodeId)`
 * returns records ordered by (index key, primary key) - since every
 * matching record shares the SAME `nodeId`, this reduces to primary-key
 * (`seq`, i.e. insertion) order, exactly the append-order guarantee every
 * other adapter in this package already provides.
 *
 * ONE connection, opened lazily and cached for this store instance's own
 * lifetime (`dbPromise`) - cheaper than a fresh `indexedDB.open()` per
 * call, the same "cache the expensive setup, not the data" idea
 * `content-id.js`'s memoized ids use elsewhere in this codebase.
 * `db.onversionchange` closes it - lets a FUTURE schema migration (a
 * second tab opening a newer version of this same code) proceed instead of
 * blocking forever; this store instance simply reopens on its next call.
 * No further multi-tab-write coordination beyond that (a second tab writing
 * concurrently is safe - IndexedDB itself serializes transactions - just
 * not something this adapter goes out of its way to test), the same
 * "known, documented scope cut" `file-store.js`'s own doc comment already
 * accepts for its own single-writer assumption.
 */
const STORE_NAME = 'envelopes';
const DB_VERSION = 1;

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'seq', autoIncrement: true });
      store.createIndex('nodeId', 'nodeId', { unique: false });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close(); // see this file's own top doc comment on why.
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {{dbName?: string}} [options] - `dbName` (default `'qu-space-storage'`) - override only
 *   needed if one browser origin ever needs to keep more than one independent envelope log side by
 *   side (e.g. a test harness); an ordinary deployment (one relay's own static app bundle, one
 *   origin) never needs to set this - IndexedDB databases are already origin-scoped by the browser
 *   itself, so two different relay deployments can never collide regardless.
 */
export function createIndexedDbStore({ dbName = 'qu-space-storage' } = {}) {
  let dbPromise = null;
  function getDb() {
    return (dbPromise ??= openDb(dbName));
  }

  return {
    async append(nodeId, envelope) {
      const db = await getDb();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add({ nodeId, envelope });
      await promisifyTransaction(tx);
    },

    async load(nodeId) {
      const db = await getDb();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const records = await promisifyRequest(tx.objectStore(STORE_NAME).index('nodeId').getAll(nodeId));
      return records.map((r) => r.envelope);
    },

    /** Compaction: discards the ENTIRE prior log for `nodeId` in favor of `envelopes` (typically one `snapshot: true` envelope - see @qu/space-core's envelope.js "SNAPSHOT/COMPACTION" doc comment) - delete-then-add, all inside ONE transaction (atomic: a reader never observes a moment with neither the old nor the new log). */
    async replace(nodeId, envelopes) {
      const db = await getDb();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const existingKeys = await promisifyRequest(store.index('nodeId').getAllKeys(nodeId));
      for (const key of existingKeys) store.delete(key);
      for (const envelope of envelopes) store.add({ nodeId, envelope });
      await promisifyTransaction(tx);
    },
  };
}

/** `true` if this adapter can actually be used in the CURRENT environment (a real browser, or a test harness with an IndexedDB polyfill on `globalThis`) - `shell.js`'s own bootstrap checks this before constructing the adapter at all, falling back to memory-only (today's unchanged behavior) rather than throwing, e.g. under a privacy mode that removes `indexedDB`, or plain Node with no polyfill loaded. */
export function isIndexedDbAvailable() {
  return typeof indexedDB !== 'undefined';
}
