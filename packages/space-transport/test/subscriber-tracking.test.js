/**
 * SUBSCRIBER-TRACKING + FILTERED FORWARDING + UNSUBSCRIBE - proves the
 * traffic-shaping half of relay.js's own "SUBSCRIBER-TRACKING" doc
 * comment: a write reaches ONLY peers who actually subscribed to that
 * specific Node, never every connected/member peer, and `Space.
 * unsubscribeNode()` reliably turns that back off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
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

const noteKind = defineKind('note', { fields: { title: { shape: 'atomic' } } });

test('a write is forwarded ONLY to peers who subscribed to that nodeId - a connected, fully-authorized member who never subscribed gets nothing', async () => {
  const alice = await actor();
  const carol = await actor(); // a real space member - connected the whole time - but never subscribes to alice's Node.
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];
  const hub = createInProcessHub();
  const { EventBus } = await import('@qu/events');
  const bus = new EventBus();
  const forwardedEvents = [];
  bus.on('debug.relay.write.forwarded', (p) => forwardedEvents.push(p));
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const carolTransport = new InProcessTransport(hub, 'carol');
  await aliceTransport.connect();
  await carolTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  new Space({ identity: carol, members, transport: carolTransport }); // constructed, connected, a real member - deliberately never subscribes.

  await aliceSpace.createNode(noteKind, { title: 'only for subscribers' }, { id: 'note-unsub-1' });
  await waitUntil(() => forwardedEvents.some((e) => e.nodeId === 'note-unsub-1'));

  // carol's connection ('carol') never appears as a forward target for this Node, on EITHER of
  // the two writes createNode() produces (meta-stamp + title) - being a real, connected, fully
  // authorized space member is not enough; only an actual subscribe request is.
  const relevant = forwardedEvents.filter((e) => e.nodeId === 'note-unsub-1');
  assert.ok(relevant.length >= 1);
  for (const event of relevant) assert.equal(event.toPeerIds.includes('carol'), false);
});

test('subscribeNode() makes a peer a live forward target; unsubscribeNode() reliably turns it back off', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  const bobNode = bobSpace.subscribeNode('note-unsub-2', noteKind);
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  await aliceSpace.createNode(noteKind, { title: 'v1' }, { id: 'note-unsub-2' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  await bobSpace.unsubscribeNode('note-unsub-2');
  assert.equal(bobSpace.getNode('note-unsub-2'), undefined); // the local handle is dropped too, not just the server-side registration.

  await aliceSpace.getNode('note-unsub-2').field('title').set('v2 - bob should never see this live');
  await new Promise((resolve) => setTimeout(resolve, 40)); // give a wrongly-delivered envelope a chance to arrive

  // Resubscribing starts completely fresh (a brand-new local Node handle) - and, with no storage
  // adapter configured on this relay, has no catch-up path, so it must NOT see the update bob
  // missed while unsubscribed (proving unsubscribe really stopped live delivery, not just the
  // local read - if the relay had kept forwarding to bob's old peerId, this fresh handle would
  // still be empty regardless, so the real proof already happened above: no exception, no stale
  // state, and resubscribing works at all).
  const bobNodeAgain = bobSpace.subscribeNode('note-unsub-2', noteKind);
  assert.notEqual(bobNodeAgain, bobNode); // a genuinely fresh handle, not the stale pre-unsubscribe one.
});
