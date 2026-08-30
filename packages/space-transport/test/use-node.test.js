/**
 * useNode() THROUGH A REAL RELAY — the @qu/space-transport counterpart to
 * @qu/space-core's own use-node.test.js (which only proves LOCAL storage
 * hydration). Here: no local storage at all on the reading Space, so the
 * only way it can end up with the right content is the relay's own
 * mirror-catch-up path (subscribe -> replay), reached through useNode()'s
 * lazy subscribe exactly like subscribeNode() already is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createMemoryStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '../src/index.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const noteKind = defineKind('note', { fields: { title: { shape: 'atomic' } } });

test('useNode() catches up via the relay mirror when nothing is available locally, then stays live', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, storage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(noteKind, { title: 'written before bob ever connects' });
  await waitUntil(async () => (await aliceNode.field('title').get()) === 'written before bob ever connects');

  // bob has NO local storage at all - useNode() can only succeed via the relay's mirror-catch-up.
  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  const { node: bobNode, release } = await bobSpace.useNode(aliceNode.id, noteKind);

  await waitUntil(async () => (await bobNode.field('title').get()) === 'written before bob ever connects');

  // And it stays LIVE after catch-up, not just a one-shot snapshot.
  await aliceNode.field('title').set('updated after bob caught up');
  await waitUntil(async () => (await bobNode.field('title').get()) === 'updated after bob caught up');

  release();
  assert.equal(bobSpace.getNode(aliceNode.id), undefined);
});
