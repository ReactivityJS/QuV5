/**
 * END-TO-END PROOF of the notify/presence/push routing this branch adds:
 * a write's own (unencrypted, sender-attached) `notify` hint reaches the
 * relay without decryption, the relay's `PresenceTracker` (built from
 * `Space`'s own automatic signed `hello`) decides online vs. offline, and
 * a `registerPushHandler()` plugin subscribed to the SAME `@qu/events` bus
 * decides - purely from that `online` flag - whether to actually push.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { EventBus } from '@qu/events';
import { createInProcessHub, InProcessTransport, createRelayForwarder, registerPushHandler } from '../src/index.js';

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

const chatKind = defineKind('chat', { fields: { messages: { shape: 'list' } }, notifyTopics: ['message', 'mention'] });

test('a CONNECTED recipient: relay.notify carries online:true, and the push handler does NOT push', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  new Space({ identity: bob, members, transport: bobTransport }); // constructing it alone sends bob's signed hello

  const bobPubB64 = QuCrypto.toBase64(bob.signingPub);
  await waitUntil(() => relay.presence.isOnline(bobPubB64));

  const notifyEvents = [];
  bus.on('relay.notify.**', (p) => notifyEvents.push(p));

  const aliceNode = await aliceSpace.createNode(chatKind, {}, { id: 'room-online' });
  await aliceNode.field('messages').push('hi bob', { notify: { topic: 'message' } });

  await waitUntil(() => notifyEvents.length > 0);
  assert.equal(notifyEvents[0].online, true);
  assert.equal(notifyEvents[0].to, bobPubB64);
  assert.equal(notifyEvents[0].kind, 'chat');
  assert.equal(notifyEvents[0].topic, 'message');

  await new Promise((resolve) => setTimeout(resolve, 20)); // give a wrongly-firing push a chance to show up
  assert.deepEqual(pushed, []);
});

test('a member who never connected: relay.notify carries online:false, and the push handler DOES push', async () => {
  const alice = await actor();
  const bob = await actor(); // deliberately never gets a Space/transport - stays unknown to this relay's presence
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });

  const bobPubB64 = QuCrypto.toBase64(bob.signingPub);
  assert.equal(relay.presence.isOnline(bobPubB64), false);

  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-offline' });
  await node.field('messages').push('@bob hi', { notify: { topic: 'mention', to: [bobPubB64] } });

  await waitUntil(() => pushed.length > 0);
  assert.equal(pushed[0].to, bobPubB64);
  assert.equal(pushed[0].topic, 'mention');
  assert.equal(pushed[0].kind, 'chat');
  assert.equal(pushed[0].authorPub, QuCrypto.toBase64(alice.signingPub));
});

test('a write with NO notify hint never triggers relay.notify or a push', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });
  const notifyEvents = [];
  bus.on('relay.notify.**', (p) => notifyEvents.push(p));

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-plain' });
  await node.field('messages').push('just a normal message'); // no {notify}

  await new Promise((resolve) => setTimeout(resolve, 30)); // give any wrongly-firing event a chance to show up
  assert.deepEqual(notifyEvents, []);
  assert.deepEqual(pushed, []);
});

test('disconnecting flips a recipient back to offline for the NEXT write', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const pushed = [];
  registerPushHandler(bus, { sendPush: (p) => pushed.push(p) });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  new Space({ identity: bob, members, transport: bobTransport });

  const bobPubB64 = QuCrypto.toBase64(bob.signingPub);
  await waitUntil(() => relay.presence.isOnline(bobPubB64));

  hub.disconnect(bobTransport.getPeerId()); // simulates bob's connection dropping (e.g. tab closed, network loss)
  assert.equal(relay.presence.isOnline(bobPubB64), false);

  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-disconnect' });
  await node.field('messages').push('are you still there?', { notify: { topic: 'message', to: [bobPubB64] } });

  await waitUntil(() => pushed.length > 0);
  assert.equal(pushed[0].to, bobPubB64);
});

test('omitting notify.to notifies every OTHER space member (never the author)', async () => {
  const alice = await actor();
  const bob = await actor();
  const carol = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus });
  const notifyEvents = [];
  bus.on('relay.notify.**', (p) => notifyEvents.push(p));

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-broadcast' });
  await node.field('messages').push('hello everyone', { notify: { topic: 'message' } }); // no `to` - broadcast

  await waitUntil(() => notifyEvents.length === 2);
  const recipients = notifyEvents.map((e) => e.to).sort();
  assert.deepEqual(recipients, [QuCrypto.toBase64(bob.signingPub), QuCrypto.toBase64(carol.signingPub)].sort());
});
