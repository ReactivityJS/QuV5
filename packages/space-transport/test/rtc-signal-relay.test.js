/**
 * RTC-SIGNAL RELAY FORWARDING — proves `relay.js`'s own "A SIXTH shape,
 * SIGNALING (WebRTC)" doc comment end to end, at the RAW transport level
 * (no `Space` involved - `Space` itself never learns this message type
 * exists, see `webrtc-signaling.js`'s own doc comment on why that's
 * deliberate): a peer that has said `hello` can reach another `hello`'d
 * peer by pubkey, the relay never trusts a claimed `from`, and nothing
 * about a signal is ever mirrored/replayed to a later subscriber.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '../src/index.js';

const HELLO_DOMAIN = 'qu-space-hello-v1';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connectedTransport(hub, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return transport;
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

/**
 * Sends `hello` AND waits for the relay's own `presence` to actually reflect it before returning -
 * `hello` verification is async (`handleHello()`'s own `QuCrypto.verify()` await), and each peer's
 * messages are only serialized against ITS OWN earlier messages (relay.js's own `peerQueues` doc
 * comment) - a DIFFERENT peer's hello has no ordering relationship to this one's later rtc-signal
 * at all, so a caller that needs "the OTHER peer is already online" must wait for that explicitly,
 * never just assume `await sayHello()` returning means the relay is done processing it.
 */
async function helloAndWaitOnline(transport, identity, presence) {
  const sig = await QuCrypto.sign(new TextEncoder().encode(HELLO_DOMAIN), identity.signingKey);
  transport.send({ type: 'hello', pub: identity.signingPub, sig });
  await waitUntil(() => presence.isOnline(QuCrypto.toBase64(identity.signingPub)));
}

test('rtc-signal: reaches the target by pubkey, with "from" set by the relay (never the claimed sender)', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = await connectedTransport(hub, 'alice');
  const bobTransport = await connectedTransport(hub, 'bob');
  await helloAndWaitOnline(aliceTransport, alice, presence);
  await helloAndWaitOnline(bobTransport, bob, presence);

  const received = [];
  bobTransport.onMessage(({ data }) => received.push(data));

  aliceTransport.send({ type: 'rtc-signal', to: QuCrypto.toBase64(bob.signingPub), signal: { sdp: 'offer-blob' } });

  await waitUntil(() => received.length > 0);
  assert.deepEqual(received[0], { type: 'rtc-signal', from: QuCrypto.toBase64(alice.signingPub), signal: { sdp: 'offer-blob' } });
});

test('rtc-signal: a claimed "from" in the payload is ignored - the relay always substitutes the authenticated sender', async () => {
  const alice = await actor();
  const bob = await actor();
  const eve = await actor(); // never a member, never says hello - alice tries to impersonate her.
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = await connectedTransport(hub, 'alice');
  const bobTransport = await connectedTransport(hub, 'bob');
  await helloAndWaitOnline(aliceTransport, alice, presence);
  await helloAndWaitOnline(bobTransport, bob, presence);

  const received = [];
  bobTransport.onMessage(({ data }) => received.push(data));

  // alice's own message body CLAIMS to be from eve - the relay must not believe it.
  aliceTransport.send({ type: 'rtc-signal', to: QuCrypto.toBase64(bob.signingPub), from: QuCrypto.toBase64(eve.signingPub), signal: {} });

  await waitUntil(() => received.length > 0);
  assert.equal(received[0].from, QuCrypto.toBase64(alice.signingPub), 'the relay overwrites "from" with the authenticated sender, ignoring any client-supplied claim');
});

test('rtc-signal: a target that never said hello (offline) silently drops the signal - no error, no delivery', async () => {
  const alice = await actor();
  const bob = await actor(); // a member, but never connects/hellos in this test.
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = await connectedTransport(hub, 'alice');
  await helloAndWaitOnline(aliceTransport, alice, presence);

  // No exception, nothing to assert on delivery (bob was never even connected) - this just proves
  // the call doesn't throw/hang for an unreachable target.
  aliceTransport.send({ type: 'rtc-signal', to: QuCrypto.toBase64(bob.signingPub), signal: {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('rtc-signal: a sender who never said hello cannot signal at all, even with a well-formed message', async () => {
  const alice = await actor(); // never hellos.
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = await connectedTransport(hub, 'alice');
  const bobTransport = await connectedTransport(hub, 'bob');
  await helloAndWaitOnline(bobTransport, bob, presence); // only bob hellos.

  const received = [];
  bobTransport.onMessage(({ data }) => received.push(data));

  aliceTransport.send({ type: 'rtc-signal', to: QuCrypto.toBase64(bob.signingPub), signal: {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 0, 'no hello from alice means presence has no pubkey for her connection - nothing to authenticate the signal with');
});

test('rtc-signal: never mirrored/stored - a late subscriber replays nothing for it (not even a real Node/storage involved)', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { seen, presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = await connectedTransport(hub, 'alice');
  const bobTransport = await connectedTransport(hub, 'bob');
  await helloAndWaitOnline(aliceTransport, alice, presence);
  await helloAndWaitOnline(bobTransport, bob, presence);

  const received = [];
  bobTransport.onMessage(({ data }) => received.push(data));
  aliceTransport.send({ type: 'rtc-signal', to: QuCrypto.toBase64(bob.signingPub), signal: { sdp: 'x' } });
  await waitUntil(() => received.length > 0);

  assert.equal(seen.length, 0, 'rtc-signal never enters the relay\'s own write-history/seen log - it is not a Node write of any kind');
});
