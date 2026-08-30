/**
 * AUTO-COMPACT ON JOIN — see auto-compact.js's own doc comment. Proves the
 * actual bug report this fixes: alice writes a message BEFORE bob is a
 * member; bob then joins late (exactly `demo/web/main.js`'s own "changed
 * my display name" case - a fresh identity, unknown to anyone until now).
 * WITHOUT `autoCompactOnJoin`, bob could never integrate ANY later message
 * from alice either (Yjs' gapless per-author ordering - see space.js's own
 * `debug.space.write.remote.undecryptable` doc comment) - not just the one
 * he missed. WITH it, alice's Space recompacts the room the instant it
 * learns bob joined, so a message alice sends AFTER that point reaches him
 * normally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { EventBus } from '@qu/events';
import { autoCompactOnJoin } from '../src/auto-compact.js';

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

const chatKind = defineKind('auto-compact-chat', { fields: { messages: { shape: 'list' } } }); // default visibility: 'encrypted' - the case with the gap.
const ROOM = 'room';

test('a member who joins after some history exists still receives later messages from an existing author, once autoCompactOnJoin is wired up', async () => {
  const alice = await actor();
  const bob = await actor();

  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => chatKind, storage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceBus = new EventBus();
  // alice's own Space starts out knowing only herself - matching a real room's own early history.
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, bus: aliceBus });
  autoCompactOnJoin(aliceSpace, aliceBus, [ROOM]);

  const aliceNode = aliceSpace.subscribeNode(ROOM, chatKind);
  await aliceNode.field('messages').push('written before bob existed');
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Bob joins late - unknown to alice/the relay while the message above was written.
  relay.addMember({ pub: bob.signingPub, xPub: bob.xPublicKey });

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({
    identity: bob,
    members: [
      { pub: alice.signingPub, xPub: alice.xPublicKey },
      { pub: bob.signingPub, xPub: bob.xPublicKey },
    ],
    transport: bobTransport,
  });
  const bobNode = bobSpace.subscribeNode(ROOM, chatKind);

  // Give alice's `space.member.joined` handler (autoCompactOnJoin) a chance to actually compact.
  await new Promise((resolve) => setTimeout(resolve, 50));

  await aliceNode.field('messages').push('written after bob joined');
  await waitUntil(async () => (await bobNode.field('messages').toArray()).some((m) => m === 'written after bob joined'));

  const bobMessages = await bobNode.field('messages').toArray();
  assert.ok(bobMessages.includes('written after bob joined'), 'bob must receive a message written by alice AFTER he joined');
});
