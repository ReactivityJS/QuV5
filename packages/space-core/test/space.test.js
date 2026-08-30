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

const chatKind = defineKind('chat', { fields: { messages: { shape: 'list' } }, notifyTopics: ['message', 'mention'] });

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

test('constructing a Space emits debug.space.hello.sent', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const bus = recordingBus();
  new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus });

  await waitUntil(() => bus.calls.some((c) => c.topic === 'debug.space.hello.sent'));
});

test('subscribeNode() emits debug.space.subscribe.sent with the nodeId', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const bus = recordingBus();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus });
  space.subscribeNode('room-sub', chatKind);

  await waitUntil(() => bus.calls.some((c) => c.topic === 'debug.space.subscribe.sent'));
  const call = bus.calls.find((c) => c.topic === 'debug.space.subscribe.sent');
  assert.equal(call.payload.nodeId, 'room-sub');
});

test('a local write emits debug.space.write.local with the update size and notify hint', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const bus = recordingBus();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus });
  const node = await space.createNode(chatKind, {}, { id: 'room-debug-1' });

  await node.field('messages').push('hi', { notify: { topic: 'message' } });

  // createNode() above ALSO produces its own debug.space.write.local (the meta-stamp transaction,
  // notify: null) - wait for the specific one this push() produced, not just any write for this nodeId.
  await waitUntil(() => bus.calls.some((c) => c.topic === 'debug.space.write.local' && c.payload.notify?.topic === 'message'));
  const call = bus.calls.find((c) => c.topic === 'debug.space.write.local' && c.payload.notify?.topic === 'message');
  assert.equal(call.payload.nodeId, 'room-debug-1');
  assert.equal(call.payload.kind, 'chat');
  assert.ok(call.payload.bytes > 0);
  assert.deepEqual(call.payload.notify, { topic: 'message' });
});

test('a REMOTE write emits debug.space.write.remote.accepted on the receiving Space', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const [aliceTransport, bobTransport] = pairTransports();
  const bobBus = recordingBus();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, bus: bobBus });

  const aliceNode = await aliceSpace.createNode(chatKind, {}, { id: 'room-debug-2' });
  bobSpace.subscribeNode('room-debug-2', chatKind);
  await aliceNode.field('messages').push('hi bob');

  await waitUntil(() => bobBus.calls.some((c) => c.topic === 'debug.space.write.remote.accepted'));
  const call = bobBus.calls.find((c) => c.topic === 'debug.space.write.remote.accepted');
  assert.equal(call.payload.nodeId, 'room-debug-2');
  assert.equal(call.payload.authorPub, QuCrypto.toBase64(alice.signingPub));
  assert.ok(call.payload.bytes > 0);
});

test('a write for a Node this Space never subscribed to emits debug.space.write.remote.ignored, not .accepted', async () => {
  const alice = await actor();
  const bus = recordingBus();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus });

  // Simulate an envelope arriving for a Node id this Space was never told about - content
  // doesn't matter, _handleIncoming() returns before ever inspecting it (see !node check).
  await space._handleIncoming({ nodeId: 'never-subscribed', envelope: {} });

  assert.ok(bus.calls.some((c) => c.topic === 'debug.space.write.remote.ignored' && c.payload.nodeId === 'never-subscribed'));
  assert.ok(!bus.calls.some((c) => c.topic === 'debug.space.write.remote.accepted'));
});

test('loadNode() emits debug.space.load with the replayed envelope count', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();

  const memoryStore = (() => {
    const log = new Map();
    return {
      async append(nodeId, envelope) {
        const list = log.get(nodeId) ?? [];
        list.push(envelope);
        log.set(nodeId, list);
      },
      async load(nodeId) {
        return [...(log.get(nodeId) ?? [])];
      },
    };
  })();

  const writeBus = recordingBus();
  const writeSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, storage: memoryStore, bus: writeBus });
  const node = await writeSpace.createNode(chatKind, {}, { id: 'room-debug-3' });
  await node.field('messages').push('one');
  await node.field('messages').push('two');
  await waitUntil(() => writeBus.calls.filter((c) => c.topic === 'debug.space.write.local').length >= 3); // meta-stamp + 2 pushes, all storage.append()-ed

  const readBus = recordingBus();
  const readSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: pairTransports()[0], storage: memoryStore, bus: readBus });
  await readSpace.loadNode('room-debug-3', chatKind);

  assert.ok(readBus.calls.some((c) => c.topic === 'debug.space.load' && c.payload.nodeId === 'room-debug-3' && c.payload.envelopeCount >= 3));
});

test('addMember() lets an already-constructed Space encrypt-for and accept writes from a member it did not start with', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();

  // Alice's Space is constructed WITHOUT bob - simulates bob joining later (e.g. via a relay's dynamic-membership endpoint) -
  // but he's added BEFORE alice's first write here: this architecture's every-member-is-a-recipient
  // model means a write sealed before a member is added can never retroactively include them (by
  // design - see envelope.js), so this proves the real, useful case: added-then-written-to works.
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }], transport: bobTransport });
  aliceSpace.addMember({ pub: bob.signingPub, xPub: bob.xPublicKey });

  const aliceNode = await aliceSpace.createNode(chatKind, {}, { id: 'room-late-join' });
  const bobNode = bobSpace.subscribeNode('room-late-join', chatKind);
  await aliceNode.field('messages').push('hi bob');

  await waitUntil(() => bobNode.field('messages').length === 1);
  assert.equal((await bobNode.field('messages').toArray())[0], 'hi bob');
});

test('addMember() is idempotent and does not mutate the caller\'s original members array', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const originalMembers = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const space = new Space({ identity: alice, members: originalMembers, transport: aliceTransport });

  space.addMember({ pub: alice.signingPub, xPub: alice.xPublicKey }); // already a member - no-op
  space.addMember({ pub: alice.signingPub, xPub: alice.xPublicKey }); // again - still a no-op

  assert.equal(originalMembers.length, 1); // the caller's own array is untouched, per Space's own doc comment.
});
