/**
 * BLOB UPLOAD AUTHORIZATION — see blob-auth.js's own doc comment. Proves
 * the self-certifying id derivation and the recompute-and-compare
 * verification `relay-blob-server.js` (@qu/space-transport) relies on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { deriveBlobId, signBlobUpload, verifyBlobUpload } from '../src/blob-auth.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey };
}

test('deriveBlobId() is deterministic and depends on BOTH ownerPub and localId', async () => {
  const alice = await actor();
  const bob = await actor();
  assert.equal(await deriveBlobId(alice.signingPub, 'file-1'), await deriveBlobId(alice.signingPub, 'file-1'));
  assert.notEqual(await deriveBlobId(alice.signingPub, 'file-1'), await deriveBlobId(alice.signingPub, 'file-2'));
  assert.notEqual(await deriveBlobId(alice.signingPub, 'file-1'), await deriveBlobId(bob.signingPub, 'file-1'));
  assert.ok((await deriveBlobId(alice.signingPub, 'file-1')).startsWith('blob-'));
});

test('signBlobUpload()/verifyBlobUpload() round-trip: a genuine proof verifies', async () => {
  const alice = await actor();
  const proof = await signBlobUpload('file-1', alice);
  assert.equal(proof.blobId, await deriveBlobId(alice.signingPub, 'file-1'));
  assert.equal(await verifyBlobUpload(proof), true);
});

test('verifyBlobUpload() rejects a blobId that does not derive from the claimed (pub, localId)', async () => {
  const alice = await actor();
  const bob = await actor();
  const proof = await signBlobUpload('file-1', alice);
  // Bob tries to claim alice's blobId (e.g. to overwrite her upload) - his own localId derives a
  // DIFFERENT blobId, so a claim carrying alice's blobId alongside bob's own signature is caught by
  // the recompute-and-compare check before the signature is even checked.
  assert.equal(await verifyBlobUpload({ ...proof, pub: bob.signingPub, sig: (await signBlobUpload('file-1', bob)).sig }), false);
});

test('verifyBlobUpload() rejects a forged signature (well-formed but wrong key)', async () => {
  const alice = await actor();
  const mallory = await actor();
  const proof = await signBlobUpload('file-1', alice);
  const forged = { ...proof, sig: (await signBlobUpload('file-1', mallory)).sig }; // mallory's own valid sig, over HER localId/blobId, spliced onto alice's claim.
  assert.equal(await verifyBlobUpload(forged), false);
});

test('verifyBlobUpload() rejects malformed/incomplete input without throwing', async () => {
  assert.equal(await verifyBlobUpload({}), false);
  assert.equal(await verifyBlobUpload(null), false);
  const alice = await actor();
  const proof = await signBlobUpload('file-1', alice);
  assert.equal(await verifyBlobUpload({ ...proof, localId: undefined }), false);
});
