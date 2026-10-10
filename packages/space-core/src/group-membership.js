/**
 * GROUP MEMBERSHIP DECLARATION — a signed control message letting the OWNER
 * of a Group (`(groupOwnerPub, groupName)`, the self-certifying identity a
 * `'group'`-ACL Node's own id commits to - see kind-schema.js's own
 * "'group'" doc comment) tell a RELAY who currently belongs to it, without
 * the relay ever having to decode that Group's own Yjs content to find out.
 *
 * WHY THIS EXISTS AT ALL: `Space._currentGroupMembers()` (space.js) answers
 * this question CLIENT-side by reading the Group Node's own `members` field
 * directly - trivial for a client, which already decrypts/decodes every
 * Node it cares about. A relay never does that for ANY Node (see relay.js's
 * own top doc comment - "the relay never sees plaintext... not a policy
 * this class promises to follow, but a capability it was never handed in
 * the first place") - true even for a `visibility: 'public'` field (public
 * meaning "not encrypted," never "the relay bothers to Yjs-decode it").
 * Teaching the relay to apply mirrored Yjs updates into a real `Y.Doc` just
 * for this one ACL mode would be a first-of-its-kind, standing exception to
 * "the relay stays application-blind" - reversing that call is real
 * architectural surface this Task deliberately avoids. A signed, explicit
 * DECLARATION is the same shape `grant`/`member-joined` already use for
 * every other "make the relay aware of an ACL-relevant fact without asking
 * it to understand content" need.
 *
 * SELF-VERIFYING, same property `grant.js`'s own doc comment describes for
 * grants: the message carries `groupOwnerPub` itself and is signed BY that
 * exact key, so a relay (or another Space) that has never seen this Group
 * before can still verify the declaration on the spot - no prior registry
 * needed. It does NOT re-derive/compare against any Node id (unlike
 * `grant.js`'s own `verifyGrant()`) - a Group's OWN `(groupOwnerPub,
 * groupName)` pair IS the identity here, not a Node id it needs to match;
 * `deriveContentNodeId(groupOwnerPub, kind, groupName)` is what a `'group'`-
 * ACL WRITE's own self-certifying check recomputes against THIS pair
 * separately (kind-schema.js's own doc comment) - the two checks are
 * deliberately independent, composed together by `_isAuthorizedWriter()`'s
 * (space.js) and relay.js's `buildWriteAcl()`'s own `'group'` branch.
 *
 * `ts` (`Date.now()` at signing time) guards against a REORDERED delivery
 * silently regressing a relay's own view of current membership - e.g. a
 * "remove bob" declaration signed a moment ago arriving AFTER an earlier
 * "add bob" one that got briefly delayed. A verifier's own store (relay.js's
 * `groupMemberships`) keeps the last-applied `ts` per Group and ignores an
 * incoming declaration whose `ts` is not strictly newer - see relay.js's
 * own doc comment on that map for the exact mechanics. Only ever compared
 * to STATE THIS SAME VERIFIER already accepted, never trusted as a global
 * clock - the same "don't need synchronized clocks, only monotonic-per-
 * sender ordering" posture other timestamp-gated checks in this codebase
 * already take.
 *
 * NOT MIRRORED, NOT DURABLE, same explicit scope boundary relay.js's own
 * `grants`/`presence` already accept (that file's own "SUBSCRIBER-TRACKING"
 * doc comment) - 100% in-memory, per-relay-process; a relay restart loses
 * it exactly like it loses grants, and the owning Space is expected to
 * re-declare current membership (in practice: whenever it next edits the
 * Group, e.g. `@qu/app-core`'s `editGroup()`) rather than this file
 * providing any replay/catch-up mechanism of its own.
 */
import { QuCrypto } from '@qu/core';

function encodeGroupMembership(groupOwnerPub, groupName, memberPubs, ts) {
  const membersJoined = memberPubs.map((pub) => QuCrypto.toBase64(pub)).join(',');
  return new TextEncoder().encode(`qu-group-membership-v1:${QuCrypto.toBase64(groupOwnerPub)}:${groupName}:${membersJoined}:${ts}`);
}

/**
 * @param {{groupName: string, members: Array<Uint8Array>}} params - `members` is every CURRENT
 *   member's signing pubkey (raw bytes) - the Group's own `members` field typically stores richer
 *   per-entry data (`{pub, xPub}`, base64-encoded - see `@qu/app-core`'s `groupKind` doc comment);
 *   this declaration only ever needs the signing `pub` half, for the ACL check alone.
 * @param {{signingKey: Uint8Array, signingPub: Uint8Array}} owner - Must actually be this Group's
 *   owner; nothing here checks that locally, `verifyGroupMembership()` on the receiving end is what
 *   enforces it (by construction - it only ever accepts a declaration signed by the exact
 *   `groupOwnerPub` it carries, which the verifier trusts precisely as much as it trusts that key
 *   being genuinely this Group's owner in the first place - the same "no registry needed, signature
 *   alone is the proof" property `grant.js`'s own doc comment describes).
 * @returns {Promise<object>} `{type:'group-membership', groupOwnerPub, groupName, members, ts, sig}` -
 *   ready to send over a transport exactly like `hello`/`grant`.
 */
export async function signGroupMembership({ groupName, members }, owner) {
  const ts = Date.now();
  const sig = await QuCrypto.sign(encodeGroupMembership(owner.signingPub, groupName, members, ts), owner.signingKey);
  return { type: 'group-membership', groupOwnerPub: owner.signingPub, groupName, members, ts, sig };
}

/**
 * Verifies a `group-membership` message is authentically signed by the
 * exact `groupOwnerPub` it claims - see this file's own doc comment.
 * Returns `false` for anything malformed or forged; never throws.
 * @param {object} message
 * @returns {Promise<boolean>}
 */
export async function verifyGroupMembership(message) {
  const { groupOwnerPub, groupName, members, ts, sig } = message ?? {};
  if (!groupOwnerPub || !groupName || !Array.isArray(members) || !ts || !sig) return false;
  return QuCrypto.verify(encodeGroupMembership(groupOwnerPub, groupName, members, ts), sig, groupOwnerPub);
}
