/**
 * NODE-LEVEL ACL ENFORCEMENT, RELAY-SIDE ('content' mode) - the
 * @qu/space-transport counterpart to @qu/space-core's own
 * content-acl.test.js, and this package's own named-acl.test.js: proves
 * `relay.js`'s `buildWriteAcl()`/`handleGrant()`/`handleSubscribe()` gate
 * and REPLAY `'content'`-ACL writes correctly THROUGH a real relay.
 *
 * The LATE-SUBSCRIBER test below is the actual regression this file exists
 * for: unlike `'named'`, `'content'` mode has no owner-pubkey shortcut (see
 * `@qu/space-core`'s kind-schema.js), so EVERY reader - including one
 * reading the ORIGINAL owner's own content - needs to have seen a `grant`
 * message, not just the write's own envelope. A relay that only replays
 * ENVELOPE history to a newly-subscribing peer (the pre-existing
 * `handleSubscribe()` behavior) silently strands such a peer forever - see
 * `relay.js`'s own `grantStorageKey()` doc comment for the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space, deriveContentNodeId } from '@qu/space-core';
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

// metaVisibility forced to 'public' (same fix @qu/app-core's kinds.js applies to qu-page/etc. -
// see that file's own "publicMeta()" doc comment): a 'content'-ACL Kind's meta-stamp defaults to
// 'encrypted', sealed only for whoever was a member AT WRITE TIME - a visitor who joins the
// RELAY later (this file's own point) but was never in the AUTHOR's own local `members` list at
// that moment could never decrypt it otherwise, permanently gapping every later update too (Yjs'
// per-author gapless ordering) - a SEPARATE concern from the write-ACL/grant-replay this file
// actually tests, already covered by kinds.js's own publicMeta()-wrapped Kinds elsewhere.
const docKind = Object.freeze({
  ...defineKind('doc', { fields: { title: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'content' } }),
  metaVisibility: 'public',
});

test("relay: 'content'-ACL - a Space member with no grant is rejected; a genuine grant (owner or explicit grantee) is routed", async () => {
  const alice = await actor();
  const mallory = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: mallory.signingPub, xPub: mallory.xPublicKey }];
  const hub = createInProcessHub();
  const { EventBus } = await import('@qu/events');
  const bus = new EventBus();
  const rejections = [];
  const grantEvents = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  bus.on('debug.relay.grant.received', (p) => grantEvents.push(p));
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => docKind, bus, storage: createMemoryStore() });

  const nodeId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const malloryTransport = new InProcessTransport(hub, 'mallory');
  await malloryTransport.connect();
  const mallorySpace = new Space({ identity: mallory, members, transport: malloryTransport });
  const malloryNode = mallorySpace.subscribeNode(nodeId, docKind);

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' }); // self-grant + write, both accepted (alice IS the owner).
  await waitUntil(async () => (await malloryNode.field('title').get()) === 'v1');

  // mallory IS a Space member (the OLD 'members'-mode would have been enough) but has no grant.
  await malloryNode.field('title').set('mallory has no grant');
  await waitUntil(() => rejections.some((r) => r.nodeId === nodeId));
  assert.equal(await aliceNode.field('title').get(), 'v1');

  const malloryPubB64 = QuCrypto.toBase64(mallory.signingPub);
  await aliceSpace.grantWriter(nodeId, 'doc', mallory.signingPub, { path: '/hello' });
  // Wait for the RELAY ITSELF to confirm it verified+applied THIS SPECIFIC grant before mallory
  // writes - two DIFFERENT peers (alice granting, mallory writing) race independently through the
  // relay's own PER-PEER serialized queues (relay.js's own doc comment on `peerQueues`), so
  // `grantWriter()`'s own promise resolving (alice's local send only) does not guarantee the relay
  // has finished applying it yet - same pattern named-acl.test.js's own relay-based grant test
  // already uses, for the identical reason. Matched by GRANTEE, not just `nodeId` - alice's own
  // EARLIER self-grant (from `createNode()`) fired the identical event for this same `nodeId`.
  await waitUntil(() => grantEvents.some((e) => e.nodeId === nodeId && e.granteePub === malloryPubB64));
  await malloryNode.field('title').set('mallory, now granted');
  await waitUntil(() => relay.seen.some((e) => e.nodeId === nodeId && QuCrypto.toBase64(e.envelope.pub) === malloryPubB64));
});

test("relay: 'content'-ACL - a peer who subscribes AFTER the owner already created content (grant already broadcast, nobody left to re-send it live) still resolves it - grants are replayed on subscribe, not just envelopes", async () => {
  const alice = await actor();
  const visitor = await actor();
  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => docKind, storage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  await waitUntil(() => relay.seen.some((e) => e.nodeId === aliceNode.id));
  aliceTransport.close?.(); // alice is GONE by the time the visitor arrives - nothing left to live-broadcast the grant again.

  relay.addMember({ pub: visitor.signingPub, xPub: visitor.xPublicKey });
  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const visitorSpace = new Space({
    identity: visitor,
    members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }],
    transport: visitorTransport,
  });
  const visitorNode = visitorSpace.subscribeNode(aliceNode.id, docKind);

  await waitUntil(async () => (await visitorNode.field('title').get()) === 'v1', { timeout: 3000 });
});

test("relay: 'content'-ACL - compacting a Node does NOT wipe its grant history (grants live at a separate storage key from envelopes)", async () => {
  const alice = await actor();
  const visitor = await actor();
  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => docKind, storage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  await waitUntil(() => relay.seen.some((e) => e.nodeId === aliceNode.id));

  await aliceSpace.compactNode(aliceNode.id); // re-seals meta+every field as ONE envelope - see space.js's own compactNode() doc comment.
  await waitUntil(() => relay.seen.filter((e) => e.nodeId === aliceNode.id).length >= 2);

  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const visitorSpace = new Space({
    identity: visitor,
    members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }],
    transport: visitorTransport,
  });
  const visitorNode = visitorSpace.subscribeNode(aliceNode.id, docKind);
  await waitUntil(async () => (await visitorNode.field('title').get()) === 'v1', { timeout: 3000 });
});
