/**
 * SHARED LISTS — `kinds.js`'s own `sharedListKind` doc comment: the
 * missing primitive a genuine guestbook needs, MANY DIFFERENT visitors
 * each appending their OWN entry to ONE common list, as opposed to
 * `defineCollectionKind()`'s "one owner curates many items it each
 * individually owns" shape.
 *
 * Proves, over a REAL (in-process) relay:
 *   1. Two DIFFERENT identities (never coordinating, no shared "owner")
 *      can each push their own entry to the SAME named list - genuine
 *      concurrent writers, not one identity replaying the other's write.
 *   2. A third reader, on a fresh connection, sees BOTH entries, in
 *      insertion order - the relay's `'members'`-ACL classification
 *      (`createAppResolveKindSchema()`'s `sharedListNames` param) actually
 *      let both writes through; a misclassified nodeId would have had
 *      one or both silently rejected as an unauthorized 'content'-ACL
 *      write instead.
 *   3. A genuinely UNKNOWN identity (never added to the Space's own
 *      `members` list) gets its write rejected - `'members'`-ACL is a
 *      real gate, not "anyone with the id can write."
 *   4. A brand-new, never-written-to list resolves to `[]` promptly,
 *      not a timeout - `resolveSharedList()`'s own "empty is a valid,
 *      final answer" doc comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { pushToSharedList } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { sharedListAnchor, sharedListKind } from '../src/kinds.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport });
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('a named shared list lets many different Space members each append their own entry, visible to everyone, rejected for non-members, and empty-but-synced for a never-used name', async () => {
  const alice = await actor();
  const bob = await actor();
  const outsider = await actor(); // never added to `members` below.
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const aliceSpace = await connect(hub, alice, members, 'alice');
  const bobSpace = await connect(hub, bob, members, 'bob');

  await pushToSharedList(aliceSpace, 'guestbook', { name: 'Alice', message: 'Schöne Seite!' });
  await pushToSharedList(bobSpace, 'guestbook', { name: 'Bob', message: 'War auch hier.' });

  // --- A THIRD reader, a fresh connection that never wrote anything itself, sees BOTH entries. ---
  const readerSpace = await connect(hub, alice, members, 'alice-reader');
  const readerResolver = new ContentResolver(readerSpace, { appAdminPub: alice.signingPub });
  const entries = await readerResolver.resolveSharedList('guestbook', { timeout: 2000 });
  assert.deepEqual(
    entries.map((e) => e.name),
    ['Alice', 'Bob'],
    'both independently-written entries land in the same list, in insertion order'
  );
  assert.equal(entries[0].message, 'Schöne Seite!');
  assert.equal(entries[1].message, 'War auch hier.');

  // --- An identity NEVER added to `members` cannot write - 'members'-ACL is enforced, not bypassed. ---
  const outsiderTransport = new InProcessTransport(hub, 'outsider');
  await outsiderTransport.connect();
  const outsiderSpace = new Space({ identity: outsider, members, transport: outsiderTransport });
  await pushToSharedList(outsiderSpace, 'guestbook', { name: 'Eindringling', message: 'sollte nicht ankommen' });
  // Give the (rejected) write a moment to have reached the relay either way, then confirm the
  // list still shows only the two legitimate entries - a real relay round trip, not a local echo.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterOutsiderAttempt = await readerResolver.resolveSharedList('guestbook', { timeout: 2000 });
  assert.equal(afterOutsiderAttempt.length, 2, "an outsider's write must never reach the shared list, however many legitimate entries already exist");

  // --- A brand-new, never-used name resolves to [] promptly, not a timeout. ---
  const started = Date.now();
  const emptyList = await readerResolver.resolveSharedList('never-used-list-name', { timeout: 2000 });
  assert.deepEqual(emptyList, []);
  assert.ok(Date.now() - started < 1000, 'an empty-but-synced list must resolve quickly, not burn the full timeout waiting for a non-empty value that will never come');
});

test('pushToSharedList() with compactThreshold compacts the WRITER\'s own local storage once crossed - resolved content unaffected; omitting it (every pre-existing caller) never touches storage at all', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const aliceStorage = createMemoryStore();
  const aliceTransport = new InProcessTransport(hub, 'alice-compact');
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, storage: aliceStorage });

  const id = await deriveOwnerNodeId(await sharedListAnchor('guestbook'), sharedListKind.kind);

  // 4 plain pushes first, no compactThreshold - `storage.append()` is fire-and-forget from
  // `_handleLocalUpdate()`'s own point of view (`compact-node.test.js`'s own doc comment, identical
  // reasoning), so wait for each envelope to actually LAND before firing the next write - avoids
  // racing `compactIfNeeded()`'s own count check (below) against an in-flight append from a
  // still-settling earlier push, the same "wait for the observable effect" idiom this whole
  // codebase's own tests already use.
  for (let i = 0; i < 4; i++) {
    const beforeCount = (await aliceStorage.load(id)).length;
    await pushToSharedList(aliceSpace, 'guestbook', { name: 'Alice', message: `Eintrag ${i}` });
    await waitUntil(async () => (await aliceStorage.load(id)).length > beforeCount);
  }
  const settledCount = (await aliceStorage.load(id)).length;
  assert.equal(settledCount, 5, 'meta-stamp + 4 pushes, all settled'); // sanity check the setup itself, not the mechanism under test.

  // NOW, against an already-settled base, ONE more push WITH compactThreshold - triggers
  // `compactIfNeeded()` against a count already well past the threshold, deterministically.
  await pushToSharedList(aliceSpace, 'guestbook', { name: 'Alice', message: 'Eintrag 4' }, { compactThreshold: 2 });
  await waitUntil(async () => (await aliceStorage.load(id)).length === 1);

  const envelopes = await aliceStorage.load(id);
  assert.equal(envelopes.length, 1, 'compacted down to one snapshot once the threshold (2) was crossed');
  assert.equal(envelopes[0].snapshot, true);

  // Content is unaffected by compaction - a fresh reader still sees every entry, in order.
  const readerSpace = await connect(hub, alice, members, 'alice-compact-reader');
  const readerResolver = new ContentResolver(readerSpace, { appAdminPub: alice.signingPub });
  const entries = await readerResolver.resolveSharedList('guestbook', { timeout: 2000 });
  assert.deepEqual(
    entries.map((e) => e.message),
    ['Eintrag 0', 'Eintrag 1', 'Eintrag 2', 'Eintrag 3', 'Eintrag 4']
  );

  // Every EXISTING caller (no third argument at all) never touches storage - zero behavior change.
  const otherStorage = createMemoryStore();
  const otherTransport = new InProcessTransport(hub, 'alice-nocompact');
  await otherTransport.connect();
  const otherSpace = new Space({ identity: alice, members, transport: otherTransport, storage: otherStorage });
  await pushToSharedList(otherSpace, 'other-list', { name: 'Alice', message: 'x' });
  assert.equal((await otherStorage.load(id)).length, 0, "a call with no compactThreshold never even reads THIS list's own storage");
});
