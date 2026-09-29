/**
 * NODE-LEVEL ACL ENFORCEMENT, RELAY-SIDE ('group' mode) - the
 * @qu/space-transport counterpart to @qu/space-core's own group-acl.test.js,
 * and this package's own content-acl.test.js: proves `relay.js`'s
 * `buildWriteAcl()`/`handleGroupMembership()`/`handleSubscribe()` gate and
 * REPLAY `'group'`-ACL writes correctly THROUGH a real relay.
 *
 * Unlike `'content'`/`'named'` mode's grants, this relay never decodes a
 * Group's own Yjs content to learn its current membership (the relay stays
 * application-blind - see relay.js's own `groupMemberships` doc comment for
 * the full "why a signed declaration, not relay-side Yjs decoding"
 * reasoning) - `Space.declareGroupMembership()` (@qu/space-core) is what
 * tells the relay who currently belongs to a Group at all, a SEPARATE
 * signed control message from the Group's own ordinary field write. Every
 * test below sends one explicitly, mirroring what `@qu/app-core`'s
 * `createGroup()`/`editGroup()` are expected to do alongside their own
 * `members` field write (a later Task's job to wire up for real).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space, deriveContentNodeId, signGroupMembership } from '@qu/space-core';
import { createMemoryStore } from '@qu/space-storage';
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

/**
 * Subscribes `space` to the Group Node and waits for its OWN `sync-ack` before returning - NEVER
 * fire-and-forget here, unlike an ordinary `subscribeNode()` call. `subscribeNode()`'s own outgoing
 * `subscribe` request is signed ASYNCHRONOUSLY (`_sendSubscribeRequest()`, @qu/space-core's space.js) -
 * two `subscribeNode()` calls issued back-to-back (Group, then chat) have NO guarantee their signing
 * work finishes, and thus their requests actually REACH the relay, in that same order. If the CHAT
 * subscribe's own replay reaches this Space BEFORE the Group's replay has landed, this Space's own
 * CLIENT-side `_isAuthorizedWriter()` verification of the very FIRST replayed chat write fails (the
 * Group isn't known yet) - and because a REJECTED write is never integrated into that Node's Yjs
 * history at all, every LATER write from the SAME author to that SAME Node is then ALSO permanently
 * blocked (the "WRITE-BEFORE-GRANT IS A TRAP" causal-gap mechanism grant.js's own doc comment
 * describes) - this Space would then NEVER see the chat history, no matter how long a caller waits.
 * Subscribing to the Group FIRST and waiting for ITS OWN sync-ack before ever subscribing to
 * anything that references it removes the race entirely.
 */
async function subscribeGroupAndWaitSynced(space, groupId) {
  space.subscribeNode(groupId, groupKind);
  await waitUntil(() => space.isNodeSynced(groupId));
}

// metaVisibility forced to 'public' (same fix content-acl.test.js's own docKind already applies,
// for the identical reason - see that file's own doc comment): decoding a Group/chat Node's meta
// stamp must not depend on who happened to be in a member list at write time.
const groupKind = Object.freeze({
  ...defineKind('qu-group', { fields: { name: { shape: 'atomic', visibility: 'public' }, members: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'content' } }),
  metaVisibility: 'public',
});
const chatKind = Object.freeze({
  ...defineKind('chat-message', { fields: { text: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'group' } }),
  metaVisibility: 'public',
});

/** A minimal resolver good enough for these tests - every real nodeId is precomputable up front (see this file's own tests), so there is no need for the groupRef-based classification `relay.js`'s own `resolveKindSchema()` doc comment describes for a real app. */
function makeResolveKindSchema(idToKind) {
  return (nodeId) => idToKind.get(nodeId) ?? null;
}

function toBase64Pair({ pub, xPub }) {
  return { pub: QuCrypto.toBase64(pub), xPub: xPub ? QuCrypto.toBase64(xPub) : undefined };
}

test("relay: 'group'-ACL - a current group member's write is forwarded; a non-member's is rejected", async () => {
  const owner = await actor();
  const bob = await actor(); // group member.
  const mallory = await actor(); // Space member, but NOT a group member.
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: mallory.signingPub, xPub: mallory.xPublicKey },
  ];

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const idToKind = new Map([[groupId, groupKind], [chatId, chatKind]]);

  const hub = createInProcessHub();
  const bus = new EventBus();
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), bus, storage: createMemoryStore() });

  const ownerTransport = new InProcessTransport(hub, 'owner');
  await ownerTransport.connect();
  const ownerSpace = new Space({ identity: owner, members, transport: ownerTransport });

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  const malloryTransport = new InProcessTransport(hub, 'mallory');
  await malloryTransport.connect();
  const mallorySpace = new Space({ identity: mallory, members, transport: malloryTransport });

  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };
  // Bob and mallory both need their OWN local copy of the Group's data to verify OWNER's (and each
  // other's) 'group'-ACL writes CLIENT-side - Space._currentGroupMembers()'s own doc comment (never
  // blocks, only ever reads what THIS Space already has locally) - so both subscribe to the Group
  // Node itself too, not just the chat Node.
  await subscribeGroupAndWaitSynced(bobSpace, groupId);
  await subscribeGroupAndWaitSynced(mallorySpace, groupId);
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });
  const malloryChatNode = mallorySpace.subscribeNode(chatId, chatKind, { groupRef });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await ownerSpace.declareGroupMembership({ groupName: 'room1', members: [owner.signingPub, bob.signingPub] });
  await waitUntil(() => relay.seen.some((e) => e.nodeId === groupId));

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'hello from owner' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'hello from owner');
  await waitUntil(async () => (await malloryChatNode.field('text').get()) === 'hello from owner');

  // Bob is a real member - the relay forwards his write.
  await bobChatNode.field('text').set('hi from bob, a real member');
  await waitUntil(async () => (await ownerChatNode.field('text').get()) === 'hi from bob, a real member');

  // Mallory is a Space member (would have been enough under old flat 'members'-mode) but NOT a
  // group member - the relay itself rejects her write, never even forwarding it.
  await malloryChatNode.field('text').set('hacked by mallory, not a group member');
  await waitUntil(() => rejections.some((r) => r.nodeId === chatId));
  assert.equal(await ownerChatNode.field('text').get(), 'hi from bob, a real member');
});

test("relay: 'group'-ACL - a write whose claimed groupRef does not self-certify against its own nodeId is rejected, even from a genuine member of a DIFFERENT real group", async () => {
  const owner = await actor();
  const bob = await actor();
  const members = [{ pub: owner.signingPub, xPub: owner.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];

  const room1Id = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const room2Id = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room2');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1'); // the REAL room1 chat id.
  const idToKind = new Map([[room1Id, groupKind], [room2Id, groupKind], [chatId, chatKind]]);

  const hub = createInProcessHub();
  const bus = new EventBus();
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), bus, storage: createMemoryStore() });

  const ownerTransport = new InProcessTransport(hub, 'owner');
  await ownerTransport.connect();
  const ownerSpace = new Space({ identity: owner, members, transport: ownerTransport });
  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  // bob needs his own local copy of the REAL room1 Group (owner's write always carries the REAL
  // room1 groupRef, regardless of what bob's OWN write below claims) - see the test above's own
  // comment on why. room2 is never subscribed - irrelevant to verifying owner's genuine write.
  await subscribeGroupAndWaitSynced(bobSpace, room1Id);
  // bob subscribes to room1's REAL chatId but claims groupRef for "room2" instead.
  const forgedGroupRef = { groupOwnerPub: owner.signingPub, groupName: 'room2' };
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef: forgedGroupRef });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await ownerSpace.createNode(groupKind, { name: 'room2', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room2' });
  await ownerSpace.declareGroupMembership({ groupName: 'room1', members: [owner.signingPub, bob.signingPub] });
  await ownerSpace.declareGroupMembership({ groupName: 'room2', members: [owner.signingPub, bob.signingPub] }); // bob IS genuinely in room2 too - irrelevant, the claim is checked against room1's REAL chatId.
  await waitUntil(() => relay.seen.some((e) => e.nodeId === room2Id));

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'v1');

  await bobChatNode.field('text').set('should be rejected - forged groupRef does not self-certify against this nodeId');
  await waitUntil(() => rejections.some((r) => r.nodeId === chatId));
  assert.equal(await ownerChatNode.field('text').get(), 'v1');
});

test("relay: 'group'-ACL - a write for a Group the relay has no membership declaration for at all is rejected (fail closed)", async () => {
  const owner = await actor();
  const bob = await actor();
  const members = [{ pub: owner.signingPub, xPub: owner.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const idToKind = new Map([[groupId, groupKind], [chatId, chatKind]]);

  const hub = createInProcessHub();
  const bus = new EventBus();
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), bus, storage: createMemoryStore() });

  const ownerTransport = new InProcessTransport(hub, 'owner');
  await ownerTransport.connect();
  const ownerSpace = new Space({ identity: owner, members, transport: ownerTransport });
  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });

  // owner creates the group's own Node and even writes its (public) members field - but NEVER
  // sends the signed group-membership DECLARATION the relay actually needs.
  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });

  // Fail-closed applies to EVERYONE, including the Group's own owner/creator - 'group' mode has no
  // owner-pubkey shortcut the way 'content' mode does (kind-schema.js's own "'group'" doc comment) -
  // so with no declaration at all, even owner's OWN first write is rejected by the relay outright,
  // never even reaching bob.
  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(() => rejections.some((r) => r.nodeId === chatId));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await bobChatNode.field('text').get(), null, "bob must never receive owner's own write when the relay has no membership declaration for its Group at all");
});

test("relay: 'group'-ACL - removing a member via a NEWER declaration takes effect for future writes; a STALE (older-ts, reordered) declaration never regresses current membership back to including the removed member", async () => {
  const owner = await actor();
  const bob = await actor();
  const members = [{ pub: owner.signingPub, xPub: owner.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const idToKind = new Map([[groupId, groupKind], [chatId, chatKind]]);

  const hub = createInProcessHub();
  const bus = new EventBus();
  const rejections = [];
  const declarations = [];
  const staleDeclarations = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  bus.on('debug.relay.group-membership.received', (p) => declarations.push(p));
  bus.on('debug.relay.group-membership.stale', (p) => staleDeclarations.push(p));
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), bus, storage: createMemoryStore() });

  const ownerTransport = new InProcessTransport(hub, 'owner');
  await ownerTransport.connect();
  const ownerSpace = new Space({ identity: owner, members, transport: ownerTransport });
  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };
  await subscribeGroupAndWaitSynced(bobSpace, groupId); // bob needs his own local copy to verify owner's writes CLIENT-side too - see the first test's own comment.
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await ownerSpace.declareGroupMembership({ groupName: 'room1', members: [owner.signingPub, bob.signingPub] });
  await waitUntil(() => declarations.length >= 1);

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'v1');

  await bobChatNode.field('text').set('bob wrote this while still a member');
  await waitUntil(async () => (await ownerChatNode.field('text').get()) === 'bob wrote this while still a member');

  // Construct (but do NOT send yet) a genuinely EARLIER, honestly owner-signed "bob is still a
  // member" declaration - its own ts is captured NOW, strictly before the real removal below.
  const staleReaffirmBob = await signGroupMembership({ groupName: 'room1', members: [owner.signingPub, bob.signingPub] }, owner);
  await new Promise((resolve) => setTimeout(resolve, 5)); // guarantee the REAL removal's own ts is strictly later.

  // owner removes bob for real - genuinely newer ts, applied immediately.
  await ownerSpace.declareGroupMembership({ groupName: 'room1', members: [owner.signingPub] });
  await waitUntil(() => declarations.length >= 2);
  await bobChatNode.field('text').set('should be rejected - bob was just removed');
  await waitUntil(() => rejections.some((r) => r.nodeId === chatId));
  assert.equal(await ownerChatNode.field('text').get(), 'bob wrote this while still a member');

  // NOW the stale, older "bob is still a member" declaration arrives late (a reordered delivery) -
  // it must be IGNORED (relay.js's own `groupMemberships`/`ts` doc comment), never resurrecting
  // bob's membership back to what it was BEFORE the real removal above.
  ownerTransport.send(staleReaffirmBob);
  await waitUntil(() => staleDeclarations.length >= 1);
  const rejectionCountBefore = rejections.length;
  await bobChatNode.field('text').set('should STILL be rejected - the stale reaffirm-bob declaration must not have won');
  await waitUntil(() => rejections.length > rejectionCountBefore); // a NEW rejection landed for this second attempt too.
  assert.equal(await ownerChatNode.field('text').get(), 'bob wrote this while still a member');
});

test("relay: 'group'-ACL - a peer who subscribes AFTER the owner already wrote (grant/declaration already broadcast, nobody left to re-send it live) still resolves history - groupRef is re-attached on replay, not just the bare envelope", async () => {
  const owner = await actor();
  const visitor = await actor();

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const idToKind = new Map([[groupId, groupKind], [chatId, chatKind]]);

  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: owner.signingPub, xPub: owner.xPublicKey }], resolveKindSchema: makeResolveKindSchema(idToKind), storage: createMemoryStore() });

  const ownerTransport = new InProcessTransport(hub, 'owner');
  await ownerTransport.connect();
  const ownerSpace = new Space({ identity: owner, members: [{ pub: owner.signingPub, xPub: owner.xPublicKey }], transport: ownerTransport });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: visitor.signingPub })] }, { path: 'room1' });
  await ownerSpace.declareGroupMembership({ groupName: 'room1', members: [owner.signingPub, visitor.signingPub] });
  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'hello, visitor' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(() => relay.seen.some((e) => e.nodeId === chatId));
  ownerTransport.close?.(); // owner is GONE by the time the visitor arrives - nothing left to live-broadcast groupRef again.

  relay.addMember({ pub: visitor.signingPub, xPub: visitor.xPublicKey });
  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const visitorSpace = new Space({
    identity: visitor,
    members: [{ pub: owner.signingPub, xPub: owner.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }],
    transport: visitorTransport,
  });
  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };
  await subscribeGroupAndWaitSynced(visitorSpace, groupId); // visitor needs his own local copy to verify owner's writes CLIENT-side too - see the first test's own comment; replayed from the relay's own mirror same as the chat history below.
  const visitorNode = visitorSpace.subscribeNode(chatId, chatKind, { groupRef });

  await waitUntil(async () => (await visitorNode.field('text').get()) === 'hello, visitor', { timeout: 3000 });
});
