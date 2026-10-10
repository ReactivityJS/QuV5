/**
 * 'group'-ACL MODE — `'content'`'s REVOCABLE counterpart (kind-schema.js's
 * own "'group'" doc comment): a Node's write-ACL is checked LIVE against a
 * referenced Group's CURRENT membership (`Space._currentGroupMembers()`'s
 * own live cache), instead of a permanent per-Node grant that (per
 * grant.js's own doc comment) can never be revoked. This file proves the
 * CLIENT-SIDE mirror (`Space._isAuthorizedWriter()`'s `'group'` branch +
 * `_currentGroupMembers()`'s live cache) in isolation, with the SAME bare
 * two-peer fake-transport harness `content-acl.test.js` already uses for
 * `'content'` mode - zero relay involved (relay-side enforcement is
 * `relay.js`'s own, separate `buildWriteAcl()` mirror, a later Task).
 *
 * Every `Space` below is given a REAL `members` list with genuine `xPub`
 * keys on both sides - `'group'` mode's `metaVisibility` is `'encrypted'`
 * (kind-schema.js's own computation, same as `'content'`/`'members'` mode),
 * so decrypting even a Node whose OWN fields are all `visibility: 'public'`
 * (as `chatKind.text` below is) still needs a real recipient `xPub` on both
 * sides for its META stamp - same requirement `content-acl.test.js`'s own
 * top doc comment already spells out for `'content'` mode.
 *
 * SUBSCRIBE-BEFORE-CREATE, EVERYWHERE, NO EXCEPTIONS: every peer that needs
 * to correctly receive ANY write below (the Group's own data, or a chat
 * message) calls `subscribeNode()` for that exact id BEFORE the owner ever
 * creates/writes it - the SAME discipline `content-acl.test.js`'s own top
 * doc comment establishes ("Subscribes BEFORE alice creates it ... rather
 * than racing a real catch-up mechanism this bare peer<->peer harness (no
 * relay/replay in the loop) doesn't provide"). This harness has no relay to
 * replay history for a LATE subscriber - `Space._handleIncoming()`'s own
 * write path drops any envelope for a nodeId this Space isn't already
 * attached to (`this._nodes.get(nodeId)` miss - "not subscribed to this
 * Node - ordinary relay fan-out, not an error"), permanently, no retry. A
 * subscribe issued AFTER the owner already wrote looks like it sometimes
 * works in a quick manual run (the write can still be QUEUED, not yet
 * dequeued, when the late subscribe's own synchronous `_attach()` call
 * runs) - that is a timing coincidence, not a guarantee, and every id below
 * (Group AND chat Node alike) is subscribed early specifically to not rely
 * on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { EventBus } from '@qu/events';
import { defineKind, deriveContentNodeId } from '../src/kind-schema.js';
import { Space } from '../src/space.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

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

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

// Local, wire-compatible echo of @qu/app-core's real groupKind - same kind string ('qu-group'), same
// 'members' field shape/visibility as space.js's own internal GROUP_REF_KIND - see this file's own
// top doc comment.
const groupKind = defineKind('qu-group', {
  fields: {
    name: { shape: 'atomic', visibility: 'public' },
    members: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'content' },
});

const chatKind = defineKind('chat-message', {
  fields: { text: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'group' },
});

function toBase64Pair({ pub, xPub }) {
  return { pub: QuCrypto.toBase64(pub), xPub: xPub ? QuCrypto.toBase64(xPub) : undefined };
}

test("'group'-ACL: a current group member's write is accepted", async () => {
  const owner = await actor();
  const bob = await actor(); // group member.
  const [ownerTransport, bobTransport] = pairTransports();
  const spaceMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const ownerSpace = new Space({ identity: owner, members: spaceMembers, transport: ownerTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };

  // bob subscribes to BOTH ids before owner creates/writes either - see this file's own top doc comment.
  const bobGroupNode = bobSpace.subscribeNode(groupId, groupKind);
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await waitUntil(async () => ((await bobGroupNode.field('members').get()) ?? []).length === 2); // bob must ALSO verify owner's own initial chat write below - warm his own group cache first.

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'hello from owner' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  assert.equal(ownerChatNode.id, chatId);
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'hello from owner');

  // owner must ALSO be able to verify bob's reply below - no separate warming needed: owner created
  // the Group itself, so its data is ALREADY locally available the instant _currentGroupMembers()'s
  // first cold read runs (see that method's own doc comment - it never blocks on network I/O, it
  // just reads whatever this Space already has locally right now).

  // Bob is an actual member - his write is accepted.
  await bobChatNode.field('text').set('hi from bob, a real member');
  await waitUntil(async () => (await ownerChatNode.field('text').get()) === 'hi from bob, a real member');
});

test("'group'-ACL: a non-member's write is silently rejected (fail closed), even though they know the group's exact name/owner", async () => {
  const owner = await actor();
  const bob = await actor(); // the group's only real member besides owner.
  const mallory = await actor(); // NOT a member.
  const [ownerTransport, malloryTransport] = pairTransports();
  const spaceMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: mallory.signingPub, xPub: mallory.xPublicKey },
  ];

  const ownerSpace = new Space({ identity: owner, members: spaceMembers, transport: ownerTransport });
  const mallorySpace = new Space({ identity: mallory, members: spaceMembers, transport: malloryTransport });

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };

  const malloryGroupNode = mallorySpace.subscribeNode(groupId, groupKind);
  const malloryChatNode = mallorySpace.subscribeNode(chatId, chatKind, { groupRef });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await waitUntil(async () => ((await malloryGroupNode.field('members').get()) ?? []).length === 2); // mallory must ALSO verify owner's own initial write below.

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await malloryChatNode.field('text').get()) === 'v1');

  await malloryChatNode.field('text').set('hacked by mallory, not a member');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await ownerChatNode.field('text').get(), 'v1', "a non-member's write must never reach the group owner's own copy");
});

test("'group'-ACL: a write whose claimed groupRef does not actually derive this exact nodeId is rejected outright, even from a genuine group member", async () => {
  const owner = await actor();
  const bob = await actor();
  const [ownerTransport, bobTransport] = pairTransports();
  const spaceMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const ownerSpace = new Space({ identity: owner, members: spaceMembers, transport: ownerTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1'); // the REAL group bob is in.
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1'); // the REAL room1 chat id.
  // bob subscribes to room1's REAL chatId but claims groupRef for a NEVER-CREATED "room2" instead -
  // a forged/mismatched claim: deriveContentNodeId(owner, chatKind.kind, "room2") !== chatId, so the
  // self-certifying check must reject this outright before membership is ever consulted at all.
  const forgedGroupRef = { groupOwnerPub: owner.signingPub, groupName: 'room2' };

  const bobGroupNode = bobSpace.subscribeNode(groupId, groupKind);
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef: forgedGroupRef });

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await waitUntil(async () => ((await bobGroupNode.field('members').get()) ?? []).length === 2); // bob must ALSO verify owner's own initial chat write below (using the REAL groupRef it carries).

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  assert.equal(ownerChatNode.id, chatId);
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'v1');

  await bobChatNode.field('text').set('should be rejected - forged groupRef does not self-certify against this nodeId');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await ownerChatNode.field('text').get(), 'v1');
});

test("'group'-ACL: adding a member takes effect live (the membership cache picks up the group's 'changed' event) without needing to re-subscribe", async () => {
  const owner = await actor();
  const bob = await actor(); // starts OUTSIDE the group.
  const [ownerTransport, bobTransport] = pairTransports();
  const spaceMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const ownerBus = new EventBus();
  const ownerSpace = new Space({ identity: owner, members: spaceMembers, transport: ownerTransport, bus: ownerBus });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };

  const bobGroupNode = bobSpace.subscribeNode(groupId, groupKind);
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });

  const ownerGroupNode = await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub })] }, { path: 'room1' });
  await waitUntil(async () => ((await bobGroupNode.field('members').get()) ?? []).length === 1);

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'v1');

  // Bob is NOT yet a member here - deliberately never attempted below: a REJECTED write is never
  // integrated into the Node's Yjs history at all (Space._handleIncoming()'s own doc comment on
  // `verifyEnvelope()` - "reject before it ever touches the CRDT"), which leaves a PERMANENT GAP in
  // bob's own per-author update sequence for this exact Node - Yjs cannot skip a gap in one
  // author's causal history, so it would silently block integrating EVERY LATER write from bob to
  // THIS SAME Node too, even a genuinely authorized one (the exact "WRITE-BEFORE-GRANT IS A TRAP"
  // mechanism grant.js's own doc comment already describes for 'named'/'content' mode's own
  // grant-then-write ordering) - a test artifact of attempting two writes from the SAME author to
  // the SAME Node, not a 'group'-ACL-specific concern. The plain rejection case (a non-member's
  // write never reaching the owner) is already covered on its own by this file's own "silently
  // rejected" test above; this test's only job is the LIVE cache update once bob genuinely joins.

  // owner grows the group to include bob - writing directly on the SAME node handle createNode()
  // itself returned (never a separate useNode()/release() pair - see the "history unaffected" test
  // below for why that would immediately unsubscribe/detach this exact Node on owner's own Space).
  // This is a genuine `qu-group`-kind field write, which fires this group Node's OWN
  // `space.node.<groupId>.changed` event that `_currentGroupMembers()`'s live cache picks up (owner's
  // own cache gets warmed lazily by this very write's own local emit).
  await ownerGroupNode.field('members').set([toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })]);

  await new Promise((resolve) => setTimeout(resolve, 100)); // let the local 'changed' event (same-process, same Y.Doc) propagate to the cache.

  // Bob's FIRST EVER write to this Node, sent only now that he is genuinely a member - accepted.
  await bobChatNode.field('text').set('now accepted - bob just became a member');
  await waitUntil(async () => (await ownerChatNode.field('text').get()) === 'now accepted - bob just became a member');
});

test("'group'-ACL: an existing message's already-sealed history is unaffected by a later membership change (only future writes are governed by CURRENT membership)", async () => {
  const owner = await actor();
  const bob = await actor();
  const [ownerTransport, bobTransport] = pairTransports();
  const spaceMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const ownerBus = new EventBus();
  const ownerSpace = new Space({ identity: owner, members: spaceMembers, transport: ownerTransport, bus: ownerBus });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');
  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'room1' };

  const bobGroupNode = bobSpace.subscribeNode(groupId, groupKind);
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });

  const ownerGroupNode = await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await waitUntil(async () => ((await bobGroupNode.field('members').get()) ?? []).length === 2);

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'v1');

  // owner must ALSO be able to verify bob's write below - no separate warming needed, see the
  // "member's write is accepted" test above for why (owner already has its own Group data locally).

  await bobChatNode.field('text').set('bob wrote this while still a member');
  await waitUntil(async () => (await ownerChatNode.field('text').get()) === 'bob wrote this while still a member');

  // owner removes bob from the group - writing directly on the SAME node handle createNode() itself
  // returned (never a separate useNode()/release() pair - releasing a refcount that was never
  // incremented by createNode() in the first place would immediately unsubscribe/detach this exact
  // Node on owner's OWN Space when warmNodeTTL is 0 (the default here), wiping out the very group
  // data this test's own later assertions depend on - a real bug this file's own history hit while
  // being written).
  await ownerGroupNode.field('members').set([toBase64Pair({ pub: owner.signingPub })]);
  await new Promise((resolve) => setTimeout(resolve, 100));

  // bob's EARLIER write is still there, unmodified - removal is never retroactive.
  assert.equal(await ownerChatNode.field('text').get(), 'bob wrote this while still a member');

  // but a FURTHER write from bob is now rejected (his own per-author update sequence for this Node
  // stays intact - this write is simply the LAST one ever accepted from him here, never followed by
  // another attempt in this test, so no "WRITE-BEFORE-GRANT"-style causal gap concern applies - see
  // the "adding a member" test above for the full explanation of why order matters there).
  await bobChatNode.field('text').set('should be rejected - bob was just removed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await ownerChatNode.field('text').get(), 'bob wrote this while still a member');
});

test("'group'-ACL: a write with no groupRef at all is rejected outright (fail-closed, nothing to check membership against)", async () => {
  const owner = await actor();
  const bob = await actor();
  const [ownerTransport, bobTransport] = pairTransports();
  const spaceMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const ownerSpace = new Space({ identity: owner, members: spaceMembers, transport: ownerTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'room1');
  const chatId = await deriveContentNodeId(owner.signingPub, chatKind.kind, 'room1');

  const bobGroupNode = bobSpace.subscribeNode(groupId, groupKind);
  // bob subscribes WITHOUT ever supplying groupRef - his own outgoing writes carry no groupRef at
  // all, so even though he IS a genuine member, _isAuthorizedWriter() has nothing to check against
  // (rejected before _currentGroupMembers() is ever consulted for HIS OWN write).
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind);

  await ownerSpace.createNode(groupKind, { name: 'room1', members: [toBase64Pair({ pub: owner.signingPub }), toBase64Pair({ pub: bob.signingPub })] }, { path: 'room1' });
  await waitUntil(async () => ((await bobGroupNode.field('members').get()) ?? []).length === 2); // bob must correctly RECEIVE owner's genuine chat write below (which DOES carry the real groupRef).

  const ownerChatNode = await ownerSpace.createNode(chatKind, { text: 'v1' }, { groupOwnerPub: owner.signingPub, groupName: 'room1' });
  await waitUntil(async () => (await bobChatNode.field('text').get()) === 'v1');

  await bobChatNode.field('text').set('should be rejected - no groupRef attached to this write at all');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await ownerChatNode.field('text').get(), 'v1');
});
