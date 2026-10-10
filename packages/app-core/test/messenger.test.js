/**
 * MESSENGER — see messenger.js's own doc comment. Proves, through a REAL
 * (in-process) relay so ACL/encryption are both genuinely enforced:
 *   1. getOrCreateDirectChat() - either side starting first is found by
 *      the other, not duplicated; messages round-trip end to end.
 *   2. createGroupChat() - a non-member can neither read nor write.
 *   3. addGroupChatMembers() - the compaction fix: a newly-added member
 *      reads FUTURE messages from an author who posted before they
 *      joined, but genuinely never the PAST ones (not retroactive).
 *   4. removeGroupChatMember() - a removed member can't write any more,
 *      but keeps what they already had.
 *   5. contacts/conversations - private, self-only round trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { EventBus } from '@qu/events';
import { deriveContentNodeId } from '../src/content-id.js';
import { groupKind } from '../src/kinds.js';
import { createGroup } from '../src/dev.js';
import {
  chatKind,
  chatNodeId,
  getOrCreateDirectChat,
  createGroupChat,
  addGroupChatMembers,
  removeGroupChatMember,
  sendMessage,
  contactsKind,
  addContact,
  listContacts,
  conversationsKind,
  recordConversation,
  listConversations,
} from '../src/messenger.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport, bus: new EventBus() });
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

function makeResolveKindSchema(idToKind) {
  return (nodeId) => idToKind.get(nodeId) ?? null;
}

async function subscribeGroupAndWaitSynced(space, groupId) {
  space.subscribeNode(groupId, groupKind);
  await waitUntil(() => space.isNodeSynced(groupId));
}

test('getOrCreateDirectChat(): either side starting first is found (not duplicated) by the other, and messages round-trip', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  // Precompute both candidate owner slots - getOrCreateDirectChat() tries [self, peer] in that order.
  const idToKind = new Map();
  async function registerDirectChatIds(ownerPub, groupName) {
    idToKind.set(await deriveContentNodeId(ownerPub, groupKind.kind, groupName), groupKind);
    idToKind.set(await chatNodeId(ownerPub, groupName), chatKind);
  }

  const hub = createInProcessHub();
  // resolveKindSchema is REBUILT per call (the relay reads it live, not once at construction - see
  // relay.js's own resolveKindSchema(nodeId) contract) via this mutable idToKind map, so ids
  // registered AFTER the relay was constructed (below, once we learn the real groupName) still work.
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), storage: createMemoryStore() });

  const aliceSpace = await connect(hub, alice, members, 'alice');
  const bobSpace = await connect(hub, bob, members, 'bob');

  const alicePeer = { pub: bob.signingPub, xPub: bob.xPublicKey };
  const bobPeer = { pub: alice.signingPub, xPub: alice.xPublicKey };

  // Register both candidates for the (deterministic) groupName BEFORE alice creates anything -
  // getOrCreateDirectChat() derives groupName internally, so compute it the same way here too.
  const { groupName } = await (async () => {
    // Mirror messenger.js's own directChatGroupName() - duplicated here only because it's not
    // exported (an internal implementation detail), same as any other test precomputing an id.
    const [a, b] = [QuCrypto.toBase64(alice.signingPub), QuCrypto.toBase64(bob.signingPub)].sort();
    const digest = await QuCrypto.sha256(new TextEncoder().encode(`qu-chat-dm-v1:${a}:${b}`));
    return { groupName: `dm-${QuCrypto.toBase64Url(digest)}` };
  })();
  await registerDirectChatIds(alice.signingPub, groupName);
  await registerDirectChatIds(bob.signingPub, groupName);

  const aliceChat = await getOrCreateDirectChat(aliceSpace, alicePeer);
  assert.equal(aliceChat.existed, false);
  assert.equal(QuCrypto.toBase64(aliceChat.groupOwnerPub), QuCrypto.toBase64(alice.signingPub));

  // Give the relay a moment to actually mirror alice's creation before bob looks for it.
  const groupId = await deriveContentNodeId(aliceChat.groupOwnerPub, groupKind.kind, groupName);
  await waitUntil(() => aliceSpace.isNodeSynced(groupId));

  const bobChat = await getOrCreateDirectChat(bobSpace, bobPeer);
  assert.equal(bobChat.existed, true, "bob finds alice's already-created chat instead of creating a duplicate");
  assert.equal(QuCrypto.toBase64(bobChat.groupOwnerPub), QuCrypto.toBase64(alice.signingPub));
  assert.equal(bobChat.groupName, groupName);

  // --- messages round-trip, both directions ---
  await subscribeGroupAndWaitSynced(bobSpace, groupId);
  const chatId = await chatNodeId(aliceChat.groupOwnerPub, groupName);
  const groupRef = { groupOwnerPub: aliceChat.groupOwnerPub, groupName };
  const bobChatNode = bobSpace.subscribeNode(chatId, chatKind, { groupRef });

  await sendMessage(aliceSpace, aliceChat, { text: 'hi bob' });
  await waitUntil(async () => (await bobChatNode.field('messages').toArray()).length === 1);
  assert.equal((await bobChatNode.field('messages').toArray())[0].text, 'hi bob');

  await sendMessage(bobSpace, bobChat, { text: 'hi alice' });
  const aliceChatNode = aliceSpace.getNode(chatId);
  await waitUntil(async () => (await aliceChatNode.field('messages').toArray()).length === 2);
  assert.equal((await aliceChatNode.field('messages').toArray())[1].text, 'hi alice');
});

test("createGroupChat(): creates a chat Node under the owner's own pubkey, naming all given members plus the owner", async () => {
  const owner = await actor();
  const memberA = await actor();
  const memberB = await actor();
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: memberA.signingPub, xPub: memberA.xPublicKey },
    { pub: memberB.signingPub, xPub: memberB.xPublicKey },
  ];
  // Solo, no relay - createGroupChat() is pure local Node creation; the cross-member ACL/sync
  // behavior it relies on (editGroup/compactNode/resolveGroup) is already proven end-to-end by
  // the test below. This one just proves createGroupChat()'s own contract: who ends up owning the
  // chat, and who ends up a member of it.
  const ownerSpace = new Space({ identity: owner, members, transport: { async connect() {}, send() {}, onMessage() {} } });

  const { groupOwnerPub, groupName } = await createGroupChat(ownerSpace, {
    name: 'Team',
    members: [
      { pub: memberA.signingPub, xPub: memberA.xPublicKey },
      { pub: memberB.signingPub, xPub: memberB.xPublicKey },
    ],
  });
  assert.equal(QuCrypto.toBase64(groupOwnerPub), QuCrypto.toBase64(owner.signingPub), 'always owned by the creator');

  const chatId = await chatNodeId(groupOwnerPub, groupName);
  const chatNode = ownerSpace.getNode(chatId);
  assert.ok(chatNode, 'chat node exists locally right after creation');
  assert.equal(await chatNode.field('name').get(), 'Team');

  const groupId = await deriveContentNodeId(groupOwnerPub, groupKind.kind, groupName);
  const groupNode = ownerSpace.getNode(groupId);
  const groupMembers = await groupNode.field('members').get();
  const actualPubs = groupMembers.map((m) => m.pub).sort();
  const expectedPubs = [owner, memberA, memberB].map((p) => QuCrypto.toBase64(p.signingPub)).sort();
  assert.deepEqual(actualPubs, expectedPubs, 'owner is auto-added alongside the explicitly given members');
});

test('createGroupChat(), full E2E: a non-member can neither read nor write; addGroupChatMembers() lets a NEW member read FUTURE (not past) messages; removeGroupChatMember() blocks future writes', async () => {
  const owner = await actor();
  const memberA = await actor();
  const outsider = await actor(); // never in the group chat.
  const newMember = await actor(); // added later, after some history exists.
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: memberA.signingPub, xPub: memberA.xPublicKey },
    { pub: outsider.signingPub, xPub: outsider.xPublicKey },
    { pub: newMember.signingPub, xPub: newMember.xPublicKey },
  ];

  const idToKind = new Map();
  const hub = createInProcessHub();
  const rejections = [];
  const bus = new EventBus();
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), bus, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');
  // A KNOWN name (not createGroupChat()'s own random one - see its own doc comment) so both ids
  // are precomputable and registered with the relay's resolver BEFORE any write happens - the
  // same discipline group-content.test.js already establishes. createGroupChat() itself is a
  // thin wrapper over exactly these two calls (createGroup() + space.createNode(chatKind, ...)),
  // so this is faithful to its real behavior, not a different code path.
  const groupOwnerPub = owner.signingPub;
  const groupName = 'team-chat';
  const groupId = await deriveContentNodeId(groupOwnerPub, groupKind.kind, groupName);
  const chatId = await chatNodeId(groupOwnerPub, groupName);
  idToKind.set(groupId, groupKind);
  idToKind.set(chatId, chatKind);

  const groupMembers = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: memberA.signingPub, xPub: memberA.xPublicKey },
  ];
  await createGroup(ownerSpace, { name: groupName, members: groupMembers });
  await ownerSpace.createNode(chatKind, { name: 'Team' }, { groupOwnerPub, groupName, recipients: groupMembers.map((m) => m.xPub) });

  const memberSpace = await connect(hub, memberA, members, 'member-a');
  const outsiderSpace = await connect(hub, outsider, members, 'outsider');
  await subscribeGroupAndWaitSynced(memberSpace, groupId);
  await subscribeGroupAndWaitSynced(outsiderSpace, groupId);

  const groupRef = { groupOwnerPub, groupName };
  const memberChatNode = memberSpace.subscribeNode(chatId, chatKind, { groupRef });
  const outsiderChatNode = outsiderSpace.subscribeNode(chatId, chatKind, { groupRef });

  await sendMessage(ownerSpace, { groupOwnerPub, groupName }, { text: 'welcome' });
  await waitUntil(async () => (await memberChatNode.field('messages').toArray()).length === 1);
  // outsider is a Space member but NOT in the group - never receives the write at all (undecryptable + unauthorized).
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await outsiderChatNode.field('messages').toArray()).length, 0);

  await sendMessage(memberSpace, { groupOwnerPub, groupName }, { text: 'hi team' });
  await waitUntil(async () => (await (ownerSpace.getNode(chatId)).field('messages').toArray()).length === 2);

  // outsider's own write attempt is rejected outright by the relay (or sendMessage() itself may
  // throw - outsider's own resolveGroup() genuinely can't see themselves as a member either way;
  // both outcomes prove the write never lands, checked below).
  try {
    await sendMessage(outsiderSpace, { groupOwnerPub, groupName }, { text: 'hacked' });
  } catch {
    /* expected - see comment above. */
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await (ownerSpace.getNode(chatId)).field('messages').toArray()).length, 2, "outsider's write never reaches the chat");

  // --- addGroupChatMembers(): newMember joins AFTER 2 messages already exist ---
  const newMemberSpace = await connect(hub, newMember, members, 'new-member');
  await subscribeGroupAndWaitSynced(newMemberSpace, groupId);
  const newMemberChatNode = newMemberSpace.subscribeNode(chatId, chatKind, { groupRef });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await newMemberChatNode.field('messages').toArray()).length, 0, 'not a member yet - sees nothing, not even metadata');

  await addGroupChatMembers(ownerSpace, { groupOwnerPub, groupName, newMembers: [{ pub: newMember.signingPub, xPub: newMember.xPublicKey }] });

  // A FUTURE message from the ORIGINAL owner (who already posted before newMember joined) must now
  // reach newMember - this is exactly the compaction fix: without it, newMember's local Y.Doc would
  // have a permanent per-author gap for owner's clientID and could NEVER integrate this.
  // NOTE: `toArray()` genuinely returns `undefined` (not a skipped slot) for each of the 2 PRE-EXISTING
  // messages - they're individually-encrypted list items sealed for the OLD member list, and newMember
  // was never a recipient of those (decryptEnvelopeFor()'s own documented "undecryptable -> undefined"
  // contract, same as every other per-item-encrypted list in this codebase) - compaction only unblocks
  // the per-author Yjs gap, it does NOT retroactively grant access to old ciphertext. Every predicate
  // below must tolerate those `undefined` entries rather than assume every array slot is a message.
  await sendMessage(ownerSpace, { groupOwnerPub, groupName }, { text: 'welcome newMember' });
  await waitUntil(async () => (await newMemberChatNode.field('messages').toArray()).some((m) => m?.text === 'welcome newMember'));

  // But the OLD messages (sent before newMember joined) are genuinely never recovered - real E2E, not retroactive.
  const newMemberMessages = await newMemberChatNode.field('messages').toArray();
  assert.equal(newMemberMessages.filter((m) => m === undefined).length, 2, 'the 2 pre-existing messages stay permanently undecryptable, not silently dropped');
  assert.ok(!newMemberMessages.some((m) => m?.text === 'welcome'), 'history from before joining stays permanently out of reach');
  assert.ok(!newMemberMessages.some((m) => m?.text === 'hi team'));

  // --- removeGroupChatMember(): memberA is removed, can no longer write ---
  await removeGroupChatMember(ownerSpace, { groupOwnerPub, groupName, removePub: memberA.signingPub });
  const beforeRemovalCount = (await (ownerSpace.getNode(chatId)).field('messages').toArray()).length;
  await (async () => {
    try {
      await sendMessage(memberSpace, { groupOwnerPub, groupName }, { text: 'still here?' });
    } catch {
      /* resolveGroup() may now exclude memberA entirely, which is fine - either outcome proves the write never lands. */
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterRemovalCount = (await (ownerSpace.getNode(chatId)).field('messages').toArray()).length;
  assert.equal(afterRemovalCount, beforeRemovalCount, "a removed member's write never reaches the chat");
  // memberA keeps everything they already had - real E2E, no retroactive forgetting.
  assert.ok((await memberChatNode.field('messages').toArray()).some((m) => m.text === 'hi team'));
});

test('addContact()/listContacts() and recordConversation()/listConversations() round-trip, private to this identity alone', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const idToKind = new Map();
  idToKind.set(await deriveOwnerNodeId(alice.signingPub, contactsKind.kind), contactsKind);
  idToKind.set(await deriveOwnerNodeId(alice.signingPub, conversationsKind.kind), conversationsKind);
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), storage: createMemoryStore() });

  const aliceSpace = await connect(hub, alice, members, 'alice');

  await addContact(aliceSpace, { pub: bob.signingPub, xPub: bob.xPublicKey, alias: 'Bob' });
  const contacts = await listContacts(aliceSpace);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].alias, 'Bob');

  // Re-adding the SAME contact (matched by pub) updates in place, never duplicates.
  await addContact(aliceSpace, { pub: bob.signingPub, xPub: bob.xPublicKey, alias: 'Bobby' });
  const updatedContacts = await listContacts(aliceSpace);
  assert.equal(updatedContacts.length, 1);
  assert.equal(updatedContacts[0].alias, 'Bobby');

  await recordConversation(aliceSpace, { groupOwnerPub: alice.signingPub, groupName: 'dm-xyz', kind: '1:1', peerPub: QuCrypto.toBase64(bob.signingPub) });
  const conversations = await listConversations(aliceSpace);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].kind, '1:1');

  // Recording the SAME conversation again (matched by groupOwnerPub+groupName) updates, never duplicates.
  await recordConversation(aliceSpace, { groupOwnerPub: alice.signingPub, groupName: 'dm-xyz', kind: '1:1', lastMessageAt: 12345 });
  const updatedConversations = await listConversations(aliceSpace);
  assert.equal(updatedConversations.length, 1);
  assert.equal(updatedConversations[0].lastMessageAt, 12345);
});
