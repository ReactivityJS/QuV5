import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space, sealUpdate } from '@qu/space-core';
import { EventBus } from '@qu/events';
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

const chatKind = defineKind('chat', { fields: { messages: { shape: 'list' } } });

test('a hello message emits debug.relay.hello.received and debug.relay.presence.online', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const events = [];
  bus.on('debug.relay.**', (p, ctx) => events.push(ctx.topic));

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  new Space({ identity: alice, members, transport }); // sends hello on construction

  await waitUntil(() => events.includes('debug.relay.presence.online'));
  assert.ok(events.includes('debug.relay.hello.received'));
});

test('disconnecting emits debug.relay.presence.offline with the pubkey that went offline', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  const bus = new EventBus();
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const offlineEvents = [];
  bus.on('debug.relay.presence.offline', (p) => offlineEvents.push(p));

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  new Space({ identity: alice, members, transport });

  const alicePubB64 = QuCrypto.toBase64(alice.signingPub);
  await waitUntil(() => relay.presence.isOnline(alicePubB64)); // wait for the hello to actually land before disconnecting

  hub.disconnect('alice');
  await waitUntil(() => offlineEvents.length > 0);
  assert.equal(offlineEvents[0].pub, alicePubB64);
});

test('a normal write emits received -> mirrored -> forwarded, in that order', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  const { createMemoryStore } = await import('@qu/space-storage');
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus, storage: createMemoryStore() });
  const topics = [];
  bus.on('debug.relay.write.**', (p, ctx) => topics.push(ctx.topic));

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  new Space({ identity: bob, members, transport: bobTransport });

  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-1' });
  await node.field('messages').push('hi');

  await waitUntil(() => topics.filter((t) => t === 'debug.relay.write.forwarded').length >= 2); // meta-stamp write + push, each forwarded once
  assert.deepEqual(
    topics.slice(0, 3),
    ['debug.relay.write.received', 'debug.relay.write.mirrored', 'debug.relay.write.forwarded']
  );
});

test('a write to an unknown Node id emits debug.relay.write.rejected with reason "unknown-node"', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members, resolveKindSchema: () => null, bus }); // never recognizes any Node
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  const space = new Space({ identity: alice, members, transport });
  const node = await space.createNode(chatKind, {}, { id: 'room-unknown' });
  await node.field('messages').push('hi');

  await waitUntil(() => rejections.length > 0);
  assert.equal(rejections[0].reason, 'unknown-node');
});

test('a forged write (signed by a non-member) emits debug.relay.write.rejected with reason "bad-signature"', async () => {
  const alice = await actor();
  const mallory = await actor(); // not a member
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));

  const malloryTransport = new InProcessTransport(hub, 'mallory');
  await malloryTransport.connect();
  const forged = await sealUpdate(new TextEncoder().encode('forged'), mallory, [alice.xPublicKey]);
  malloryTransport.send({ nodeId: 'room-x', envelope: forged });

  await waitUntil(() => rejections.length > 0);
  assert.equal(rejections[0].reason, 'bad-signature');
});

test('subscribeNode() catch-up emits subscribe.received then subscribe.replayed with the mirrored count', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  const { createMemoryStore } = await import('@qu/space-storage');
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus, storage: createMemoryStore() });
  const topics = [];
  bus.on('debug.relay.subscribe.**', (p, ctx) => topics.push([ctx.topic, p]));

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-catchup' });
  await node.field('messages').push('one');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  bobSpace.subscribeNode('room-catchup', chatKind);

  await waitUntil(() => topics.some(([t]) => t === 'debug.relay.subscribe.replayed'));
  assert.ok(topics.some(([t]) => t === 'debug.relay.subscribe.received'));
  const replayed = topics.find(([t]) => t === 'debug.relay.subscribe.replayed')[1];
  assert.ok(replayed.count >= 2); // meta-stamp + the 'one' push, both mirrored
});
