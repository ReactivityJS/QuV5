/**
 * BLOB FILE STORE — real, on-disk persistence for raw file bytes (a
 * `Buffer`/`Uint8Array`, opaque to this adapter), the counterpart to
 * `file-store.js`'s own envelope mirror but for `@qu/space-transport`'s
 * `relay-blob-server.js` (which mirrors an `UploadOutbox` upload's actual
 * BYTES, not structured CRDT data - see that file's own doc comment on why
 * blobs need a separate mirror path at all). One `<blobId>.bin` file per
 * blob under `dataDir`, `blobId` already a self-certifying id
 * (`@qu/space-core`'s `blob-auth.js`) - `encodeURIComponent` here is
 * defense in depth, not the actual authorization boundary.
 *
 * Deliberately WRITE-ONCE-per-id in the common case (a blob's bytes never
 * change once uploaded - `UploadOutbox` re-derives a NEW `localId`/`blobId`
 * for a genuinely different file), but this adapter does not itself
 * enforce that - a second `save()` for the same `blobId` simply overwrites,
 * same "idempotent re-upload is harmless" posture `blob-auth.js`'s own doc
 * comment already establishes for its lack of a `ts`/replay guard.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {string} dataDir - Directory to store one `<blobId>.bin` file per blob in. Created if missing. */
export function createBlobFileStore(dataDir) {
  function fileFor(blobId) {
    return join(dataDir, `${encodeURIComponent(blobId)}.bin`);
  }

  return {
    /** @param {string} blobId @param {Buffer|Uint8Array} bytes */
    async save(blobId, bytes) {
      await mkdir(dataDir, { recursive: true });
      await writeFile(fileFor(blobId), bytes);
    },

    /** @param {string} blobId @returns {Promise<Buffer|null>} `null` if never uploaded. */
    async load(blobId) {
      try {
        return await readFile(fileFor(blobId));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    /** @param {string} blobId @returns {Promise<boolean>} `true` if a blob was actually removed. */
    async remove(blobId) {
      try {
        await unlink(fileFor(blobId));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },
  };
}
