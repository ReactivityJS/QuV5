/**
 * USER-NODE (Peer-User-Verwaltung, Arbeitspaket 5) — see user.js's own doc
 * comment for the full design. Proves:
 *   1. userNodeId() is deterministic/self-certifying, same as any owner-ACL Kind.
 *   2. resolveAlias() falls back to the pubkey (base64url) when no alias was chosen.
 *   3. ensureUserProfile() creates sensible defaults (epub set, listed: false) on first call.
 *   4. ensureUserProfile() is idempotent ACROSS a simulated restart (shared storage, a
 *      fresh Space instance) - a later call with no options never resets a previously
 *      chosen listed/alias back to their defaults; an EXPLICIT value always wins.
 *   5. filterListedUsers() surfaces only opted-in identities, via a real relay (subscribe
 *      can happen in any order - the relay replays history on subscribe).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '../src/space.js';
import { userKind, userNodeId, resolveAlias, ensureUserProfile, filterListedUsers } from '../src/user.js';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';

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

test('userNodeId() is deterministic and self-certifying, same derivation as any owner-ACL Kind', async () => {
  const alice = await actor();
  const id1 = await userNodeId(alice.signingPub);
  const id2 = await userNodeId(alice.signingPub);
  assert.equal(id1, id2);
  assert.ok(id1.startsWith('~'));
});

test('resolveAlias(): falls back to the pubkey, base64url-encoded, when no alias was chosen', async () => {
  const alice = await actor();
  assert.equal(resolveAlias(null, alice.signingPub), QuCrypto.toBase64Url(alice.signingPub));
  assert.equal(resolveAlias(undefined, alice.signingPub), QuCrypto.toBase64Url(alice.signingPub));
  assert.equal(resolveAlias('', alice.signingPub), QuCrypto.toBase64Url(alice.signingPub));
  assert.equal(resolveAlias('alice', alice.signingPub), 'alice');
  // accepts an already-encoded string pubkey too, not just raw bytes.
  assert.equal(resolveAlias(null, QuCrypto.toBase64(alice.signingPub)), QuCrypto.toBase64Url(alice.signingPub));
});

test('ensureUserProfile(): first call creates sensible defaults - epub set, listed: false, alias unset', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport });

  const node = await ensureUserProfile(space, { timeout: 200 }); // no relay in this harness - genuinely new, so this always burns the full timeout; keep it short.
  assert.equal(await node.field('epub').get(), QuCrypto.toBase64(alice.xPublicKey));
  assert.equal(await node.field('listed').get(), false);
  assert.equal(await node.field('alias').get(), null);
  assert.equal(resolveAlias(await node.field('alias').get(), alice.signingPub), QuCrypto.toBase64Url(alice.signingPub));
});

test('ensureUserProfile(): an explicit alias/listed on first creation is honored, not overwritten by the default', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport });

  const node = await ensureUserProfile(space, { alias: 'alice', listed: true, timeout: 200 }); // no relay in this harness - see the test above.
  assert.equal(await node.field('alias').get(), 'alice');
  assert.equal(await node.field('listed').get(), true);
});

test('ensureUserProfile(): idempotent ACROSS a simulated restart - a later call with no options never resets a previously-chosen value', async () => {
  const alice = await actor();
  const sharedStore = createMemoryStore();

  const bootSpace = new Space({ identity: alice, members: [], transport: pairTransports()[0], storage: sharedStore });
  await ensureUserProfile(bootSpace, { alias: 'alice', listed: true, timeout: 200 }); // no relay in this harness - genuinely new, see the tests above.

  // A FRESH Space for the SAME identity, sharing only the storage adapter - simulates a later
  // process/page-load (useNode() hydrates from storage BEFORE ever touching the network, see
  // space.js's own doc comment - no relay/transport involved in this test at all).
  const reloadedSpace = new Space({ identity: alice, members: [], transport: pairTransports()[0], storage: sharedStore });
  const node = await ensureUserProfile(reloadedSpace); // no options - must NOT reset anything.
  assert.equal(await node.field('alias').get(), 'alice');
  assert.equal(await node.field('listed').get(), true);

  // An EXPLICIT value on a later call always wins, existing profile or not.
  const updated = await ensureUserProfile(reloadedSpace, { listed: false });
  assert.equal(await updated.field('listed').get(), false);
  assert.equal(await updated.field('alias').get(), 'alice'); // untouched - alias wasn't passed this time.
});

test('ensureUserProfile(): a second call on the SAME (already-attached) Space is a fast no-network-wait no-op for omitted fields', async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport });

  await ensureUserProfile(space, { alias: 'alice', listed: true, timeout: 200 }); // no relay in this harness - genuinely new, see the tests above.
  const start = Date.now();
  const node = await ensureUserProfile(space, { timeout: 5000 }); // must resolve near-instantly, not burn the 5s timeout.
  assert.ok(Date.now() - start < 500, 'second call should detect the already-attached profile immediately');
  assert.equal(await node.field('alias').get(), 'alice');
  assert.equal(await node.field('listed').get(), true);
});

test('filterListedUsers(): surfaces only opted-in identities, with alias resolved, via a real relay', async () => {
  const alice = await actor();
  const bob = await actor();
  const carol = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];

  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => userKind, storage: createMemoryStore() });

  async function spaceFor(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const aliceSpace = await spaceFor(alice, 'alice');
  const bobSpace = await spaceFor(bob, 'bob');
  const carolSpace = await spaceFor(carol, 'carol');

  await ensureUserProfile(bobSpace, { alias: 'bobby', listed: true });
  await ensureUserProfile(carolSpace); // stays unlisted (the default).

  const listed = await filterListedUsers(aliceSpace, [bob.signingPub, carol.signingPub], { timeout: 2000 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].alias, 'bobby');
  assert.equal(listed[0].epub, QuCrypto.toBase64(bob.xPublicKey));
  assert.deepEqual(listed[0].pub, bob.signingPub);
});

test('userKind: owner-ACL, all-public fields (discoverable with zero shared Space membership)', () => {
  assert.equal(userKind.acl.write, 'owner');
  for (const field of Object.values(userKind.fields)) assert.equal(field.visibility, 'public');
  assert.equal(userKind.metaVisibility, 'public');
});
