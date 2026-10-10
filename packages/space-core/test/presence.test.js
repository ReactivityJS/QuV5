/**
 * PRESENCE/TYPING — see presence.js's own doc comment for the full design:
 * custom status and typing are ordinary `'owner'`-ACL, volatile-persistence
 * Node writes, not a transport-level concept. Proves, peer<->peer (no
 * relay needed, same harness as alias.test.js):
 *   1. publishPresence()/setStatus()/setTyping() write to a deterministic,
 *      self-certifying presence Node id.
 *   2. watchPresence() reads a one-shot snapshot of another identity's presence.
 *   3. PresenceWatcher reactively tracks changes off the bus, for multiple identities.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '../src/space.js';
import { EventBus } from '@qu/events';
import { presenceKind, presenceNodeId, publishPresence, setStatus, setTyping, watchPresence, PresenceWatcher, declareOnlineVisibility, LivePresenceWatcher } from '../src/presence.js';
import { verifyPresenceVisibility } from '../src/presence-visibility.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function pairTransports() {
  let aOnMessage = null;
  let bOnMessage = null;
  const a = { async connect() {}, send(data) { queueMicrotask(() => bOnMessage?.({ data })); }, onMessage(cb) { aOnMessage = cb; } };
  const b = { async connect() {}, send(data) { queueMicrotask(() => aOnMessage?.({ data })); }, onMessage(cb) { bOnMessage = cb; } };
  return [a, b];
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('presenceNodeId() is deterministic and self-certifying, same derivation as any owner-ACL Kind', async () => {
  const alice = await actor();
  const id1 = await presenceNodeId(alice.signingPub);
  const id2 = await presenceNodeId(alice.signingPub);
  assert.equal(id1, id2);
  assert.ok(id1.startsWith('~'));
});

test('publishPresence()/setStatus()/setTyping() write to the SAME presence Node, only touching the given fields', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport });

  await publishPresence(space, { online: true });
  const nodeId = await presenceNodeId(alice.signingPub);
  const node = space.getNode(nodeId);
  assert.equal(await node.field('online').get(), true);

  await setStatus(space, 'busy');
  assert.equal(await node.field('status').get(), 'busy');
  assert.equal(await node.field('online').get(), true); // untouched by setStatus().

  await setTyping(space, 'some-room', true);
  assert.equal(await node.field('typingIn').get(), 'some-room');
  await setTyping(space, 'some-room', false);
  assert.equal(await node.field('typingIn').get(), null);
});

test('watchPresence() returns a one-shot snapshot of another identity\'s presence, synced peer-to-peer', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });

  // Subscribe BEFORE alice publishes - this bare peer-to-peer harness has no relay/storage
  // catch-up (that's a relay-side feature, see relay.js), so a write sent before bob is attached
  // to the Node is simply never seen, same ordering requirement alias.test.js's own tests have.
  await watchPresence(bobSpace, alice.signingPub);
  await setStatus(aliceSpace, 'away');
  await waitUntil(async () => (await watchPresence(bobSpace, alice.signingPub)).status === 'away');
});

test('PresenceWatcher reactively tracks multiple identities\' presence off the bus, no polling', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const bobBus = new EventBus();
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport, bus: bobBus });

  const watcher = new PresenceWatcher(bobSpace, bobBus);
  await watcher.watch(alice.signingPub);
  assert.equal(watcher.of(QuCrypto.toBase64(alice.signingPub))?.status ?? null, null); // alice hasn't published anything yet - useNode() attaches an empty local Node immediately, so this reads "no status" rather than a hard undefined snapshot.

  await setStatus(aliceSpace, 'in a meeting');
  await waitUntil(() => watcher.of(QuCrypto.toBase64(alice.signingPub))?.status === 'in a meeting');

  await setTyping(aliceSpace, 'room-x', true);
  await waitUntil(() => watcher.of(QuCrypto.toBase64(alice.signingPub))?.typingIn === 'room-x');
  assert.equal(watcher.of(QuCrypto.toBase64(alice.signingPub)).status, 'in a meeting'); // earlier fields survive a later, narrower publish.
});

test('presenceKind is volatile-persistence by design - a relay mirroring it never durably stores presence/typing churn', () => {
  assert.equal(presenceKind.persistence, 'volatile');
  assert.equal(presenceKind.acl.write, 'owner');
});

test('declareOnlineVisibility() publishes presenceKind.onlineVisibility AND sends a validly-signed relay declaration', async () => {
  const alice = await actor();
  const sent = [];
  const transport = { async connect() {}, send(data) { sent.push(data); }, onMessage() {} };
  const space = new Space({ identity: alice, members: [], transport });

  await declareOnlineVisibility(space, 'public');

  const nodeId = await presenceNodeId(alice.signingPub);
  assert.equal(await space.getNode(nodeId).field('onlineVisibility').get(), 'public'); // the app-readable half.

  const declaration = sent.find((m) => m.type === 'presence-visibility');
  assert.ok(declaration); // the relay-enforced half - a SEPARATE signed message, see presence-visibility.js's own doc comment.
  assert.equal(declaration.onlineVisibility, 'public');
  assert.deepEqual(declaration.pub, alice.signingPub);
  assert.equal(await verifyPresenceVisibility(declaration), true);
});

test("Space.watchLivePresence()/isLiveOnline() record the relay's presence-online/presence-offline pushes, and expose them on the bus", async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport] = pairTransports();
  const bus = new EventBus();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport, bus });

  const bobB64 = QuCrypto.toBase64(bob.signingPub);
  assert.equal(space.isLiveOnline(bobB64), undefined); // never heard anything about bob yet.

  const changes = [];
  bus.on('space.presence.live.changed', (p) => changes.push(p));

  await space.watchLivePresence(bob.signingPub); // sends 'watch-presence' - this bare test never actually replies to it, the two pushes below are simulated directly.
  await space._handleIncoming({ type: 'presence-online', pub: bob.signingPub });
  assert.equal(space.isLiveOnline(bobB64), true);
  assert.deepEqual(changes.at(-1), { pub: bobB64, online: true });

  await space._handleIncoming({ type: 'presence-offline', pub: bob.signingPub });
  assert.equal(space.isLiveOnline(bobB64), false);
  assert.deepEqual(changes.at(-1), { pub: bobB64, online: false });
});

test('LivePresenceWatcher reactively tracks multiple identities\' live presence off the bus, no polling', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport] = pairTransports();
  const bus = new EventBus();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport, bus });

  const watcher = new LivePresenceWatcher(space, bus);
  const bobB64 = QuCrypto.toBase64(bob.signingPub);
  await watcher.watch(bob.signingPub);
  assert.equal(watcher.isOnline(bobB64), undefined); // no reply simulated yet.

  await space._handleIncoming({ type: 'presence-online', pub: bob.signingPub });
  assert.equal(watcher.isOnline(bobB64), true);

  await space._handleIncoming({ type: 'presence-offline', pub: bob.signingPub });
  assert.equal(watcher.isOnline(bobB64), false);

  await watcher.unwatch(bob.signingPub);
  await space._handleIncoming({ type: 'presence-online', pub: bob.signingPub }); // a stray push after unwatch() is still absorbed by Space itself (it never asked the relay to stop tracking via _livePresence)...
  assert.equal(space.isLiveOnline(bobB64), true);
  assert.equal(watcher.isOnline(bobB64), true); // ...and the watcher, listening on the SAME bus topic regardless of its own unwatch() bookkeeping, reflects it too - unwatch() only ever stops the RELAY from pushing further, never a local filter.
});
