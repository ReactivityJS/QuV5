/**
 * BLOB UPLOAD AUTHORIZATION — a signed, self-certifying proof that lets a
 * RELAY accept a raw file upload (see `@qu/space-transport`'s
 * `relay-blob-server.js`) without any prior registry of "who owns which
 * blob id," the same "recompute the id, compare, then verify the
 * signature" shape `grant.js`'s own `verifyGrant()` already uses for
 * `'content'`-ACL Nodes (that file's own doc comment).
 *
 * WHY THIS EXISTS: a relay mirrors STRUCTURED CRDT data via signed
 * envelopes it already knows how to verify (`envelope.js`) - raw file
 * bytes are a poor fit for that (see `@qu/space-plugins`'s
 * `upload-outbox.js`'s own top doc comment on why a Yjs update history has
 * no notion of "replace/discard the old bytes"), so mirroring them needs a
 * SEPARATE, purpose-built upload path with its OWN authorization proof -
 * this file is that proof, `relay-blob-server.js` is where it's enforced.
 *
 * `blobId` is a pure function of `(ownerPub, localId)` - `localId` is
 * whatever the uploader already uses to name this blob locally (e.g.
 * `@qu/space-plugins`'s `UploadOutbox` file id), never itself trusted or
 * interpreted by a relay. Anyone who knows an owner's pubkey and their own
 * chosen `localId` can compute the exact same `blobId` - no relay
 * round-trip needed to find out "what id would this upload get." A relay
 * verifying an upload recomputes `blobId` from the claimed `(pub, localId)`
 * and REJECTS if it doesn't match the URL path the request was made
 * against, exactly closing the same "prove the claim is self-consistent,
 * not just authentically signed" gap `verifyGrant()`'s own doc comment
 * describes for `'content'`-ACL Nodes.
 *
 * No `ts`/replay-window here, unlike `group-membership.js`/
 * `presence-visibility.js`'s own declarations - those matter because they
 * REPLACE a relay's standing view of a fact over time (membership,
 * visibility) where a REORDERED delivery could regress it. An upload has
 * no such "current state to regress" - re-uploading the SAME bytes to the
 * SAME self-certifying `blobId` is simply idempotent, and a DIFFERENT
 * upload to that id is a deliberate overwrite by its own rightful owner
 * (only whoever holds the signing key for `pub` can ever produce a valid
 * proof for `blobId`s derived from it) - same posture `signGrant()`'s own
 * lack of a `ts` already takes.
 */
import { QuCrypto } from '@qu/core';

const BLOB_ID_PREFIX = 'blob-';

function encodeBlobUpload(ownerPub, localId) {
  return new TextEncoder().encode(`qu-blob-upload-v1:${QuCrypto.toBase64(ownerPub)}:${localId}`);
}

/**
 * The self-certifying blob id for `(ownerPub, localId)` - pure function, no relay/registry needed.
 * @param {Uint8Array} ownerPub
 * @param {string} localId
 * @returns {Promise<string>}
 */
export async function deriveBlobId(ownerPub, localId) {
  if (!localId || typeof localId !== 'string') throw new Error('deriveBlobId: "localId" must be a non-empty string');
  const digest = await QuCrypto.sha256(new TextEncoder().encode(`qu-blob-v1:${QuCrypto.toBase64(ownerPub)}:${localId}`));
  return BLOB_ID_PREFIX + QuCrypto.toBase64Url(digest);
}

/**
 * @param {string} localId - the uploader's own local id for this blob (e.g. an `UploadOutbox` file id).
 * @param {{signingKey: Uint8Array, signingPub: Uint8Array}} owner
 * @returns {Promise<{blobId: string, pub: Uint8Array, localId: string, sig: Uint8Array}>} ready to send to `relay-blob-server.js`'s upload endpoint.
 */
export async function signBlobUpload(localId, owner) {
  const blobId = await deriveBlobId(owner.signingPub, localId);
  const sig = await QuCrypto.sign(encodeBlobUpload(owner.signingPub, localId), owner.signingKey);
  return { blobId, pub: owner.signingPub, localId, sig };
}

/**
 * Verifies an upload's `{blobId, pub, localId, sig}` proof - BOTH that `blobId` genuinely derives
 * from `(pub, localId)` AND that `sig` is authentic for that exact pair. Returns `false` for
 * anything malformed, forged, or self-inconsistent; never throws.
 * @param {{blobId: string, pub: Uint8Array, localId: string, sig: Uint8Array}} params
 * @returns {Promise<boolean>}
 */
export async function verifyBlobUpload(message) {
  const { blobId, pub, localId, sig } = message ?? {};
  if (!blobId || !pub || !localId || !sig) return false;
  const expectedBlobId = await deriveBlobId(pub, localId);
  if (expectedBlobId !== blobId) return false;
  return QuCrypto.verify(encodeBlobUpload(pub, localId), sig, pub);
}
