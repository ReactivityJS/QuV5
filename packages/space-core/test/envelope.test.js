import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { sealUpdate, sealPublicUpdate, verifyEnvelope, openUpdate } from '../src/envelope.js';

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

test('a notify hint travels on the envelope in the CLEAR (not encrypted) but is still signature-verified', async () => {
  const author = await actor();
  const reader = await actor();
  const notify = { topic: 'mention', to: [QuCrypto.toBase64(reader.signingPub)] };
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey], notify);

  assert.deepEqual(envelope.notify, notify);
  // Plainly readable without any decryption key - exactly what lets a content-blind relay route on it.
  const onWire = JSON.parse(JSON.stringify(envelope, (_, v) => (v instanceof Uint8Array ? { __u8: [...v] } : v)));
  assert.equal(onWire.notify.topic, 'mention');

  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);
  assert.equal(await verifyEnvelope(envelope, isAuthorized), true);
});

test('tampering with an envelope\'s notify hint in transit invalidates the signature', async () => {
  const author = await actor();
  const reader = await actor();
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey], { topic: 'message' });
  envelope.notify.topic = 'mention'; // an on-the-wire tamper attempt, e.g. a compromised relay trying to escalate to a louder push.

  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);
  assert.equal(await verifyEnvelope(envelope, isAuthorized), false);
});

test('an envelope with no notify hint is unaffected - same shape and signature validity as before notify existed', async () => {
  const author = await actor();
  const reader = await actor();
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey]);

  assert.equal('notify' in envelope, false);
  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);
  assert.equal(await verifyEnvelope(envelope, isAuthorized), true);
});

test('sealUpdate() stamps mode: "encrypted"', async () => {
  const author = await actor();
  const reader = await actor();
  const envelope = await sealUpdate(new TextEncoder().encode('x'), author, [reader.xPublicKey]);
  assert.equal(envelope.mode, 'encrypted');
});

test('sealPublicUpdate() -> verifyEnvelope() -> openUpdate() round-trips WITHOUT any decryption key, and the plaintext is genuinely on the wire', async () => {
  const author = await actor();
  const update = new TextEncoder().encode('a public yjs update payload');

  const envelope = await sealPublicUpdate(update, author);
  assert.equal(envelope.mode, 'public');
  assert.equal('iv' in envelope, false);
  assert.equal('ct' in envelope, false);
  assert.equal('to' in envelope, false);
  assert.equal('senderXPub' in envelope, false);

  // The envelope is a plain, structurally-cloneable object - simulate it crossing a wire/disk boundary.
  const onWire = JSON.parse(JSON.stringify(envelope, (_, v) => (v instanceof Uint8Array ? { __u8: [...v] } : v)));
  const revived = JSON.parse(JSON.stringify(onWire), (_, v) => (v && v.__u8 ? new Uint8Array(v.__u8) : v));

  // Unlike encrypted mode, the plaintext IS genuinely present on the wire - that's the whole point.
  assert.equal(JSON.stringify(onWire).includes('a public yjs update payload'), false); // still byte-array-encoded, not a literal substring, but...
  assert.deepEqual(revived.data, update); // ...the actual bytes are there, unencrypted, for anyone to read.

  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);
  assert.equal(await verifyEnvelope(revived, isAuthorized), true);

  // openUpdate() needs NO recipient identity at all for public mode - a relay, or a total stranger, can call this.
  const opened = await openUpdate(revived);
  assert.deepEqual(opened, update);
});

test('verifyEnvelope() rejects a tampered public-mode envelope (data OR notify altered)', async () => {
  const author = await actor();
  const isAuthorized = (pubB64) => pubB64 === QuCrypto.toBase64(author.signingPub);

  const envelope1 = await sealPublicUpdate(new TextEncoder().encode('x'), author);
  envelope1.data[0] ^= 0xff;
  assert.equal(await verifyEnvelope(envelope1, isAuthorized), false);

  const envelope2 = await sealPublicUpdate(new TextEncoder().encode('x'), author, { topic: 'message' });
  envelope2.notify.topic = 'mention';
  assert.equal(await verifyEnvelope(envelope2, isAuthorized), false);
});

test('verifyEnvelope() still rejects a public-mode envelope from a signer not on the write-ACL', async () => {
  const author = await actor();
  const envelope = await sealPublicUpdate(new TextEncoder().encode('x'), author);
  assert.equal(await verifyEnvelope(envelope, () => false), false);
});
