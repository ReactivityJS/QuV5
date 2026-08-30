/**
 * RELAY FEDERATION — proves federateRelay()'s core promise (see that
 * file's own doc comment): RelayB federates with upstream RelayA by being
 * an ordinary subscribing peer to it; nothing crosses the link until a
 * REAL local peer on RelayB's side actually subscribes to something;
 * once it does, RelayB catches up from RelayA's mirror AND stays live in
 * BOTH directions - a client on RelayA's side and a client on RelayB's
 * side end up seeing each other's writes to the same Node, through two
 * separate relay processes that only ever talk to each other as peers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createMemoryStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport, createRelayForwarder, federateRelay } from '../src/index.js';
import { EventBus } from '@qu/events';

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

const noteKind = defineKind('note', { fields: { title: { shape: 'atomic' } } });

test('federateRelay() does nothing until a real local subscriber exists, then catches up and forwards writes in BOTH directions', async () => {
  const alice = await actor(); // a client of relay A
  const bob = await actor(); // a client of relay B (the federating/downstream relay)
  const relayIdentity = await actor(); // relay B's OWN identity, used only to authenticate to relay A as a peer

  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: relayIdentity.signingPub, xPub: relayIdentity.xPublicKey }, // relay B must be a recognized member of relay A's space to federate a 'members'-mode Kind.
  ];

  // --- Relay A (upstream) - alice writes here directly. ---
  const hubA = createInProcessHub();
  const storageA = createMemoryStore();
  const relayA = createRelayForwarder({ hub: hubA, members, resolveKindSchema: () => noteKind, storage: storageA });

  const aliceTransport = new InProcessTransport(hubA, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(noteKind, { title: 'written on relay A, before federation exists' });
  await waitUntil(async () => (await storageA.load(aliceNode.id)).length >= 2);

  // --- Relay B (downstream) - bob connects here, never directly to relay A. ---
  const hubB = createInProcessHub();
  const storageB = createMemoryStore();
  const busB = new EventBus();
  const relayB = createRelayForwarder({ hub: hubB, members, resolveKindSchema: () => noteKind, storage: storageB, bus: busB });

  // The federation link: relay B is a subscribing PEER of relay A, same InProcessTransport shape
  // any client uses, connected to relay A's hub. federateRelay({relay, bus, transport, identity})
  // means "THIS relay (the relay/bus pair, relay B here) federates OUTBOUND to the upstream
  // relay reachable over `transport`".
  const relayBToATransport = new InProcessTransport(hubA, 'relay-b-federation-link');
  await relayBToATransport.connect();
  const linkBtoA = federateRelay({ relay: relayB, bus: busB, transport: relayBToATransport, identity: relayIdentity });
  assert.equal(linkBtoA.isFederated(aliceNode.id), false); // nothing federated yet - no local subscriber on B has asked for anything.

  // bob subscribes on relay B for a Node that only exists on relay A - relay B has NOTHING locally yet.
  const bobTransport = new InProcessTransport(hubB, 'bob');
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  const bobNode = bobSpace.subscribeNode(aliceNode.id, noteKind);

  // Demand-driven: relay B's local subscribe event triggers an upstream subscribe to relay A automatically.
  await waitUntil(() => linkBtoA.isFederated(aliceNode.id));
  await waitUntil(async () => (await bobNode.field('title').get()) === 'written on relay A, before federation exists');
  await waitUntil(async () => (await storageB.load(aliceNode.id)).length >= 2); // relay B's own mirror caught up too, not just bob's live doc.

  // Forward direction: alice (on relay A) writes again - bob (on relay B) sees it live, through the federation link.
  await aliceNode.field('title').set('alice writes again, after federation');
  await waitUntil(async () => (await bobNode.field('title').get()) === 'alice writes again, after federation');

  // Reverse direction: bob (on relay B) writes - it reaches relay A, and from there alice sees it too.
  await bobNode.field('title').set('bob writes back, through the federation link');
  await waitUntil(async () => (await aliceNode.field('title').get()) === 'bob writes back, through the federation link');
});

test('federateRelay() never crosses the link for a Node no local peer on the downstream relay has subscribed to', async () => {
  const alice = await actor();
  const relayIdentity = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: relayIdentity.signingPub, xPub: relayIdentity.xPublicKey }];

  const hubA = createInProcessHub();
  const relayA = createRelayForwarder({ hub: hubA, members, resolveKindSchema: () => noteKind });
  const aliceTransport = new InProcessTransport(hubA, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(noteKind, { title: 'nobody on B ever asks for this' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const hubB = createInProcessHub();
  const busB = new EventBus();
  const relayB = createRelayForwarder({ hub: hubB, members, resolveKindSchema: () => noteKind, bus: busB });
  const linkTransport = new InProcessTransport(hubA, 'relay-b-link');
  await linkTransport.connect();
  const link = federateRelay({ relay: relayB, bus: busB, transport: linkTransport, identity: relayIdentity });

  await new Promise((resolve) => setTimeout(resolve, 30)); // give a wrongly-eager federation a chance to fetch something
  assert.equal(link.isFederated(aliceNode.id), false);
  assert.equal(relayB.seen.filter((e) => e.nodeId === aliceNode.id).length, 0);
});
