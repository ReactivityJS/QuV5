/**
 * createAppResolveKindSchema({ groupKinds }) — proves the REAL deployment
 * resolver (not a hand-rolled test-only `idToKind` map, like every other
 * messenger.test.js scenario uses) can classify a `'group'`-ACL Kind at
 * all. Before `groupKinds` existed, `createAppResolveKindSchema()`'s
 * fallback chain ended in `pageKind` ('content'-ACL) for any id it didn't
 * recognize - coincidentally harmless for `groupKind` itself (also
 * 'content'-ACL, same shape) but actively wrong for a real `'group'`-ACL
 * Kind like `messenger.js`'s own `chatKind`: writes to it would be
 * evaluated against the WRONG ACL mode and rejected outright, meaning the
 * messenger could never work through `@qu/app-shell`'s real relay
 * deployment path, only in isolated unit tests that side-step this
 * resolver entirely. See relay-resolver.js's own "'GROUP'-ACL KINDS" doc
 * comment for the full "why".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { createGroup } from '../src/dev.js';
import { groupKind } from '../src/kinds.js';
import { deriveContentNodeId } from '../src/content-id.js';
import { chatKind, chatNodeId, sendMessage } from '../src/messenger.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport });
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test("createAppResolveKindSchema({ groupKinds: [chatKind] }): a 'group'-ACL chat Node writes and reads correctly through the REAL app-shell relay resolver, no hand-rolled idToKind map needed", async () => {
  const owner = await actor();
  const member = await actor();
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: member.signingPub, xPub: member.xPublicKey },
  ];

  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: owner.signingPub, groupKinds: [chatKind] });
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');
  const memberSpace = await connect(hub, member, members, 'member');

  const groupName = 'resolver-check';
  await createGroup(ownerSpace, { name: groupName, members });
  await ownerSpace.createNode(
    chatKind,
    { name: 'Resolver Check' },
    { groupOwnerPub: owner.signingPub, groupName, recipients: members.map((m) => m.xPub) }
  );

  // Pre-sync the Group ITSELF first, same discipline every other consumer of a 'group'-ACL Kind
  // already follows (ContentResolver.resolveGroup(), and messenger.test.js's own
  // subscribeGroupAndWaitSynced() helper) - Space._currentGroupMembers()'s own doc comment explains
  // why: it reads whatever this Space ALREADY has locally, synchronously, never awaiting the network,
  // so a chat write verified before the Group's own membership has arrived is correctly (if
  // unhelpfully) treated as "nobody authorized yet" and silently dropped - not a bug, a documented
  // fail-closed default any real caller must warm past first.
  const groupId = await deriveContentNodeId(owner.signingPub, groupKind.kind, groupName);
  memberSpace.subscribeNode(groupId, groupKind);
  await waitUntil(() => memberSpace.isNodeSynced(groupId));

  const chatId = await chatNodeId(owner.signingPub, groupName);
  const groupRef = { groupOwnerPub: owner.signingPub, groupName };
  const memberChatNode = memberSpace.subscribeNode(chatId, chatKind, { groupRef });

  await sendMessage(ownerSpace, { groupOwnerPub: owner.signingPub, groupName }, { text: 'via the real relay resolver' });
  await waitUntil(async () => (await memberChatNode.field('messages').toArray()).length === 1);
  assert.equal((await memberChatNode.field('messages').toArray())[0].text, 'via the real relay resolver');
});

test('createAppResolveKindSchema() WITHOUT groupKinds (the default): a group-ACL write is misclassified against the pageKind fallback and rejected - the exact gap groupKinds fixes', async () => {
  const owner = await actor();
  const members = [{ pub: owner.signingPub, xPub: owner.xPublicKey }];

  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: owner.signingPub }); // no groupKinds.
  const hub = createInProcessHub();
  const rejections = [];
  const { EventBus } = await import('@qu/events');
  const bus = new EventBus();
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  createRelayForwarder({ hub, members, resolveKindSchema, bus, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');
  const groupName = 'unclassified-chat';
  await createGroup(ownerSpace, { name: groupName, members });
  await ownerSpace.createNode(
    chatKind,
    { name: 'Unclassified' },
    { groupOwnerPub: owner.signingPub, groupName, recipients: members.map((m) => m.xPub) }
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    rejections.some((r) => r.reason === 'bad-signature'),
    "the chat Node's own creation write is rejected: classified as pageKind ('content'-ACL, grant-only), which the owner's self-certifying 'group'-ACL write was never shaped to satisfy"
  );
});
