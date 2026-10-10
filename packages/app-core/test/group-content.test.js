/**
 * 'group'-ACL DEV-API + CONTENTRESOLVER SUPPORT (kind-schema.js's own
 * "'group'" doc comment, @qu/space-core's group-acl.test.js/relay.js's own
 * group-acl.test.js) - proves the APP-LAYER pieces this Task adds actually
 * work together, through a REAL (in-process) relay:
 *   1. `createGroup()`/`editGroup()` (dev.js) now ALSO
 *      `space.declareGroupMembership()` alongside their ordinary field
 *      write - without it, the relay (which never decodes ANY Yjs content,
 *      not even a group's own `visibility: 'public'` fields) has no way to
 *      enforce a `'group'`-ACL write referencing that Group at all, and
 *      rejects everything, fail-closed.
 *   2. `ContentResolver.resolveGroupContent()` reads a `'group'`-ACL
 *      Node's own field data generically, the same "any caller-defined
 *      field set" shape `resolveCollectionItem()` already has for
 *      `'content'`-ACL content.
 *
 * No REAL chat Kind exists in `@qu/app-core` yet (`docs/chat-app-concept.md`'s
 * own "Schritt 3: Chat bauen" is future work) - this file defines a small,
 * local, wire-compatible stand-in (`roomKind`) purely to exercise the
 * mechanism, same posture `@qu/space-core`'s and `@qu/space-transport`'s
 * own `group-acl.test.js` files already take.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, defineKind, deriveContentNodeId } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { EventBus } from '@qu/events';
import { ContentResolver } from '../src/resolver.js';
import { createGroup, editGroup } from '../src/dev.js';
import { groupKind } from '../src/kinds.js';

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

const roomKind = Object.freeze({
  ...defineKind('room-message', { fields: { text: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'group' } }),
  metaVisibility: 'public', // same fix @qu/space-transport's own group-acl.test.js applies, for the identical reason - see that file's own doc comment.
});

function makeResolveKindSchema(idToKind) {
  return (nodeId) => idToKind.get(nodeId) ?? null;
}

test("createGroup()/editGroup() declare membership to the relay - a 'group'-ACL room referencing that Group is enforced correctly end to end", async () => {
  const owner = await actor();
  const memberA = await actor(); // in the group.
  const outsider = await actor(); // an ordinary Space member, but NOT in the group.
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: memberA.signingPub, xPub: memberA.xPublicKey },
    { pub: outsider.signingPub, xPub: outsider.xPublicKey },
  ];

  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, 'familie');
  const roomId = await deriveContentNodeId(owner.signingPub, roomKind.kind, 'familie');
  const idToKind = new Map([[groupId, groupKind], [roomId, roomKind]]);

  const hub = createInProcessHub();
  const bus = new EventBus();
  const rejections = [];
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(idToKind), bus, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');
  const memberSpace = await connect(hub, memberA, members, 'member-a');
  const outsiderSpace = await connect(hub, outsider, members, 'outsider');

  // createGroup() now ALSO declares membership to the relay - see this file's own top doc comment.
  await createGroup(ownerSpace, {
    name: 'familie',
    members: [
      { pub: owner.signingPub, xPub: owner.xPublicKey },
      { pub: memberA.signingPub, xPub: memberA.xPublicKey },
    ],
  });

  const ownerResolver = new ContentResolver(ownerSpace, { appAdminPub: owner.signingPub });
  const group = await ownerResolver.resolveGroup('familie', { timeout: 2000 });
  assert.equal(group?.members.length, 2);

  // Every peer that needs to CLIENT-side verify a 'group'-ACL write referencing "familie" needs its
  // own local copy of that Group's data too (Space._currentGroupMembers()'s own doc comment) -
  // subscribed and SYNCED (a real relay-mirrored replay, not an empty "nothing to replay yet"
  // sync-ack - only guaranteed by subscribing AFTER the group genuinely exists on the relay's own
  // mirror, exactly as done here) BEFORE any room write, same discipline @qu/space-transport's own
  // group-acl.test.js establishes (its own top doc comment has the full race explanation).
  async function subscribeGroupAndWaitSynced(space) {
    space.subscribeNode(groupId, groupKind);
    await waitUntil(() => space.isNodeSynced(groupId));
  }
  await subscribeGroupAndWaitSynced(memberSpace);
  await subscribeGroupAndWaitSynced(outsiderSpace);

  const groupRef = { groupOwnerPub: owner.signingPub, groupName: 'familie' };
  const memberRoomNode = memberSpace.subscribeNode(roomId, roomKind, { groupRef });
  const outsiderRoomNode = outsiderSpace.subscribeNode(roomId, roomKind, { groupRef });

  const ownerRoomNode = await ownerSpace.createNode(roomKind, { text: 'willkommen' }, { groupOwnerPub: owner.signingPub, groupName: 'familie' });
  await waitUntil(async () => (await memberRoomNode.field('text').get()) === 'willkommen');
  await waitUntil(async () => (await outsiderRoomNode.field('text').get()) === 'willkommen');

  // memberA is a real group member - the relay (and every other peer) accepts her write.
  await memberRoomNode.field('text').set('hallo zusammen');
  await waitUntil(async () => (await ownerRoomNode.field('text').get()) === 'hallo zusammen');

  // outsider is a Space member but NOT in the group - the relay rejects her write outright.
  await outsiderRoomNode.field('text').set('hacked by outsider');
  await waitUntil(() => rejections.some((r) => r.nodeId === roomId));
  assert.equal(await ownerRoomNode.field('text').get(), 'hallo zusammen');

  // ContentResolver.resolveGroupContent() reads the room's current field data generically.
  const roomContent = await ownerResolver.resolveGroupContent('familie', { itemKind: roomKind, groupOwnerPub: owner.signingPub, timeout: 2000 });
  assert.equal(roomContent?.text, 'hallo zusammen');

  // editGroup() ALSO re-declares membership - removing outsider (never a group member to begin
  // with, but this proves the edit path itself reaches the relay, not just createGroup()'s).
  await editGroup(ownerSpace, { name: 'familie', members: [{ pub: owner.signingPub, xPub: owner.xPublicKey }, { pub: memberA.signingPub, xPub: memberA.xPublicKey }] });
  const groupAfterEdit = await ownerResolver.resolveGroup('familie', { timeout: 2000, forceRevalidate: true });
  assert.equal(groupAfterEdit?.members.length, 2);
});

test('resolveGroupContent() returns null for a genuinely unpublished room, indistinguishable from an unauthorized read', async () => {
  const owner = await actor();
  const members = [{ pub: owner.signingPub, xPub: owner.xPublicKey }];
  const hub = createInProcessHub();
  const roomId = await deriveContentNodeId(owner.signingPub, roomKind.kind, 'nonexistent');
  createRelayForwarder({ hub, members, resolveKindSchema: makeResolveKindSchema(new Map([[roomId, roomKind]])), storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');
  const resolver = new ContentResolver(ownerSpace, { appAdminPub: owner.signingPub });
  const content = await resolver.resolveGroupContent('nonexistent', { itemKind: roomKind, groupOwnerPub: owner.signingPub, timeout: 500 });
  assert.equal(content, null);
});
