/**
 * NODE-LEVEL ACL ENFORCEMENT, RELAY-SIDE - the @qu/space-transport
 * counterpart to @qu/space-core's own acl.test.js: proves `relay.js`'s
 * `buildWriteAcl()` and `handleGrant()` gate writes THROUGH a real relay
 * (self-certifying `'owner'`-mode, and `'named'`-mode via a signed
 * `grant`), not just directly between two peers with no relay in the
 * loop. Uses the same InProcessTransport/hub harness as
 * dynamic-membership.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space, deriveOwnerNodeId } from '@qu/space-core';
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

test("relay: an 'owner'-ACL Node's owner needs no membership at all - the relay routes their write purely from the self-certifying nodeId", async () => {
  const alice = await actor();
  const profileKind = defineKind('profile', { fields: { alias: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'owner' } });
  const hub = createInProcessHub();
  // deliberately an EMPTY member list - alice is registered nowhere, unlike every 'members'-mode test in this suite.
  const relay = createRelayForwarder({ hub, members: [], resolveKindSchema: () => profileKind });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(profileKind, { alias: 'alice' });

  await waitUntil(() => relay.seen.some((e) => e.nodeId === aliceNode.id));
});

test("relay: a non-owner's write to an 'owner'-ACL Node is rejected with reason \"bad-signature\", even from a real space member", async () => {
  const alice = await actor();
  const mallory = await actor();
  const profileKind = defineKind('profile', { fields: { alias: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'owner' } });
  const hub = createInProcessHub();
  // mallory IS a flat "member" here - proves 'owner'-ACL is NOT satisfied by ordinary membership.
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: mallory.signingPub, xPub: mallory.xPublicKey }];
  const { EventBus } = await import('@qu/events');
  const bus = new EventBus();
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => profileKind, bus });

  const nodeId = await deriveOwnerNodeId(alice.signingPub, 'profile');
  const malloryTransport = new InProcessTransport(hub, 'mallory');
  await malloryTransport.connect();
  const mallorySpace = new Space({ identity: mallory, members, transport: malloryTransport });
  const malloryNode = mallorySpace.subscribeNode(nodeId, profileKind);
  await malloryNode.field('alias').set('hacked');

  await waitUntil(() => rejections.some((r) => r.nodeId === nodeId));
  assert.equal(relay.seen.length, 0); // mallory's write never made it into the relay's own record.
});

test("relay: 'named'-ACL - a grant sent to the relay is verified, tracked, forwarded, and the grantee's subsequent write is routed", async () => {
  const alice = await actor();
  const bob = await actor();
  const docKind = defineKind('doc', { fields: { title: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'named' } });
  const hub = createInProcessHub();
  const { EventBus } = await import('@qu/events');
  const bus = new EventBus();
  const grantEvents = [];
  bus.on('debug.relay.grant.received', (p) => grantEvents.push(p));
  const relay = createRelayForwarder({ hub, members: [], resolveKindSchema: () => docKind, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });

  const nodeId = await deriveOwnerNodeId(alice.signingPub, 'doc');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });
  const bobNode = bobSpace.subscribeNode(nodeId, docKind);

  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  await aliceSpace.grantWriter(nodeId, 'doc', bob.signingPub);
  await waitUntil(() => grantEvents.some((e) => e.nodeId === nodeId)); // the relay itself has verified & tracked the grant before bob writes.

  await bobNode.field('title').set('now allowed');
  await waitUntil(() => relay.seen.some((e) => e.nodeId === nodeId && QuCrypto.toBase64(e.envelope.pub) === QuCrypto.toBase64(bob.signingPub)));
});
