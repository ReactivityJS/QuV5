/**
 * GRANT — a signed control message letting the OWNER of a self-certifying
 * `'owner'`/`'named'` Node (see kind-schema.js's `deriveOwnerNodeId()`)
 * authorize one additional pubkey to write to that Node. Same family as
 * `hello`/`subscribe` (space.js) - unencrypted, signed, verifiable by
 * anyone holding only public keys (a relay included - see
 * `@qu/space-transport`'s relay.js), never a write itself (no Yjs update
 * travels inside one, so it never touches a Node's CRDT/history).
 *
 * A grant is self-verifying with ZERO prior relay/Space state, the same
 * property `deriveOwnerNodeId()` already gives `'owner'` mode: the message
 * carries `kind` and `ownerPub` itself, so a verifier recomputes
 * `deriveOwnerNodeId(ownerPub, kind)` and checks it equals `nodeId` -
 * proving the signer really is THIS Node's owner, not just some space
 * member - before trusting the signature at all. No registry of "who owns
 * which Node" needs to exist anywhere for this to work; a relay/Space that
 * has never seen this Node before can still verify a grant for it on the
 * spot.
 *
 * `'named'`-mode write-ACL state (a relay's or a Space's own `nodeId ->
 * Set<granteePubB64>`) is 100% DERIVED from grant messages verified this
 * way - never invented, never trusted at face value from an unsigned
 * source. Revocation is deliberately out of scope here (same "real,
 * separate work" boundary kind-schema.js's own doc comment draws around
 * full per-field/per-role ACL) - a granted writer stays granted for the
 * life of the process that learned about the grant.
 *
 * WRITE-BEFORE-GRANT IS A TRAP - a real Yjs property, not a gap in this
 * ACL design: Yjs integrates each author's updates as a STRICTLY ORDERED
 * per-author sequence (per-clientID clock, gapless) into every peer's own
 * doc. If a peer ever rejects one update from an author (rightly so, e.g.
 * a write attempted before that author was granted), that peer's doc now
 * has a permanent gap in that author's sequence - it can *never* integrate
 * a LATER update from that same author's same local `Y.Doc` either, grant
 * or no grant: `Y.applyUpdate()` silently queues it as "pending on a
 * dependency that will never arrive," not an error, not a retry. This is
 * NOT specific to `'named'`/`'owner'` ACL - it's exactly as true for a
 * `'members'`-mode Kind if a non-member's write is ever momentarily
 * accepted (see space.js's own doc comment on what `_isAuthorizedWriter()`
 * checks). The practical rule this implies: authorize a writer BEFORE they
 * ever attempt a write, not in response to one - `grantWriter()` should
 * complete before the grantee's app code calls its first `field.set()`/
 * `.push()`/`.insert()` on the Node. A writer that already tripped this
 * (wrote once, got rejected) has no way back on that Y.Doc; the only fix
 * is a fresh local `Y.Doc` for the Node (re-`subscribeNode()` from a new
 * doc instance - a new random Yjs clientID starts a clean, gapless
 * sequence of its own), never retrying on the same one.
 */
import { QuCrypto } from '@qu/core';
import { deriveOwnerNodeId } from './kind-schema.js';

function encodeGrant(nodeId, kind, granteePub) {
  return new TextEncoder().encode(`${nodeId}:${kind}:${QuCrypto.toBase64(granteePub)}`);
}

/**
 * @param {{nodeId: string, kind: string, granteePub: Uint8Array}} params
 * @param {{signingKey: Uint8Array, signingPub: Uint8Array}} owner - Must actually be this Node's owner; nothing here checks that locally, `verifyGrant()` on the receiving end is what enforces it.
 * @returns {Promise<object>} `{type:'grant', nodeId, kind, ownerPub, granteePub, sig}` - ready to send over a transport exactly like `hello`/`subscribe`, and to broadcast onward exactly like relay.js's own `member-joined` message.
 */
export async function signGrant({ nodeId, kind, granteePub }, owner) {
  const sig = await QuCrypto.sign(encodeGrant(nodeId, kind, granteePub), owner.signingKey);
  return { type: 'grant', nodeId, kind, ownerPub: owner.signingPub, granteePub, sig };
}

/**
 * Verifies a `grant` message is BOTH authentically signed AND signed by
 * the Node's actual owner (not just any well-formed keypair) - see this
 * file's own doc comment. Returns `false` for anything malformed or
 * forged; never throws.
 * @param {object} message
 * @returns {Promise<boolean>}
 */
export async function verifyGrant(message) {
  const { nodeId, kind, ownerPub, granteePub, sig } = message ?? {};
  if (!nodeId || !kind || !ownerPub || !granteePub || !sig) return false;
  const expectedNodeId = await deriveOwnerNodeId(ownerPub, kind);
  if (expectedNodeId !== nodeId) return false;
  return QuCrypto.verify(encodeGrant(nodeId, kind, granteePub), sig, ownerPub);
}
