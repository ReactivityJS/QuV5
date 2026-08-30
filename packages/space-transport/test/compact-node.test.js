/**
 * COMPACTION THROUGH A REAL RELAY — the storage-purge half of Task 7's own
 * proof: a relay's mirror actually SHRINKS to one envelope after
 * `Space.compactNode()`, and a brand-new peer who catches up AFTER
 * compaction (with zero prior history) reconstructs the CURRENT, correct
 * state straight from that one envelope - including correctly NOT seeing
 * content that was deleted before the snapshot was taken, proving the old
 * envelope (the only place that deleted content's ciphertext ever lived)
 * is genuinely gone, not just superseded.
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

const noteKind = defineKind('note', { fields: { body: { shape: 'text' } } });

test("compactNode() shrinks the relay's mirror to one envelope, and a late joiner with NO prior history catches up correctly - including never seeing content deleted before the snapshot", async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const relayMirror = createMemoryStore();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, storage: relayMirror });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const node = await aliceSpace.createNode(noteKind, {});
  node.field('body').insert(0, 'a secret draft, later retracted');
  await waitUntil(async () => (await relayMirror.load(node.id)).length >= 2); // meta-stamp + insert, mirrored.

  node.field('body').delete(0, node.field('body').get().length);
  node.field('body').insert(0, 'the final, public version');
  await waitUntil(async () => node.field('body').get() === 'the final, public version');
  await waitUntil(async () => (await relayMirror.load(node.id)).length >= 4); // both edits mirrored too.

  await aliceSpace.compactNode(node.id);
  await waitUntil(async () => (await relayMirror.load(node.id)).length === 1);
  const [snapshotEnvelope] = await relayMirror.load(node.id);
  assert.equal(snapshotEnvelope.snapshot, true);

  // bob joins AFTER compaction, with zero prior history of his own - the relay's mirror now holds
  // ONLY the snapshot, so this is the only thing he could possibly reconstruct from.
  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  const bobNode = bobSpace.subscribeNode(node.id, noteKind);

  await waitUntil(() => bobNode.field('body').get() === 'the final, public version');
  assert.equal(bobNode.field('body').get(), 'the final, public version');
  assert.equal(bobNode.field('body').get().includes('secret draft'), false); // the retracted draft is unreachable - its only envelope no longer exists anywhere.
});
