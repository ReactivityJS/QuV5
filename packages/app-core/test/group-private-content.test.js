/**
 * GROUPS + PRIVATE/SHARED CONTENT — `kinds.js`'s own `groupKind`/
 * `privatePageKind` doc comments: a real, requested gap this closes -
 * "CMS heißt nicht automatisch, dass alle Seiten alle sehen können" - a
 * page can now be created for a NARROW audience (a named group, or nobody
 * but its own owner) instead of every Space member, through the exact same
 * `Space.createNode()`/field machinery every other Kind already uses -
 * `@qu/space-core`'s own multi-recipient envelope encryption
 * (`QuCrypto.encrypt()`) was ALREADY capable of this; what was missing was
 * a way to narrow the recipient list below "every Space member" at all
 * (`Space._effectiveRecipients()`) and a reusable "named set of members"
 * primitive to narrow it TO (`groupKind`).
 *
 * Proves, through a REAL (in-process) relay so ACL/encryption are both
 * genuinely enforced, not just locally simulated:
 *   1. A group owner creates a group and a page shared with it.
 *   2. A group MEMBER (a completely different identity/connection) can
 *      read the page - genuine end-to-end decryption, not the owner
 *      reading their own local state back.
 *   3. A DIFFERENT Space member who is NOT in the group gets exactly
 *      `null` back - indistinguishable from the page never existing at
 *      all, never an error, never partial/garbled content.
 *   4. A genuinely PRIVATE page (no `recipients` at all) is readable by
 *      its own owner and by nobody else, including an ordinary Space
 *      member.
 *   5. Editing a group's membership, then re-saving an EXISTING page's
 *      content, is visible in real time to a reader who could ALREADY
 *      decrypt that page (an original member) - `recipients` genuinely
 *      drives live re-encryption for them, not a one-time snapshot.
 *   6. Growing the group does NOT retroactively hand a brand-new member
 *      that same EXISTING page's history, even once their key is added to
 *      `recipients` on a later field write - this is a real, structural
 *      property of the underlying design (see `editPrivatePage()`'s own
 *      doc comment: `stampMeta()`'s ONE-TIME meta envelope, sealed only
 *      for whoever was a recipient at CREATION time, is never re-sealed by
 *      a later edit, and Yjs itself refuses to integrate ANY later update
 *      from the same author while an earlier one in that author's
 *      sequence stays undecryptable - see grant.js's own "WRITE-BEFORE-
 *      GRANT" doc comment for the identical mechanism) - not a bug, the
 *      same "no retroactive decryption of history from before you had a
 *      key" property genuine E2E-encrypted group messaging relies on.
 *      What DOES work, and is what this proves instead: a page CREATED
 *      after the group grows is fully readable by the new member from the
 *      start, since every one of ITS envelopes (meta included) is sealed
 *      for the group's CURRENT membership.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { EventBus } from '@qu/events';
import { ContentResolver } from '../src/resolver.js';
import { createGroup, editGroup, createPrivatePage, editPrivatePage } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport, bus: new EventBus() });
}

/**
 * `fn()`'s own local `field.set()`/`replaceText()` calls only prove the LOCAL Yjs mutation
 * happened - `space.js`'s `_handleLocalUpdate()` seals/sends each one to the relay separately,
 * fire-and-forget (see that file's own doc comment), so `fn()` resolving is no guarantee the
 * relay's mirror has caught up yet. That matters here specifically because every write from the
 * SAME `space` (identically, the SAME peer id on the in-process hub) is processed through ONE
 * SERIAL per-peer queue on the relay (`relay.js`'s own "`peerQueues`" - never overlapping, so a
 * `'content'`-ACL grant-then-write sequence stays race-free) - a call site that fires off several
 * writes in a row (creating a group, then a whole private page's worth of encrypted fields) can
 * leave a real BACKLOG on that queue, not just a fixed round-trip latency. A caller's own NEXT
 * write/read (e.g. `editGroup()` re-subscribing to re-read the just-created group) is enqueued
 * behind that backlog too - a flat `setTimeout` guess sized for "one write's latency" can
 * therefore stay too short no matter how large a constant it uses, since the backlog itself grows
 * with how much this same identity already queued up. Waiting for the relay's own `write-ack`
 * (`relay.js`'s "WRITE-ACK" doc comment - emitted only once a write is durably mirrored) for every
 * write `fn()` made is the deterministic fix - see `@qu/app-shell`'s `cms-actions.js`'s own
 * `verifyWritesAcked()` for the identically-motivated, single-nodeId version of this same idea;
 * this one is nodeId-agnostic (`space.node.*.write-ack`'s single-segment wildcard) since a single
 * `fn()` call here may write to a brand-new nodeId this test never named up front (e.g.
 * `createGroup()`/`createPrivatePage()` derive their own id internally).
 */
async function waitForWritesAcked(space, fn, { timeout = 3000 } = {}) {
  const bus = space.bus;
  const expected = new Map(); // nodeId -> count of `debug.space.write.local` seen for it.
  const acked = new Map(); // nodeId -> count of `write-ack` seen for it.
  const offLocal = bus.on('debug.space.write.local', (payload) => {
    expected.set(payload.nodeId, (expected.get(payload.nodeId) ?? 0) + 1);
  });
  const offAck = bus.on('space.node.*.write-ack', (payload) => {
    acked.set(payload.nodeId, (acked.get(payload.nodeId) ?? 0) + 1);
  });
  try {
    const result = await fn();
    // `debug.space.write.local` for a write `fn()` just made can still be a microtask/async hop
    // away from having fired at all (sealing an envelope is real crypto work) - give it a moment
    // to catch up before the "is everything acked" check below means anything.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const allAcked = () => {
      for (const [nodeId, count] of expected) {
        if ((acked.get(nodeId) ?? 0) < count) return false;
      }
      return true;
    };
    const deadline = Date.now() + timeout;
    while (!allAcked() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!allAcked()) throw new Error('waitForWritesAcked: not every write fn() made was acked by the relay within the timeout');
    return result;
  } finally {
    offLocal();
    offAck();
  }
}

test('a page shared with a named group is readable by group members, invisible (not erroring) to everyone else, and a genuinely private page is readable by nobody but its own owner', async () => {
  const owner = await actor();
  const memberA = await actor(); // in the group.
  const outsider = await actor(); // an ordinary Space member, but NOT in the group.
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: memberA.signingPub, xPub: memberA.xPublicKey },
    { pub: outsider.signingPub, xPub: outsider.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');

  await waitForWritesAcked(ownerSpace, () =>
    createGroup(ownerSpace, {
      name: 'familie',
      members: [
        { pub: owner.signingPub, xPub: owner.xPublicKey },
        { pub: memberA.signingPub, xPub: memberA.xPublicKey },
      ],
    })
  );

  const ownerResolver = new ContentResolver(ownerSpace, { appAdminPub: owner.signingPub });
  const group = await ownerResolver.resolveGroup('familie', { timeout: 2000 });
  assert.equal(group?.name, 'familie');
  assert.equal(group?.members.length, 2);

  await waitForWritesAcked(ownerSpace, () =>
    createPrivatePage(ownerSpace, {
      route: '/familientreffen',
      title: 'Nur für die Familie',
      content: '<p>Geheimer Treffpunkt</p>',
      recipients: group.members.map((m) => m.xPub),
    })
  );

  // --- A GROUP MEMBER, a completely different connection, can actually decrypt it. ---
  const memberSpace = await connect(hub, memberA, members, 'member-a');
  const memberResolver = new ContentResolver(memberSpace, { appAdminPub: owner.signingPub });
  const pageForMember = await memberResolver.resolvePrivatePage('/familientreffen', { timeout: 2000 });
  assert.equal(pageForMember?.title, 'Nur für die Familie');
  assert.equal(pageForMember?.content, '<p>Geheimer Treffpunkt</p>');

  // --- An ORDINARY Space member who is NOT in the group gets null - not an error, not garbled
  // ciphertext, indistinguishable from the route never having been published at all. ---
  const outsiderSpace = await connect(hub, outsider, members, 'outsider');
  const outsiderResolver = new ContentResolver(outsiderSpace, { appAdminPub: owner.signingPub });
  const pageForOutsider = await outsiderResolver.resolvePrivatePage('/familientreffen', { timeout: 1500 });
  assert.equal(pageForOutsider, null, 'a Space member outside the group must see exactly nothing - the same null a genuinely unpublished route returns');

  // --- A genuinely PRIVATE page (no recipients at all) is readable by its own owner... ---
  await waitForWritesAcked(ownerSpace, () => createPrivatePage(ownerSpace, { route: '/tagebuch', title: 'Mein Tagebuch', content: '<p>Nur ich</p>' }));
  const ownPrivatePage = await ownerResolver.resolvePrivatePage('/tagebuch', { timeout: 2000 });
  assert.equal(ownPrivatePage?.title, 'Mein Tagebuch');

  // ...and by NOBODY else, including an ordinary Space member who was never excluded from anything -
  // there was simply never a recipient list wider than "just the owner" to begin with.
  const outsiderOwnDiaryRead = await outsiderResolver.resolvePrivatePage('/tagebuch', { timeout: 1500 });
  assert.equal(outsiderOwnDiaryRead, null);
  const memberOwnDiaryRead = await memberResolver.resolvePrivatePage('/tagebuch', { timeout: 1500 });
  assert.equal(memberOwnDiaryRead, null, 'being in a DIFFERENT group/shared page never grants access to an unrelated, genuinely private page');

  // --- Growing the group, then re-saving the EXISTING page's content, reaches an ORIGINAL member
  // in real time - `recipients` genuinely drives live re-encryption, not a one-time snapshot. ---
  const newMember = await actor();
  members.push({ pub: newMember.signingPub, xPub: newMember.xPublicKey });
  // A real deployment would re-join/re-add this member to the Space itself first (out of scope for
  // this test - membership plumbing is orthogonal to the encryption feature this test is about);
  // reusing the SAME hub/members list here since the relay's own 'members' ACL for OTHER Kinds
  // isn't what's under test.
  const newMemberSpace = await connect(hub, newMember, members, 'new-member');
  const newMemberResolver = new ContentResolver(newMemberSpace, { appAdminPub: owner.signingPub });

  const before = await newMemberResolver.resolvePrivatePage('/familientreffen', { timeout: 1200 });
  assert.equal(before, null, 'not yet a group member - sees nothing yet');

  // resolveGroup()'s own useNode()/release() pair (every ContentResolver read releases when done)
  // means a group Node this same identity already read once earlier gets torn down locally between
  // calls, so THIS read needs a genuine round trip to the relay's mirror to see the edit below, not
  // just its own local state - waitForWritesAcked() (see its own doc comment) is what makes that
  // round trip deterministic instead of a guessed delay.
  await waitForWritesAcked(ownerSpace, () =>
    editGroup(ownerSpace, {
      name: 'familie',
      members: [
        { pub: owner.signingPub, xPub: owner.xPublicKey },
        { pub: memberA.signingPub, xPub: memberA.xPublicKey },
        { pub: newMember.signingPub, xPub: newMember.xPublicKey },
      ],
    })
  );
  const updatedGroup = await ownerResolver.resolveGroup('familie', { timeout: 2000 });
  assert.equal(updatedGroup.members.length, 3);

  await waitForWritesAcked(ownerSpace, () =>
    editPrivatePage(ownerSpace, {
      route: '/familientreffen',
      content: '<p>Geheimer Treffpunkt (aktualisiert)</p>',
      recipients: updatedGroup.members.map((m) => m.xPub),
    })
  );

  // memberA already had this page's FULL history (they were a recipient from creation, meta
  // included) - the live content edit reaches them exactly like any other real-time CRDT update.
  const memberSeesUpdate = await memberResolver.resolvePrivatePage('/familientreffen', { timeout: 2000 });
  assert.equal(memberSeesUpdate?.content, '<p>Geheimer Treffpunkt (aktualisiert)</p>', 'an EXISTING recipient sees a later content edit live, not just a one-time snapshot from creation');

  // --- Growing the group does NOT retroactively unlock this EXISTING page for the BRAND NEW
  // member, even though their key is now in `recipients` on the write above - see this test's own
  // top doc comment (point 6) for why: `stampMeta()`'s one-time meta envelope was sealed only for
  // [owner, memberA] at creation and is never re-sealed by a later edit, and Yjs will not integrate
  // ANY later update from that same author while an earlier one in their sequence (the meta stamp)
  // stays undecryptable to this reader. Correct, not a bug - the same "no retroactive decryption of
  // history from before you had a key" property real E2E group messaging relies on. ---
  const newMemberStillCannotReadOldPage = await newMemberResolver.resolvePrivatePage('/familientreffen', { timeout: 1500 });
  assert.equal(newMemberStillCannotReadOldPage, null, 'a page created before this identity joined the group stays permanently out of reach, regardless of later recipient-list edits');

  // --- What growing the group DOES unlock: a page CREATED after the group grew, sealed for its
  // CURRENT membership from the start (meta included) - fully readable by the new member immediately. ---
  await waitForWritesAcked(ownerSpace, () =>
    createPrivatePage(ownerSpace, {
      route: '/naechstes-treffen',
      title: 'Nächstes Treffen',
      content: '<p>Beim neuen Mitglied zu Hause</p>',
      recipients: updatedGroup.members.map((m) => m.xPub),
    })
  );
  const newMemberReadsNewPage = await newMemberResolver.resolvePrivatePage('/naechstes-treffen', { timeout: 2000 });
  assert.equal(newMemberReadsNewPage?.title, 'Nächstes Treffen');
  assert.equal(newMemberReadsNewPage?.content, '<p>Beim neuen Mitglied zu Hause</p>', 'a page created for the GROWN group is readable by the new member from the start - growing the group works going forward, just not retroactively');
});
