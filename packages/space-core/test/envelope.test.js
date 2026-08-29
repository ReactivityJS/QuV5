import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { sealUpdate, verifyEnvelope, openUpdate } from '../src/envelope.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

test('sealUpdate -> verifyEnvelope -> openUpdate round-trips and never exposes plaintext in between', async () => {
  const author = await actor();
  const reader = await actor();
  const update = new TextEncoder().encode('a fake yjs update payload');

  const envelope = await sealUpdate(update, author, [reader.xPublicKey]);

  // The envelope is a plain, structurally-cloneable object - simulate it crossing a wire/disk boundary.
  const onWire = JSON.parse(JSON.stringify(envelope, (_, v) => (v instanceof Uint8Array ? { __u8: [...v] } : v)));
  const revived = JSON.parse(JSON.stringify(onWire), (_, v) => (v && v.__u8 ? new Uint8Array(v.__u8) : v));

  // Never contains the plaintext as a substring anywhere in its serialized form.
  assert.equal(JSON.stringify(onWire).includes('a fake yjs update payload'), false);

  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);
  assert.equal(await verifyEnvelope(revived, isAuthorized), true);

  const opened = await openUpdate(revived, reader);
  assert.deepEqual(opened, update);
});

test('verifyEnvelope rejects a signer not on the write-ACL', async () => {
  const author = await actor();
  const reader = await actor();
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey]);

  const isAuthorized = () => false; // nobody is authorized
  assert.equal(await verifyEnvelope(envelope, isAuthorized), false);
});

test('verifyEnvelope rejects a tampered ciphertext', async () => {
  const author = await actor();
  const reader = await actor();
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey]);
  envelope.ct[0] ^= 0xff; // flip a bit - simulates an on-the-wire/at-rest tamper attempt.

  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);
  assert.equal(await verifyEnvelope(envelope, isAuthorized), false);
});

test('openUpdate throws for a non-recipient', async () => {
  const author = await actor();
  const reader = await actor();
  const outsider = await actor();
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey]);

  await assert.rejects(() => openUpdate(envelope, outsider));
});
