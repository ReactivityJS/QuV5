/**
 * BLOB MEMORY STORE — the ephemeral tier for raw blob bytes, `blob-file-
 * store.js`'s in-RAM counterpart (same role `memory-store.js` plays for
 * envelopes) - a real relay's tests/in-process demos never need actual
 * disk to exercise `relay-blob-server.js`'s own upload/download logic.
 */
export function createMemoryBlobStore() {
  /** @type {Map<string, Buffer|Uint8Array>} */
  const blobs = new Map();
  return {
    /** @param {string} blobId @param {Buffer|Uint8Array} bytes */
    async save(blobId, bytes) {
      blobs.set(blobId, bytes);
    },
    /** @param {string} blobId @returns {Promise<Buffer|Uint8Array|null>} */
    async load(blobId) {
      return blobs.get(blobId) ?? null;
    },
    /** @param {string} blobId @returns {Promise<boolean>} */
    async remove(blobId) {
      return blobs.delete(blobId);
    },
  };
}
