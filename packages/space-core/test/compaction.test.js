/**
 * `Space.envelopeCount()` / `compactIfNeeded()` — the OPT-IN compaction
 * policy layer built on top of `Space.compactNode()` (see `compact-node.test.js`
 * for the underlying primitive itself, unchanged by this) - proves the
 * threshold check actually triggers compaction once crossed, stays a
 * no-op below it, and is a safe no-op with no storage adapter mounted at
 * all (never throws just because there's nothing to count).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { Space } from '../src/space.js';
import { compactIfNeeded } from '../src/compaction.js';
import { createMemoryStore } from '@qu/space-storage';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function pairTransports() {
  let aOnMessage = null;
  const a = {
    async connect() {},
    send(data) {
      queueMicrotask(() => aOnMessage?.({ data }));
    },
    onMessage(cb) {
      aOnMessage = cb;
    },
  };
  return [a];
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

test('envelopeCount() reports the storage-backed count, null with no storage adapter mounted', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const storage = createMemoryStore();
  const withStorage = new Space({ identity: alice, members, transport: pairTransports()[0], storage });
  const withoutStorage = new Space({ identity: alice, members, transport: pairTransports()[0] });

  const nodeWithStorage = await withStorage.createNode(chatKind, {});
  await nodeWithStorage.field('messages').push('one');
  await waitUntil(async () => (await withStorage.envelopeCount(nodeWithStorage.id)) >= 2); // meta + push

  const nodeWithoutStorage = await withoutStorage.createNode(chatKind, {});
  assert.equal(await withoutStorage.envelopeCount(nodeWithoutStorage.id), null);
  assert.equal(await withStorage.envelopeCount('never-attached'), null);
});

test('compactIfNeeded() is a no-op below the threshold', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const storage = createMemoryStore();
  const space = new Space({ identity: alice, members, transport: pairTransports()[0], storage });
  const node = await space.createNode(chatKind, {});
  await node.field('messages').push('one');
  await waitUntil(async () => (await storage.load(node.id)).length >= 2);

  await compactIfNeeded(space, node.id, { threshold: 500 });

  const envelopes = await storage.load(node.id);
  assert.ok(envelopes.length > 1, 'no compaction happened - still below the threshold');
  assert.equal(envelopes.some((e) => e.snapshot), false);
});

test('compactIfNeeded() compacts once the threshold is exceeded, content unchanged', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const storage = createMemoryStore();
  const space = new Space({ identity: alice, members, transport: pairTransports()[0], storage });
  const node = await space.createNode(chatKind, {});
  for (let i = 0; i < 5; i++) await node.field('messages').push(`msg-${i}`);
  await waitUntil(async () => (await storage.load(node.id)).length >= 6); // meta + 5 pushes

  await compactIfNeeded(space, node.id, { threshold: 3 });

  const envelopes = await storage.load(node.id);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].snapshot, true);
  assert.deepEqual(
    await node.field('messages').toArray(),
    Array.from({ length: 5 }, (_, i) => `msg-${i}`)
  );
});

test('compactIfNeeded() with no storage adapter mounted is a silent no-op, never throws', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const space = new Space({ identity: alice, members, transport: pairTransports()[0] });
  const node = await space.createNode(chatKind, {});
  await node.field('messages').push('one');

  await compactIfNeeded(space, node.id, { threshold: 0 }); // would trigger immediately IF envelopeCount() returned anything
});
