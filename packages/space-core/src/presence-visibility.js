/**
 * PRESENCE VISIBILITY DECLARATION — a signed control message letting an
 * identity tell a RELAY who may see its REAL, live connection state (the
 * relay's own `PresenceTracker` - "genuinely has an open connection right
 * now", not `presenceKind`'s self-reported `online` field), without the
 * relay ever having to decode that identity's `presenceKind` Node content
 * to find out. Exactly the same shape/reasoning as `group-membership.js`'s
 * `signGroupMembership()`/`verifyGroupMembership()` - see that file's own
 * top doc comment for the full "why a signed declaration, not relay-side
 * Yjs decoding" argument, which applies here unchanged: the relay never
 * decodes ANY Node's Yjs content, not even a `'public'`-visibility field
 * (public meaning "not encrypted," never "the relay bothers to decode it").
 *
 * DELIBERATELY ONLY `'public'`/`'private'`, no relay-computed `'contacts'`
 * tier - a `'contacts'` check would need the relay to know which OTHER
 * identities share a Space with the declarer, which a relay hosting more
 * than one Space (or a Space whose own membership is itself meant to stay
 * relay-opaque - several of this framework's own ACL modes exist
 * specifically so the relay does NOT learn full membership) cannot answer
 * without a new, standing cross-Space index - real architectural surface
 * deliberately out of scope here. An app wanting a "contacts only" tier can
 * still build one client-side (e.g. filtering `'public'` results against
 * its own `AliasRegistry`) - just not one the relay itself enforces.
 *
 * `ts` (`Date.now()` at signing time) guards against reordered delivery the
 * same way `group-membership.js`'s own `ts` does - see that file's doc
 * comment for the exact mechanics; `relay.js`'s `presenceVisibility` map
 * applies the identical "ignore anything not strictly newer" rule.
 *
 * NOT MIRRORED, NOT DURABLE - same explicit scope boundary as
 * `group-membership.js`'s own declarations: 100% in-memory, per-relay-
 * process; a relay restart loses it, and the owning identity is expected to
 * re-declare (in practice: whenever it next calls `presence.js`'s
 * `declareOnlineVisibility()`, e.g. on every boot alongside `_sendHello()`)
 * rather than this file providing any replay/catch-up mechanism of its own.
 */
import { QuCrypto } from '@qu/core';

function encodePresenceVisibility(pub, onlineVisibility, ts) {
  return new TextEncoder().encode(`qu-presence-visibility-v1:${QuCrypto.toBase64(pub)}:${onlineVisibility}:${ts}`);
}

/**
 * @param {'public'|'private'} onlineVisibility
 * @param {{signingKey: Uint8Array, signingPub: Uint8Array}} owner - the identity this declaration is about; always itself, by construction (self-certifying, signed by the exact `pub` it carries).
 * @returns {Promise<object>} `{type:'presence-visibility', pub, onlineVisibility, ts, sig}` - ready to send over a transport exactly like `hello`/`grant`.
 */
export async function signPresenceVisibility(onlineVisibility, owner) {
  const ts = Date.now();
  const sig = await QuCrypto.sign(encodePresenceVisibility(owner.signingPub, onlineVisibility, ts), owner.signingKey);
  return { type: 'presence-visibility', pub: owner.signingPub, onlineVisibility, ts, sig };
}

/**
 * Verifies a `presence-visibility` message is authentically signed by the exact `pub` it claims,
 * and that `onlineVisibility` is one of the two values this mechanism supports - see this file's
 * own doc comment on why `'contacts'` is deliberately not one of them. Returns `false` for anything
 * malformed, forged, or out of range; never throws.
 * @param {object} message
 * @returns {Promise<boolean>}
 */
export async function verifyPresenceVisibility(message) {
  const { pub, onlineVisibility, ts, sig } = message ?? {};
  if (!pub || !ts || !sig) return false;
  if (onlineVisibility !== 'public' && onlineVisibility !== 'private') return false;
  return QuCrypto.verify(encodePresenceVisibility(pub, onlineVisibility, ts), sig, pub);
}
