/**
 * Space.compactNode() — end-to-end proof (no relay needed, same bare
 * peer<->peer harness as acl.test.js) that compaction actually PRUNES
 * storage down to one envelope while every reader still converges on the
 * exact same content, encrypted or public.
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

function pairTransports() {
  let aOnMessage = null;
  let bOnMessage = null;
  const a = {
    async connect() {},
    send(data) {
      queueMicrotask(() => bOnMessage?.({ data }));
    },
    onMessage(cb) {
      aOnMessage = cb;
    },
  };
  const b = {
    async connect() {},
    send(data) {
      queueMicrotask(() => aOnMessage?.({ data }));
    },
    onMessage(cb) {
      bOnMessage = cb;
    },
  };
  return [a, b];
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const chatKind = defineKind('chat', { fields: { messages: { shape: 'list' } } });

test('compactNode() collapses a multi-envelope log down to one snapshot envelope in local storage, content unchanged', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const storage = createMemoryStore();
  const aliceSpace = new Space({ identity: alice, members, transport: pairTransports()[0], storage });

  const node = await aliceSpace.createNode(chatKind, {});
  await node.field('messages').push('one');
  await node.field('messages').push('two');
  await node.field('messages').push('three');
  // storage.append() is fire-and-forget from _handleLocalUpdate()'s point of view (same as every
  // other write path in this codebase) - wait for it to actually land before checking the count.
  await waitUntil(async () => (await storage.load(node.id)).length >= 4); // meta-stamp + 3 pushes, at minimum.
  const beforeCount = (await storage.load(node.id)).length;

  await aliceSpace.compactNode(node.id);

  const afterEnvelopes = await storage.load(node.id);
  assert.equal(afterEnvelopes.length, 1);
  assert.equal(afterEnvelopes[0].snapshot, true);

  // The Node's own live doc is untouched - compaction only affects storage, never the in-memory content.
  assert.deepEqual(await node.field('messages').toArray(), ['one', 'two', 'three']);

  // A completely fresh Space loading ONLY from the compacted storage still reconstructs everything.
  const reloadedSpace = new Space({ identity: alice, members, transport: pairTransports()[0], storage });
  const reloaded = await reloadedSpace.loadNode(node.id, chatKind);
  assert.deepEqual(await reloaded.field('messages').toArray(), ['one', 'two', 'three']);
});

test("a peer who receives the compaction snapshot LIVE also has its own storage pruned down to one envelope", async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceStorage = createMemoryStore();
  const bobStorage = createMemoryStore();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, storage: aliceStorage });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, storage: bobStorage });

  const bobNode = bobSpace.subscribeNode('shared-chat', chatKind);
  const aliceNode = await aliceSpace.createNode(chatKind, {}, { id: 'shared-chat' });
  await aliceNode.field('messages').push('one');
  await aliceNode.field('messages').push('two');
  await waitUntil(async () => (await bobNode.field('messages').toArray()).length === 2);
  await waitUntil(async () => (await bobStorage.load('shared-chat')).length >= 3); // bob's own storage caught up with everything so far.

  await aliceSpace.compactNode('shared-chat');
  await waitUntil(async () => (await bobStorage.load('shared-chat')).length === 1);

  const bobEnvelopes = await bobStorage.load('shared-chat');
  assert.equal(bobEnvelopes[0].snapshot, true);
  assert.deepEqual(await bobNode.field('messages').toArray(), ['one', 'two']); // content unaffected by the compaction.
});

test('compactNode() throws for a Kind that mixes visibilities across fields, rather than silently picking one', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const mixedKind = defineKind('profile', {
    fields: {
      alias: { shape: 'atomic', visibility: 'public' },
      bio: { shape: 'atomic', visibility: 'encrypted' },
    },
  });
  const aliceSpace = new Space({ identity: alice, members, transport: pairTransports()[0] });
  const node = await aliceSpace.createNode(mixedKind, { alias: 'a', bio: 'b' });

  await assert.rejects(() => aliceSpace.compactNode(node.id), /mixes visibilities/);
});

test("a compacted 'public'-visibility Node's snapshot is still plaintext on the wire/in storage - compaction doesn't change WHO can read it", async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  // acl.write: 'owner' (not the default 'members') so metaVisibility is ALSO 'public' (see
  // kind-schema.js) - matching the field's own visibility, which compactNode() requires (a
  // 'members'-mode Kind's meta is ALWAYS 'encrypted', so it can only ever be compacted whole if
  // every field is too - see compactNode()'s own doc comment on this real, accepted boundary).
  const publicKind = defineKind('blog', { fields: { body: { shape: 'text', visibility: 'public' } }, acl: { write: 'owner' } });
  const storage = createMemoryStore();
  const aliceSpace = new Space({ identity: alice, members, transport: pairTransports()[0], storage });
  const node = await aliceSpace.createNode(publicKind, {});
  node.field('body').insert(0, 'a public post');

  await aliceSpace.compactNode(node.id);
  const [snapshotEnvelope] = await storage.load(node.id);
  assert.equal(snapshotEnvelope.mode, 'public');
  assert.equal(snapshotEnvelope.snapshot, true);
  assert.equal('iv' in snapshotEnvelope, false); // still no ciphertext at all - genuinely public, exactly like before compaction.
});
