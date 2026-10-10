/**
 * BLOB UPLOAD (client side) — `uploadToRelayBlob()` is designed to be
 * passed directly as `UploadOutbox`'s own `upload(record, blob)` callback
 * (`upload-outbox.js`): it signs the self-certifying proof
 * `@qu/space-transport`'s `relay-blob-server.js` verifies
 * (`@qu/space-core`'s `blob-auth.js`), `PUT`s the bytes to that endpoint,
 * and resolves with `{url}` - which `UploadOutbox._attempt()` then merges
 * into the record on `'done'` (see that file's own "UPDATE - UPLOAD
 * RESULT" doc comment), so `outbox.statusOf(id)`/`watch(id, ...)` see the
 * relay-hosted download URL like any other field, no separate lookup.
 *
 * This is deliberately the ONLY piece of the "relay as blob-storage
 * mirror" story that lives in `@qu/space-plugins` rather than
 * `@qu/space-transport` - the relay-side endpoint (`relay-blob-server.js`)
 * and the signed proof (`blob-auth.js`) are framework primitives any
 * caller could build a DIFFERENT client against; this file is just the
 * "glue `UploadOutbox` already expects" convenience, same layering
 * `delivery-status.js`'s `markFileReceived()` already establishes for
 * "thin, file-scoped convenience over a framework primitive."
 */
import { signBlobUpload } from '@qu/space-core';
import { QuCrypto } from '@qu/core';

/**
 * @param {import('@qu/space-core').Space} space - the SAME Space whose identity owns this blob (its `signingKey` produces the upload proof).
 * @param {string} relayHttpUrl - this Space's relay's HTTP origin (e.g. `https://relay.example.com`, no trailing slash) - the SAME host the relay's WebSocket endpoint runs on, just the `http(s)://` scheme instead of `ws(s)://`.
 * @param {string} localId - the uploader's own local id for this blob (an `UploadOutbox` file id works directly - see this file's own doc comment).
 * @param {Blob|Buffer|Uint8Array} blob - the file's raw bytes.
 * @returns {Promise<{url: string, blobId: string}>} `url` is the relay's own download URL for this blob (`GET`-able by any Space member, unauthenticated - see `relay-blob-server.js`'s own doc comment on why).
 */
export async function uploadToRelayBlob(space, relayHttpUrl, localId, blob) {
  const proof = await signBlobUpload(localId, space.identity);
  const params = new URLSearchParams({
    pub: QuCrypto.toBase64(proof.pub),
    localId: proof.localId,
    sig: QuCrypto.toBase64(proof.sig),
  });
  const uploadUrl = `${relayHttpUrl}/blob/${proof.blobId}?${params}`;
  const res = await fetch(uploadUrl, { method: 'PUT', body: blob });
  if (!res.ok) throw new Error(`uploadToRelayBlob: relay rejected the upload (${res.status} ${await res.text().catch(() => '')})`);
  return { url: `${relayHttpUrl}/blob/${proof.blobId}`, blobId: proof.blobId };
}
