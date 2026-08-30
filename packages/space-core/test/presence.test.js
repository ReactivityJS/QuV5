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
import { presenceKind, presenceNodeId, publishPresence, setStatus, setTyping, watchPresence, PresenceWatcher } from '../src/presence.js';

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
