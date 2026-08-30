/**
 * PERSISTENCE TIERS (relay side) — proves createRelayForwarder() mirrors a
 * `persistence: 'volatile'` Kind's writes into `volatileStorage`, never
 * `storage`, and replays subscribe catch-up from the SAME tier the write
 * was mirrored into - see relay.js's own "PERSISTENCE TIERS" doc comment.
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

const durableKind = defineKind('durable-relay-thing', { fields: { title: { shape: 'atomic' } } });
const volatileKind = defineKind('volatile-relay-thing', { fields: { title: { shape: 'atomic' } }, persistence: 'volatile' });

test('a relay mirrors a volatile Kind into volatileStorage, never the durable storage adapter', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const durableStorage = createMemoryStore();
  const volatileStorage = createMemoryStore();
  const hub = createInProcessHub();
  createRelayForwarder({
    hub,
    members,
    resolveKindSchema: (nodeId) => (nodeId === 'v-1' ? volatileKind : durableKind),
    storage: durableStorage,
    volatileStorage,
  });

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  const space = new Space({ identity: alice, members, transport });
  await space.createNode(durableKind, { title: 'd' }, { id: 'd-1' });
  await space.createNode(volatileKind, { title: 'v' }, { id: 'v-1' });

  await waitUntil(async () => (await durableStorage.load('d-1')).length > 0);
  await waitUntil(async () => (await volatileStorage.load('v-1')).length > 0);
  assert.equal((await durableStorage.load('v-1')).length, 0);
  assert.equal((await volatileStorage.load('d-1')).length, 0);
});

test('a late subscriber to a volatile Node still gets catch-up from volatileStorage', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => volatileKind, storage: null, volatileStorage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  await aliceSpace.createNode(volatileKind, { title: 'first' }, { id: 'v-late' });
  await new Promise((resolve) => setTimeout(resolve, 30)); // let alice's write land in the relay's volatile mirror before bob ever subscribes.

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  const bobNode = bobSpace.subscribeNode('v-late', volatileKind); // bob never saw alice's write live - only the relay's volatile mirror has it.

  await waitUntil(async () => (await bobNode.field('title').get()) === 'first');
});

test('omitting volatileStorage on the relay still works - a private default in-memory mirror is used', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => volatileKind }); // no storage, no volatileStorage.

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  const space = new Space({ identity: alice, members, transport });
  const node = await space.createNode(volatileKind, { title: 'ok' }, { id: 'v-default' });
  assert.equal(await node.field('title').get(), 'ok'); // just proving construction/writes don't blow up with zero storage config anywhere.
});
