import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { sealStrategies } from '../src/seal-strategies.js';

test('sealStrategies.none: always returns no padding, regardless of recipients/members', () => {
  const a = new Uint8Array(32).fill(1);
  const b = new Uint8Array(32).fill(2);
  assert.deepEqual(sealStrategies.none({ recipientXPubKeys: [a], memberXPubKeys: [a, b] }), []);
  assert.deepEqual(sealStrategies.none({ recipientXPubKeys: [], memberXPubKeys: [a, b] }), []);
});

test('sealStrategies.padToMembers: pads every member NOT already a recipient', () => {
  const alice = new Uint8Array(32).fill(1);
  const bob = new Uint8Array(32).fill(2);
  const carol = new Uint8Array(32).fill(3);

  const padding = sealStrategies.padToMembers({ recipientXPubKeys: [alice], memberXPubKeys: [alice, bob, carol] });
  assert.equal(padding.length, 2);
  assert.ok(padding.some((pub) => QuCrypto.toBase64(pub) === QuCrypto.toBase64(bob)));
  assert.ok(padding.some((pub) => QuCrypto.toBase64(pub) === QuCrypto.toBase64(carol)));
});

test('sealStrategies.padToMembers: an un-narrowed write (recipients already = full membership) pads nothing', () => {
  const alice = new Uint8Array(32).fill(1);
  const bob = new Uint8Array(32).fill(2);
  const padding = sealStrategies.padToMembers({ recipientXPubKeys: [alice, bob], memberXPubKeys: [alice, bob] });
  assert.deepEqual(padding, []);
});

test('sealStrategies.padToMembers: recipients matched by VALUE (base64), not by reference', () => {
  const alice = new Uint8Array(32).fill(1);
  const aliceCopy = new Uint8Array(32).fill(1); // same bytes, different Uint8Array instance.
  const bob = new Uint8Array(32).fill(2);
  const padding = sealStrategies.padToMembers({ recipientXPubKeys: [aliceCopy], memberXPubKeys: [alice, bob] });
  assert.equal(padding.length, 1);
  assert.equal(QuCrypto.toBase64(padding[0]), QuCrypto.toBase64(bob));
});
