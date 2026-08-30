/**
 * useNode() — the local-first, lazy, reference-counted query entrypoint
 * (see space.js's own doc comment). Proves, independent of
 * @qu/space-transport entirely (a no-op fake transport is enough - these
 * are pure Space-level behaviors):
 *   1. Local-first: a Node already durably stored locally hydrates from
 *      storage alone, with no transport delivery involved at all.
 *   2. Lazy + idempotent: calling useNode() twice for the same id does
 *      not re-subscribe or re-hydrate - the second call is a plain lookup.
 *   3. Reference-counted release: the underlying Node stays subscribed
 *      until every caller that used it has released it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { Space } from '../src/space.js';
import { createMemoryStore } from '@qu/space-storage';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

/** A transport that records every message sent but never delivers anything back - isolates useNode()'s LOCAL hydration behavior from any network/relay concern. */
function silentTransport() {
  const sent = [];
  return {
    sent,
    async connect() {},
    send(data) {
      sent.push(data);
    },
    onMessage() {},
  };
}

const noteKind = defineKind('note', { fields: { title: { shape: 'atomic', visibility: 'public' } } });

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('useNode() hydrates from LOCAL storage alone - no transport delivery needed', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const storage = createMemoryStore();

  // First Space instance: writes locally (with storage mounted) and disappears - simulates an
  // earlier session/tab that already persisted this Node before this test's real Space exists.
  const writerSpace = new Space({ identity: alice, members, transport: silentTransport(), storage });
  const originalNode = await writerSpace.createNode(noteKind, { title: 'from a previous session' });
  // storage.append() is fire-and-forget from _handleLocalUpdate()'s point of view (same as every
  // other write path in this codebase - see space.js's own doc comment) - wait for it to actually
  // land before simulating "a later session starts up and finds it already there."
  await waitUntil(async () => (await storage.load(originalNode.id)).length >= 2); // meta-stamp + title

  // A brand-new Space, same storage, a transport that NEVER delivers anything - if useNode()
  // reads the title, it can only have come from `storage`, not from any sync.
  const readerSpace = new Space({ identity: alice, members, transport: silentTransport(), storage });
  const { node } = await readerSpace.useNode(originalNode.id, noteKind);

  assert.equal(await node.field('title').get(), 'from a previous session');
});

test('useNode() called twice for the same id does not re-subscribe - the second call is a plain, instant lookup', async () => {
  const alice = await actor();
  const transport = silentTransport();
  const space = new Space({ identity: alice, members: [], transport });

  const { node: node1 } = await space.useNode('some-node', noteKind);
  const subscribeCountAfterFirst = transport.sent.filter((m) => m.type === 'subscribe').length;
  assert.equal(subscribeCountAfterFirst, 1);

  const { node: node2 } = await space.useNode('some-node', noteKind);
  assert.equal(transport.sent.filter((m) => m.type === 'subscribe').length, 1); // still 1 - no duplicate subscribe request.
  assert.equal(node1, node2); // the SAME handle, not a fresh one.
});

test('useNode()/release() is reference-counted: the Node stays subscribed until the LAST releaser lets go', async () => {
  const alice = await actor();
  const transport = silentTransport();
  const space = new Space({ identity: alice, members: [], transport });

  const handle1 = await space.useNode('shared-node', noteKind);
  const handle2 = await space.useNode('shared-node', noteKind);

  handle1.release();
  assert.equal(space.getNode('shared-node'), handle2.node); // still attached - handle2 still holds a reference.
  assert.equal(transport.sent.some((m) => m.type === 'unsubscribe'), false);

  handle2.release();
  assert.equal(space.getNode('shared-node'), undefined); // now actually released - synchronous, unlike the unsubscribe message itself (release() doesn't await unsubscribeNode()'s own sign()+send()).
  await waitUntil(() => transport.sent.some((m) => m.type === 'unsubscribe' && m.nodeId === 'shared-node'));
});

test('after a full release, calling useNode() again for the same id starts completely fresh (re-subscribes)', async () => {
  const alice = await actor();
  const transport = silentTransport();
  const space = new Space({ identity: alice, members: [], transport });

  const handle1 = await space.useNode('node-x', noteKind);
  handle1.release();
  assert.equal(space.getNode('node-x'), undefined);

  const handle2 = await space.useNode('node-x', noteKind);
  assert.notEqual(handle2.node, handle1.node); // a genuinely new handle.
  const subscribeMessages = transport.sent.filter((m) => m.type === 'subscribe' && m.nodeId === 'node-x');
  assert.equal(subscribeMessages.length, 2); // one for each useNode() call - the release in between really reset things.
});
