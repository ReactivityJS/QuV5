import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { deriveContentNodeId } from '../src/content-id.js';

test('deriveContentNodeId() is a pure, deterministic function of (ownerPub, kind, path)', async () => {
  const kp = await QuCrypto.generateKeypair();
  const id1 = await deriveContentNodeId(kp.publicKey, 'qu-page', '/hello');
  const id2 = await deriveContentNodeId(kp.publicKey, 'qu-page', '/hello');
  assert.equal(id1, id2);
});

test('deriveContentNodeId() differs by kind, by path, and by owner', async () => {
  const alice = await QuCrypto.generateKeypair();
  const bob = await QuCrypto.generateKeypair();
  const base = await deriveContentNodeId(alice.publicKey, 'qu-page', '/hello');

  assert.notEqual(await deriveContentNodeId(alice.publicKey, 'qu-template', '/hello'), base);
  assert.notEqual(await deriveContentNodeId(alice.publicKey, 'qu-page', '/other'), base);
  assert.notEqual(await deriveContentNodeId(bob.publicKey, 'qu-page', '/hello'), base);
});

test('deriveContentNodeId() rejects an empty path', async () => {
  const kp = await QuCrypto.generateKeypair();
  await assert.rejects(() => deriveContentNodeId(kp.publicKey, 'qu-page', ''));
});
