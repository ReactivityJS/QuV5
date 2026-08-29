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

const noteKind = defineKind('note', { fields: { title: 'atomic-encrypted' } });

test('a relay constructed with one member rejects a write from a second, not-yet-added identity', async () => {
  const alice = await actor();
  const bob = await actor();
  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => noteKind });

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }], transport: bobTransport });
  await bobSpace.createNode(noteKind, { title: 'x' }, { id: 'note-1' });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(relay.seen.length, 0); // bob isn't a member yet - dropped at signature verification.
});

test('addMember() lets a relay accept writes from a newly registered identity, without restarting', async () => {
  const alice = await actor();
  const bob = await actor();
  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => noteKind });

  relay.addMember({ pub: bob.signingPub, xPub: bob.xPublicKey });

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }], transport: bobTransport });
  await bobSpace.createNode(noteKind, { title: 'x' }, { id: 'note-2' });

  await waitUntil(() => relay.seen.some((e) => e.nodeId === 'note-2'));
});

test('addMember() also lets the newly added identity send a signed hello and appear "online" in presence', async () => {
  const alice = await actor();
  const bob = await actor();
  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => noteKind });
  relay.addMember({ pub: bob.signingPub, xPub: bob.xPublicKey });

  const bobTransport = new InProcessTransport(hub, 'bob');
  await bobTransport.connect();
  new Space({ identity: bob, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }], transport: bobTransport });

  await waitUntil(() => relay.presence.isOnline(QuCrypto.toBase64(bob.signingPub)));
});

test('addMember() is idempotent - calling it twice for the same pubkey does not duplicate the member', async () => {
  const alice = await actor();
  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => noteKind });

  relay.addMember({ pub: alice.signingPub, xPub: alice.xPublicKey }); // already a member from construction
  relay.addMember({ pub: alice.signingPub, xPub: alice.xPublicKey }); // called again

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });
  await aliceSpace.createNode(noteKind, { title: 'x' }, { id: 'note-3' });

  await waitUntil(() => relay.seen.some((e) => e.nodeId === 'note-3'));
  // No assertion beyond "still works" - addMember() has no visible list to inspect from here;
  // the point is this doesn't throw or corrupt membership, proven by the write still succeeding.
});
