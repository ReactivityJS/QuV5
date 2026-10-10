/**
 * LIVE PRESENCE, RELAY-SIDE — the relay's own `PresenceTracker` (real
 * connection state) made client-subscribable, gated by a signed
 * `onlineVisibility` declaration (`@qu/space-core`'s `presence-visibility.js`)
 * the relay enforces without ever decoding any Node's Yjs content - see
 * relay.js's own `presenceVisibility`/`presenceWatchers` doc comments and
 * `Space.declareOnlineVisibility()`/`watchLivePresence()`'s own doc
 * comments. Deliberately proves a WATCHER never needs to be a member of
 * the target's own Space at all - "whoever knows the pubkey can ask,
 * subject to the declared visibility" is the whole point of this being a
 * profile-wide setting, not a Space-membership-scoped one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, declareOnlineVisibility, signPresenceVisibility } from '@qu/space-core';
import { EventBus } from '@qu/events';
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

/**
 * `declareOnlineVisibility()` (like `declareGroupMembership()`) is fire-and-forget - it resolves
 * once the signed message was handed to the transport, NOT once the relay has actually finished
 * verifying+applying it (an async `QuCrypto.verify()` call). A `watch-presence` sent right after,
 * on a DIFFERENT peer's own independently-queued connection, has no guaranteed ordering against
 * that still-in-flight verification - the exact same class of race `group-acl.test.js`'s own
 * `subscribeGroupAndWaitSynced()` helper exists to close. Waiting for the relay's own
 * `debug.relay.presence-visibility.received` event removes it the same way.
 */
async function declareAndWaitApplied(space, bus, onlineVisibility) {
  const applied = new Promise((resolve) => bus.once('debug.relay.presence-visibility.received', resolve));
  await declareOnlineVisibility(space, onlineVisibility);
  await applied;
}

test('watch-presence: a stranger (not a Space member at all) sees current + future online/offline for a public identity', async () => {
  const alice = await actor();
  const stranger = await actor();
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => null, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  await declareAndWaitApplied(aliceSpace, bus, 'public');

  const strangerTransport = new InProcessTransport(hub, 'stranger');
  await strangerTransport.connect();
  const strangerSpace = new Space({ identity: stranger, members: [], transport: strangerTransport });

  const aliceB64 = QuCrypto.toBase64(alice.signingPub);
  await strangerSpace.watchLivePresence(alice.signingPub);
  await waitUntil(() => strangerSpace.isLiveOnline(aliceB64) === true); // alice's own hello already landed before the watch - relay replies with CURRENT state immediately, even though `stranger` shares no Space membership with her at all.

  hub.disconnect('alice'); // simulate alice going offline - see the next test for the dedicated, guaranteed disconnect-broadcast proof.
  await waitUntil(() => strangerSpace.isLiveOnline(aliceB64) === false);
});

test('watch-presence: an UNDECLARED identity is fail-closed - no reply at all, even though it IS actually online', async () => {
  const alice = await actor();
  const watcher = await actor();
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => null });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  new Space({ identity: alice, members: [], transport: aliceTransport }); // never declares onlineVisibility at all.
  await new Promise((resolve) => setTimeout(resolve, 30)); // let alice's own hello actually land at the relay first - the point of this test is "online but undeclared", not "not even connected yet".

  const watcherTransport = new InProcessTransport(hub, 'watcher');
  await watcherTransport.connect();
  const watcherSpace = new Space({ identity: watcher, members: [], transport: watcherTransport });

  const aliceB64 = QuCrypto.toBase64(alice.signingPub);
  await watcherSpace.watchLivePresence(alice.signingPub);
  await new Promise((resolve) => setTimeout(resolve, 60)); // give a hypothetical (wrong) reply a chance to arrive.
  assert.equal(watcherSpace.isLiveOnline(aliceB64), undefined);
});

test("watch-presence: onlineVisibility: 'private' is fail-closed the same way - no reply, no leak that it's specifically private", async () => {
  const alice = await actor();
  const watcher = await actor();
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => null, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  await declareAndWaitApplied(aliceSpace, bus, 'private');

  const watcherTransport = new InProcessTransport(hub, 'watcher');
  await watcherTransport.connect();
  const watcherSpace = new Space({ identity: watcher, members: [], transport: watcherTransport });

  const aliceB64 = QuCrypto.toBase64(alice.signingPub);
  await watcherSpace.watchLivePresence(alice.signingPub);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(watcherSpace.isLiveOnline(aliceB64), undefined);
});

test('a disconnect broadcasts presence-offline to every registered watcher of a PUBLIC identity', async () => {
  const alice = await actor();
  const watcher = await actor();
  const hub = createInProcessHub();
  const bus = new EventBus();
  const relay = createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => null, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  await declareAndWaitApplied(aliceSpace, bus, 'public');

  const watcherTransport = new InProcessTransport(hub, 'watcher');
  await watcherTransport.connect();
  const watcherSpace = new Space({ identity: watcher, members: [], transport: watcherTransport });

  const aliceB64 = QuCrypto.toBase64(alice.signingPub);
  await watcherSpace.watchLivePresence(alice.signingPub);
  await waitUntil(() => watcherSpace.isLiveOnline(aliceB64) === true);

  assert.equal(relay.presence.isOnline(aliceB64), true);
  hub.disconnect('alice'); // drives the same disconnect path relay.js's own hub.registerDisconnect() callback listens on.
  await waitUntil(() => watcherSpace.isLiveOnline(aliceB64) === false);
});

test('unwatchLivePresence() stops further pushes without clearing the last-known cached value', async () => {
  const alice = await actor();
  const watcher = await actor();
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => null, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  await declareAndWaitApplied(aliceSpace, bus, 'public');

  const watcherTransport = new InProcessTransport(hub, 'watcher');
  await watcherTransport.connect();
  const watcherSpace = new Space({ identity: watcher, members: [], transport: watcherTransport });

  const aliceB64 = QuCrypto.toBase64(alice.signingPub);
  await watcherSpace.watchLivePresence(alice.signingPub);
  await waitUntil(() => watcherSpace.isLiveOnline(aliceB64) === true);

  await watcherSpace.unwatchLivePresence(alice.signingPub);
  hub.disconnect('alice');
  await new Promise((resolve) => setTimeout(resolve, 60)); // give a (wrongly) still-arriving push a chance.
  assert.equal(watcherSpace.isLiveOnline(aliceB64), true); // last-known value untouched - unwatch() never clears the cache, only future pushes.
});

test('a REORDERED (older ts) presence-visibility declaration is ignored - a stale "private" can never regress a later "public"', async () => {
  const alice = await actor();
  const watcher = await actor();
  const hub = createInProcessHub();
  const bus = new EventBus();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => null, bus });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  new Space({ identity: alice, members: [], transport: aliceTransport });

  // Sign the OLDER "private" declaration FIRST (an earlier real ts) and the newer "public" one
  // SECOND (`signPresenceVisibility()`'s own `ts: Date.now()` - each call's ts is genuinely later
  // than the previous), then send them out of that chronological order - simulating a reordered
  // delivery without ever tampering with a signed field (mutating `ts` after signing would just
  // invalidate the signature, since it's part of the signed payload - see this file's own
  // `signPresenceVisibility()` import).
  const older = await signPresenceVisibility('private', alice);
  await new Promise((resolve) => setTimeout(resolve, 5)); // signPresenceVisibility()'s own ts is Date.now() - force it onto a later millisecond than `older`'s, since two back-to-back calls can otherwise land in the same one.
  const newer = await signPresenceVisibility('public', alice);
  assert.ok(newer.ts > older.ts);

  const applied = new Promise((resolve) => bus.once('debug.relay.presence-visibility.received', resolve));
  aliceTransport.send(newer);
  await applied; // waits for the newer('public') one to be APPLIED before sending the stale one.
  const staleIgnored = new Promise((resolve) => bus.once('debug.relay.presence-visibility.stale', resolve));
  aliceTransport.send(older); // arrives SECOND but is genuinely OLDER - must be ignored, not applied.
  await staleIgnored;

  const watcherTransport = new InProcessTransport(hub, 'watcher');
  await watcherTransport.connect();
  const watcherSpace = new Space({ identity: watcher, members: [], transport: watcherTransport });

  const aliceB64 = QuCrypto.toBase64(alice.signingPub);
  await watcherSpace.watchLivePresence(alice.signingPub);
  await waitUntil(() => watcherSpace.isLiveOnline(aliceB64) === true); // still 'public' - the stale 'private' never applied.
});
