/**
 * END-TO-END POC DEMO — two peers, one blind relay, one durable store,
 * one Kind with an atomic-encrypted + a collaborative text field, one Kind
 * with a Yjs-native list. Proves, in one place, every property the V5
 * redesign was meant to deliver (see docs/v5-space-core-guide.md):
 *
 *   1. Signed, collision-free sync between Client A <-> Relay <-> Client B.
 *   2. Real CRDT merge for concurrent character-level text edits.
 *   3. Concurrent list appends converge without any custom cursor logic.
 *   4. The relay verifies signatures but never decrypts anything - it is
 *      handed no X25519 private key, so it structurally cannot.
 *   5. Durable storage holds the exact same sealed envelopes that went
 *      over the wire; reloading a Node from storage reconstructs it
 *      correctly, still without ever exposing plaintext to storage itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space, sealUpdate } from '@qu/space-core';
import { createDurableStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '../src/index.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

/**
 * Every hop between two Spaces (seal -> relay verify -> deliver -> open ->
 * applyUpdate) does real WebCrypto work (Ed25519/X25519/AES-GCM), and each
 * of those hops is deliberately fire-and-forget from the caller's point of
 * view (see space.js's `doc.on('update', ...)` handler) - exactly how a
 * real CRDT sync layer behaves: a local edit applies instantly, delivery
 * to other peers happens in the background. A test therefore has to wait
 * for the OBSERVABLE effect of delivery, not a fixed number of ticks -
 * a single `setImmediate` is not enough once several such hops chain
 * together (confirmed by this test flaking until this helper replaced it).
 */
async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const noteKind = defineKind('note', { fields: { title: 'atomic-encrypted', body: 'text' } });
const channelKind = defineKind('channel', { fields: { messages: 'list' } });

test('client A <-> relay <-> client B: signed, encrypted, collision-free sync; relay never sees plaintext; durable reload works', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const hub = createInProcessHub();
  const relayStore = createDurableStore(); // relay's own durable log, inspected below via _backingStore.
  const kindsById = new Map(); // relay-side routing table: nodeId -> Kind-Schema (metadata only, no content).
  const relay = createRelayForwarder({
    hub,
    members,
    resolveKindSchema: (nodeId) => kindsById.get(nodeId),
    storage: relayStore,
  });
  // The relay is constructed from PUBLIC keys only - assert it was never handed anything decryptable.
  assert.equal('xPrivateKey' in relay, false);

  const aliceDurable = createDurableStore();
  const bobDurable = createDurableStore();

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, storage: aliceDurable });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, storage: bobDurable });

  // --- 1. Note: atomic-encrypted title + collaborative text body ---
  const aliceNote = await aliceSpace.createNode(noteKind, { title: 'Ideensammlung' }, { id: 'note-1' });
  kindsById.set('note-1', noteKind);
  const bobNote = bobSpace.subscribeNode('note-1', noteKind);

  await waitUntil(async () => (await bobNote.field('title').get()) === 'Ideensammlung'); // wait for the create envelope to reach Bob
  aliceNote.field('body').insert(0, 'Hallo ');
  await waitUntil(() => bobNote.field('body').get() === 'Hallo '); // wait for the relay-forwarded envelope to reach Bob
  bobNote.field('body').insert(6, 'Welt');
  await waitUntil(() => aliceNote.field('body').get() === 'Hallo Welt'); // wait for Bob's edit to come back to Alice

  assert.equal(bobNote.field('body').get(), aliceNote.field('body').get());
  assert.equal(aliceNote.field('body').get(), 'Hallo Welt');
  assert.equal(await bobNote.field('title').get(), 'Ideensammlung'); // Bob is an authorized recipient.

  // --- 2. Channel: Yjs-native list, concurrent appends from both peers ---
  const aliceChannel = await aliceSpace.createNode(channelKind, {}, { id: 'chan-1' });
  kindsById.set('chan-1', channelKind);
  const bobChannel = bobSpace.subscribeNode('chan-1', channelKind);

  await aliceChannel.field('messages').push('hi from alice');
  await bobChannel.field('messages').push('hi from bob'); // "concurrent" - fired before either awaited the other's delivery
  await waitUntil(() => aliceChannel.field('messages').length === 2 && bobChannel.field('messages').length === 2);

  const aliceList = await aliceChannel.field('messages').toArray();
  const bobList = await bobChannel.field('messages').toArray();
  assert.equal(aliceList.length, 2);
  assert.deepEqual(aliceList, bobList); // deterministic convergence, no custom ordering code involved.

  // --- 3. The relay never saw plaintext, for either Node ---
  assert.ok(relay.seen.length >= 3); // title write + at least one body edit + at least one list push
  const relayLogText = JSON.stringify(relay.seen, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  for (const needle of ['Ideensammlung', 'Hallo Welt', 'hi from alice', 'hi from bob']) {
    assert.equal(relayLogText.includes(needle), false, `relay log must never contain plaintext "${needle}"`);
  }
  // Same check against the relay's OWN durable log, not just its in-memory "seen" trace.
  const relayStoredText = JSON.stringify([...relayStore._backingStore], (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  for (const needle of ['Ideensammlung', 'Hallo Welt', 'hi from alice', 'hi from bob']) {
    assert.equal(relayStoredText.includes(needle), false, `relay's own durable log must never contain plaintext "${needle}"`);
  }

  // --- 4. Durable reload: reconstruct Bob's note from storage alone, without the live Space ---
  const reloadedSpace = new Space({ identity: bob, members, transport: new InProcessTransport(createInProcessHub(), 'bob-reloaded'), storage: bobDurable });
  const reloadedNote = await reloadedSpace.loadNode('note-1', noteKind);
  assert.equal(reloadedNote.field('body').get(), 'Hallo Welt');
  assert.equal(await reloadedNote.field('title').get(), 'Ideensammlung');

  // And the durable log itself, like the relay's, is ciphertext-only.
  const durableLogText = JSON.stringify([...bobDurable._backingStore], (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  for (const needle of ['Ideensammlung', 'Hallo Welt']) {
    assert.equal(durableLogText.includes(needle), false, `durable storage must never contain plaintext "${needle}"`);
  }
});

test('relay rejects a write from a non-member (signature not on the write-ACL)', async () => {
  const alice = await actor();
  const mallory = await actor(); // not a space member
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];

  const hub = createInProcessHub();
  const kindsById = new Map([['note-1', noteKind]]);
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: (id) => kindsById.get(id) });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const malloryTransport = new InProcessTransport(hub, 'mallory');
  await aliceTransport.connect();
  await malloryTransport.connect();

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  await aliceSpace.createNode(noteKind, { title: 'echt' }, { id: 'note-1' });
  await waitUntil(() => relay.seen.length >= 2); // meta-stamp + title-set envelopes both reached the relay
  const seenBeforeForgery = relay.seen.length;

  // Mallory forges an envelope claiming to be a legitimate update, signed with HER OWN key (not on the ACL).
  const forged = await sealUpdate(new TextEncoder().encode('forged'), mallory, [alice.xPublicKey]);
  malloryTransport.send({ nodeId: 'note-1', envelope: forged });
  await new Promise((resolve) => setTimeout(resolve, 100)); // negative assertion: give it real time to (not) arrive

  assert.equal(relay.seen.length, seenBeforeForgery); // Mallory's forgery never got forwarded/stored - dropped at signature verification.
});
