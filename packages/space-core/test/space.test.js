import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { Space } from '../src/space.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

/** Two directly-connected fake transports (peer <-> peer, no relay) - all this test needs to prove Space's own bus-emission logic, independent of @qu/space-transport. */
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

/** A minimal EventBus double: just records every emit() call, in order. Space only ever calls bus.emit(), so this is all a test of Space's OWN emission logic needs (the real EventBus has its own full test suite in @qu/events). */
function recordingBus() {
  const calls = [];
  return { calls, emit: async (topic, payload) => calls.push({ topic, payload }) };
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const chatKind = defineKind('chat', { fields: { messages: 'list' }, notifyTopics: ['message', 'mention'] });

test('a local write with no notify hint emits ONLY the generic space.node.<id>.changed event', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const bus = recordingBus();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus });

  const node = await space.createNode(chatKind, {}, { id: 'room-1' });
  await node.field('messages').push('hi');

  await waitUntil(() => bus.calls.some((c) => c.topic === 'space.node.room-1.changed'));
  assert.equal(bus.calls.every((c) => !c.topic.startsWith('notification.')), true);
});

test('a local write WITH a notify hint emits both space.node.<id>.changed AND notification.<kind>.<topic>', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const bus = recordingBus();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus });

  const node = await space.createNode(chatKind, {}, { id: 'room-2' });
  await node.field('messages').push('@bob hi', { notify: { topic: 'mention', to: ['bobPubB64'] } });

  await waitUntil(() => bus.calls.some((c) => c.topic === 'notification.chat.mention'));
  const notifyCall = bus.calls.find((c) => c.topic === 'notification.chat.mention');
  assert.equal(notifyCall.payload.nodeId, 'room-2');
  assert.equal(notifyCall.payload.kind, 'chat');
  assert.deepEqual(notifyCall.payload.to, ['bobPubB64']);
  assert.equal(notifyCall.payload.origin, 'local');
  assert.equal(notifyCall.payload.authorPub, QuCrypto.toBase64(alice.signingPub));
});

test('a REMOTE write (received via transport) emits the same two events, with origin: "remote" and the actual author', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceBus = recordingBus();
  const bobBus = recordingBus();

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, bus: aliceBus });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, bus: bobBus });

  const aliceNode = await aliceSpace.createNode(chatKind, {}, { id: 'room-3' });
  const bobNode = bobSpace.subscribeNode('room-3', chatKind);
  await bobNode; // subscribeNode is sync, but keep the shape symmetric/readable

  await aliceNode.field('messages').push('hello bob', { notify: { topic: 'message' } });

  await waitUntil(() => bobBus.calls.some((c) => c.topic === 'notification.chat.message'));
  const bobNotify = bobBus.calls.find((c) => c.topic === 'notification.chat.message');
  assert.equal(bobNotify.payload.origin, 'remote');
  assert.equal(bobNotify.payload.authorPub, QuCrypto.toBase64(alice.signingPub));

  assert.ok(bobBus.calls.some((c) => c.topic === 'space.node.room-3.changed' && c.payload.origin === 'remote'));
});

test('omitting bus entirely (the default) is a no-op - a Space works exactly as before, nothing thrown', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport }); // no bus

  const node = await space.createNode(chatKind, {}, { id: 'room-4' });
  await node.field('messages').push('hi', { notify: { topic: 'message' } });
  assert.equal(await node.field('messages').length, 1);
});
