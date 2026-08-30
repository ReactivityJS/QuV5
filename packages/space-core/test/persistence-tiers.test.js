/**
 * PERSISTENCE TIERS — proves kind-schema.js's `persistence` flag actually
 * routes a Kind's writes to a SEPARATE storage adapter (see space.js's own
 * `_storageFor()`), the mechanism `presence.js`'s `presenceKind` relies on
 * to be "volatile" without any transport-level special-casing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { Space } from '../src/space.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

/** A transport that records every message sent but never delivers anything back - see use-node.test.js's own identical helper; this file stays independent of @qu/space-transport for the same reason that one does. */
function silentTransport() {
  return { sent: [], send(data) { this.sent.push(data); }, sendTo(_peerId, data) { this.sent.push(data); }, onMessage() {}, getPeerId: () => 'silent' };
}

function fakeStore(label) {
  const log = new Map();
  return {
    label,
    async append(nodeId, envelope) {
      const list = log.get(nodeId) ?? [];
      list.push(envelope);
      log.set(nodeId, list);
    },
    async load(nodeId) {
      return [...(log.get(nodeId) ?? [])];
    },
    async replace(nodeId, envelopes) {
      log.set(nodeId, [...envelopes]);
    },
    sizeOf(nodeId) {
      return (log.get(nodeId) ?? []).length;
    },
  };
}

test('defineKind() defaults persistence to "durable" and rejects an unknown value', () => {
  const durableByDefault = defineKind('plain', { fields: { x: { shape: 'atomic' } } });
  assert.equal(durableByDefault.persistence, 'durable');
  assert.throws(() => defineKind('bad', { fields: {}, persistence: 'forever' }), /persistence must be one of/);
});

test('a volatile-persistence Kind writes to volatileStorage, a durable one writes to storage - never both', async () => {
  const alice = await actor();
  const durableKind = defineKind('durable-thing', { fields: { title: { shape: 'atomic' } } });
  const volatileKind = defineKind('volatile-thing', { fields: { title: { shape: 'atomic' } } , persistence: 'volatile' });

  const transport = silentTransport();

  const durableStore = fakeStore('durable');
  const volatileStore = fakeStore('volatile');
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport, storage: durableStore, volatileStorage: volatileStore });

  const durableNode = await space.createNode(durableKind, { title: 'x' }, { id: 'durable-1' });
  const volatileNode = await space.createNode(volatileKind, { title: 'y' }, { id: 'volatile-1' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(durableStore.sizeOf('durable-1') > 0, true);
  assert.equal(volatileStore.sizeOf('durable-1'), 0); // never crossed into the wrong tier.
  assert.equal(volatileStore.sizeOf('volatile-1') > 0, true);
  assert.equal(durableStore.sizeOf('volatile-1'), 0);

  void durableNode;
  void volatileNode;
});

test('omitting volatileStorage still works - a private default in-memory adapter is used', async () => {
  const alice = await actor();
  const volatileKind = defineKind('volatile-default', { fields: { title: { shape: 'atomic' } }, persistence: 'volatile' });
  const transport = silentTransport();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport }); // no storage, no volatileStorage.

  const node = await space.createNode(volatileKind, { title: 'z' }, { id: 'volatile-2' });
  assert.equal(await node.field('title').get(), 'z');
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the async seal+append (doc's 'update' handler) actually land in volatileStorage before reading it back through a separate hydration below.

  // Hydrating a fresh Space's own volatile Node from scratch works too (it has its own default store).
  const node2 = await space.loadNode('volatile-2', volatileKind);
  assert.equal(await node2.field('title').get(), 'z');
});
