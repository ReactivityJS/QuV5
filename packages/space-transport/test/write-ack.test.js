/**
 * WRITE-ACK — proves relay.js's own "WRITE-ACK" mechanism: once a LOCALLY-
 * originated write is mirrored to `storage`, the relay tells that write's
 * own author `{type:'write-ack', nodeId, seq}` - the building block
 * `@qu/space-plugins`' delivery-status tracking needs to distinguish
 * "reached the relay's durable mirror" from "a live peer applied it."
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

const noteKind = defineKind('ack-note', { fields: { title: { shape: 'atomic' }, items: { shape: 'list' } } });

test('a mirrored write acks back to its own author with an incrementing seq', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, storage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const events = [];
  const bus = { emit: async (topic, payload) => events.push({ topic, payload }) };
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, bus });

  const node = await aliceSpace.createNode(noteKind, { title: 'hi' }, { id: 'ack-1' });
  await waitUntil(() => events.some((e) => e.topic === 'space.node.ack-1.write-ack'));
  const firstAck = events.find((e) => e.topic === 'space.node.ack-1.write-ack');
  assert.ok(firstAck.payload.seq >= 1);

  const seqBefore = firstAck.payload.seq;
  await node.field('items').push('x');
  await waitUntil(() => events.filter((e) => e.topic === 'space.node.ack-1.write-ack').length > 1);
  const acks = events.filter((e) => e.topic === 'space.node.ack-1.write-ack');
  assert.ok(acks[acks.length - 1].payload.seq > seqBefore); // the mirror grew - a later ack reports a higher seq.
});

test('no write-ack is sent when the relay has no storage adapter configured', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind }); // no `storage`.

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const events = [];
  const bus = { emit: async (topic, payload) => events.push({ topic, payload }) };
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, bus });
  await aliceSpace.createNode(noteKind, { title: 'hi' }, { id: 'ack-2' });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.some((e) => e.topic === 'space.node.ack-2.write-ack'), false);
});
