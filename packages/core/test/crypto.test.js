import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '../src/crypto.js';

test('generateKeypair() returns usable Ed25519 + X25519 material', async () => {
  const kp = await QuCrypto.generateKeypair();
  assert.equal(kp.publicKey.length, 32);
  assert.equal(kp.xPublicKey.length, 32);
  assert.ok(kp.privateKey instanceof Uint8Array);
  assert.ok(kp.xPrivateKey instanceof Uint8Array);
});

test('keypairFromSeed() is deterministic - same scalar in, same public key out', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const a = await QuCrypto.keypairFromSeed('Ed25519', seed);
  const b = await QuCrypto.keypairFromSeed('Ed25519', seed);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.deepEqual(a.privateKeyPkcs8, b.privateKeyPkcs8);

  const differentSeed = crypto.getRandomValues(new Uint8Array(32));
  const c = await QuCrypto.keypairFromSeed('Ed25519', differentSeed);
  assert.notDeepEqual(a.publicKey, c.publicKey);
});

test('keypairFromSeed() rejects a scalar of the wrong length', async () => {
  await assert.rejects(() => QuCrypto.keypairFromSeed('Ed25519', new Uint8Array(31)));
  await assert.rejects(() => QuCrypto.keypairFromSeed('Ed25519', new Uint8Array(33)));
});

test('keypairFromSeed() rejects an unsupported curve', async () => {
  await assert.rejects(() => QuCrypto.keypairFromSeed('P-256', new Uint8Array(32)));
});

test('sign()/verify() round-trip, and rejects a tampered message or wrong key', async () => {
  const kp = await QuCrypto.generateKeypair();
  const data = new TextEncoder().encode('hello qu v5');
  const sig = await QuCrypto.sign(data, kp.privateKey);

  assert.equal(await QuCrypto.verify(data, sig, kp.publicKey), true);
  assert.equal(await QuCrypto.verify(new TextEncoder().encode('tampered'), sig, kp.publicKey), false);

  const other = await QuCrypto.generateKeypair();
  assert.equal(await QuCrypto.verify(data, sig, other.publicKey), false);
});

test('encrypt()/decrypt() round-trip for multiple recipients, each independently', async () => {
  const sender = await QuCrypto.generateKeypair();
  const alice = await QuCrypto.generateKeypair();
  const bob = await QuCrypto.generateKeypair();
  const plaintext = new TextEncoder().encode('secret payload');

  const { iv, ct, to } = await QuCrypto.encrypt(plaintext, [alice.xPublicKey, bob.xPublicKey], sender.xPrivateKey);
  assert.equal(to.length, 2);

  const aliceEntry = to.find((entry) => arraysEqual(entry.pub, alice.xPublicKey));
  const bobEntry = to.find((entry) => arraysEqual(entry.pub, bob.xPublicKey));

  const aliceDecrypted = await QuCrypto.decrypt(iv, ct, aliceEntry.key, sender.xPublicKey, alice.xPrivateKey);
  const bobDecrypted = await QuCrypto.decrypt(iv, ct, bobEntry.key, sender.xPublicKey, bob.xPrivateKey);

  assert.equal(new TextDecoder().decode(aliceDecrypted), 'secret payload');
  assert.equal(new TextDecoder().decode(bobDecrypted), 'secret payload');
});

test('decrypt() fails for a recipient who was not on the original recipient list', async () => {
  const sender = await QuCrypto.generateKeypair();
  const alice = await QuCrypto.generateKeypair();
  const eve = await QuCrypto.generateKeypair(); // never a recipient
  const plaintext = new TextEncoder().encode('only for alice');

  const { iv, ct, to } = await QuCrypto.encrypt(plaintext, [alice.xPublicKey], sender.xPrivateKey);
  const aliceEntry = to[0];

  // Eve has no wrapped key of her own - even attempting decrypt with Alice's
  // wrapped key under Eve's own private key must not recover the plaintext.
  await assert.rejects(() => QuCrypto.decrypt(iv, ct, aliceEntry.key, sender.xPublicKey, eve.xPrivateKey));
});

test('sha256() matches the well-known NIST test vector for "abc"', async () => {
  const digest = await QuCrypto.sha256(new TextEncoder().encode('abc'));
  assert.equal(QuCrypto.toHex(digest), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('toBase64()/fromBase64() and toBase64Url()/fromBase64Url() round-trip arbitrary bytes', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(40));
  assert.deepEqual(QuCrypto.fromBase64(QuCrypto.toBase64(bytes)), bytes);

  const url = QuCrypto.toBase64Url(bytes);
  assert.doesNotMatch(url, /[+/=]/); // URL-safe alphabet, no padding
  assert.deepEqual(QuCrypto.fromBase64Url(url), bytes);
});

test('toHex()/fromHex() round-trip, and fromHex() rejects invalid input', () => {
  const bytes = new Uint8Array([0, 1, 254, 255, 16]);
  const hex = QuCrypto.toHex(bytes);
  assert.equal(hex, '0001feff10');
  assert.deepEqual(QuCrypto.fromHex(hex), bytes);

  // Odd length must throw, not silently truncate the last nibble.
  assert.throws(() => QuCrypto.fromHex('abc'), /not valid hex/);
  // Non-hex characters must throw.
  assert.throws(() => QuCrypto.fromHex('zz'), /not valid hex/);
  // Empty string is valid hex for zero bytes.
  assert.deepEqual(QuCrypto.fromHex(''), new Uint8Array(0));
});

test('toBytes() passes a Uint8Array through unchanged', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(QuCrypto.toBytes(bytes, 'x'), bytes);
});

test('toBytes() normalizes a byte-indexed plain object (post-JSON-round-trip shape)', () => {
  const result = QuCrypto.toBytes({ 0: 10, 1: 20, 2: 30 }, 'x');
  assert.ok(result instanceof Uint8Array);
  assert.deepEqual(result, new Uint8Array([10, 20, 30]));
});

test('toBytes() throws a descriptive error (including the label) for an unusable value', () => {
  assert.throws(() => QuCrypto.toBytes(null, 'writerPub'), /"writerPub"/);
  assert.throws(() => QuCrypto.toBytes(undefined, 'writerPub'), /"writerPub"/);
  assert.throws(() => QuCrypto.toBytes('a string', 'writerPub'), /"writerPub"/);
});

test('fingerprint() is deterministic, differs between distinct keys, and is grouped hex', async () => {
  const alice = await QuCrypto.generateKeypair();
  const bob = await QuCrypto.generateKeypair();

  const fp1 = await QuCrypto.fingerprint(alice.publicKey);
  const fp2 = await QuCrypto.fingerprint(alice.publicKey);
  assert.equal(fp1, fp2); // same key -> same fingerprint every time

  const fpBob = await QuCrypto.fingerprint(bob.publicKey);
  assert.notEqual(fp1, fpBob);

  assert.match(fp1, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/); // default: 4 groups of 4 hex chars
});

test('fingerprint() honors the `groups` argument and matches a manual sha256 truncation', async () => {
  const kp = await QuCrypto.generateKeypair();
  const digest = await QuCrypto.sha256(kp.publicKey);
  const expected = QuCrypto.toHex(digest).slice(0, 8); // 2 groups = 8 hex chars

  const fp = await QuCrypto.fingerprint(kp.publicKey, 2);
  assert.equal(fp, `${expected.slice(0, 4)}-${expected.slice(4, 8)}`);
});

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
