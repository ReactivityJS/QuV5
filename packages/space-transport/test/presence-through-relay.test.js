/**
 * PRESENCE THROUGH A REAL RELAY — proves `@qu/space-core`'s `presenceKind`
 * needs ZERO relay-side special-casing: a relay routes it through the
 * exact same `handleWrite()`/`handleSubscribe()` path as any other
 * `'owner'`-ACL Kind, mirroring it to `volatileStorage` because of its
 * `persistence: 'volatile'` flag alone (see relay.js's own "PERSISTENCE
 * TIERS" doc comment) - nothing about `resolveKindSchema` or the wire
 * protocol needs to know "presence" exists as a concept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, presenceKind, presenceNodeId, setStatus, setTyping, watchPresence } from '@qu/space-core';
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

test('presence/typing writes route through the relay like any owner-ACL Kind, durable storage never sees them', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const durableStorage = createMemoryStore();
  const volatileStorage = createMemoryStore();
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => presenceKind, storage: durableStorage, volatileStorage });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  await watchPresence(bobSpace, alice.signingPub); // subscribe first - see presence.test.js's own identical ordering note (no catch-up needed here since the relay mirrors, but this proves the live-forward path too).
  await setStatus(aliceSpace, 'in a call');
  await waitUntil(async () => (await watchPresence(bobSpace, alice.signingPub)).status === 'in a call');

  await setTyping(aliceSpace, 'some-room', true);
  await waitUntil(async () => (await watchPresence(bobSpace, alice.signingPub)).typingIn === 'some-room');

  const aliceNodeId = await presenceNodeId(alice.signingPub);
  assert.ok((await volatileStorage.load(aliceNodeId)).length > 0); // mirrored - a late subscriber would still catch up.
  assert.equal((await durableStorage.load(aliceNodeId)).length, 0); // never touches the durable tier.
});
