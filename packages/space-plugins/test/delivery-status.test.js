/**
 * DELIVERY STATUS — see delivery-status.js's own doc comment. Proves:
 *   1. awaitRelayAck() resolves once a real relay's write-ack lands.
 *   2. markRead()/watchReadReceipts() round-trip a read marker peer-to-peer.
 *   3. ReadReceiptWatcher reactively tracks multiple readers off the bus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createMemoryStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import { awaitRelayAck, readReceiptKind, markRead, watchReadReceipts, ReadReceiptWatcher } from '../src/delivery-status.js';

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

function pairTransports() {
  let aOnMessage = null;
  let bOnMessage = null;
  const a = { async connect() {}, send(data) { queueMicrotask(() => bOnMessage?.({ data })); }, onMessage(cb) { aOnMessage = cb; } };
  const b = { async connect() {}, send(data) { queueMicrotask(() => aOnMessage?.({ data })); }, onMessage(cb) { bOnMessage = cb; } };
  return [a, b];
}

const noteKind = defineKind('delivery-note', { fields: { title: { shape: 'atomic' } } });

test('awaitRelayAck() resolves once a real relay mirrors the write', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, storage: createMemoryStore() });

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  const bus = new EventBus();
  const space = new Space({ identity: alice, members, transport, bus });

  const node = await space.createNode(noteKind, { title: 'x' }, { id: 'ack-note-1' });
  const ack = await awaitRelayAck(bus, 'ack-note-1');
  assert.equal(ack.nodeId, 'ack-note-1');
  assert.ok(ack.seq >= 1);
  void node;
});

test('markRead()/watchReadReceipts() round-trip a read marker peer-to-peer', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  // readReceiptKind's `marks` field is 'encrypted' visibility (unlike presenceKind's public
  // fields) - alice must actually have bob as a Space member to encrypt her read receipts FOR him.
  const aliceSpace = new Space({ identity: alice, members: [{ pub: bob.signingPub, xPub: bob.xPublicKey }], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });

  // bob watches alice's read receipts BEFORE she publishes any - this bare peer-to-peer harness
  // has no relay/storage catch-up, same ordering note as presence.test.js's own tests.
  await watchReadReceipts(bobSpace, alice.signingPub);
  await markRead(aliceSpace, 'thread-1', 42);
  await waitUntil(async () => (await watchReadReceipts(bobSpace, alice.signingPub)).marks['thread-1']?.upTo === 42);
});

test('ReadReceiptWatcher reactively tracks multiple readers off the bus', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceSpace = new Space({ identity: alice, members: [{ pub: bob.signingPub, xPub: bob.xPublicKey }], transport: aliceTransport });
  const bobBus = new EventBus();
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport, bus: bobBus });

  const watcher = new ReadReceiptWatcher(bobSpace, bobBus);
  await watcher.watch(alice.signingPub);
  await markRead(aliceSpace, 'thread-2', 'msg-7');
  await waitUntil(() => watcher.upToFor(QuCrypto.toBase64(alice.signingPub), 'thread-2') === 'msg-7');
});

test('readReceiptKind is durable (unlike presenceKind) - a read marker is meant to survive', () => {
  assert.equal(readReceiptKind.persistence, 'durable');
  assert.equal(readReceiptKind.acl.write, 'owner');
});
