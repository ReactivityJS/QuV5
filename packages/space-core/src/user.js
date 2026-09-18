/**
 * USER — the GunDB-style "User-Node": one self-certifying, `acl.write:
 * 'owner'` profile per identity (see kind-schema.js's `deriveOwnerNodeId()`),
 * the base Peer-User-Verwaltung primitive Arbeitspaket 5
 * (docs/quv5-vs-quv3-decision.md) asks for - analogous to GunDB's
 * per-user "always-public `pub`/`epub`, an `alias` defaulting to `pub`
 * itself" node, reusing this framework's EXISTING `'owner'`-ACL/envelope
 * machinery rather than inventing a second identity mechanism (the same
 * "build on what's already here" posture `presence.js`/`alias.js` already
 * take).
 *
 * DELIBERATELY THREE FIELDS, ALL `'public'` - no field-level encryption at
 * all, same reasoning kind-schema.js's own doc comment gives for `'public'`
 * visibility existing in the first place: a profile must be discoverable
 * by someone who has never shared a Space with this identity before (there
 * IS no membership list to encrypt for at that point) - `'owner'`-ACL
 * already makes a Kind's META public for exactly this reason, this just
 * extends the same posture to the fields themselves.
 *   - `alias` - a human-chosen display name, or unset (`resolveAlias()`
 *     below falls back to the pubkey itself, GunDB's own "alias defaults to
 *     pub" convention - see that function's own doc comment).
 *   - `epub` - this identity's X25519 public key, base64 - the SAME value
 *     already knowable via `identity.xPublicKey`/a Space's own member list,
 *     published here too so any OTHER peer who knows only a pubkey (not
 *     already a fellow Space member, no `/members.json` to consult) can
 *     still look up an encryption recipient for it - the discoverability
 *     half of "always public" the user's own framing asks for.
 *   - `listed` - this identity's OWN opt-in/opt-out into being surfaced in
 *     a public user directory (see `filterListedUsers()` below) - defaults
 *     to `false` (UNLISTED) the first time a profile is created, a
 *     deliberate privacy-by-default choice (this framework's own emphasis
 *     on Datenschutz über alles - nothing should make an identity more
 *     discoverable than it explicitly opted into), overridable any time via
 *     `ensureUserProfile(space, {listed: true})`.
 *
 * CUSTOM/APP-DEFINED PROFILE PROPERTIES ARE DELIBERATELY NOT A FIELD HERE -
 * Kind-Schema is a static, typed contract by design (kind-schema.js's own
 * doc comment), not an open/extensible bag of properties a caller can grow
 * at runtime. The extensibility story this framework already has is: an
 * app defines its OWN `acl.write: 'owner'`/`'content'` Kind, scoped to the
 * SAME identity (`deriveOwnerNodeId(pub, 'my-app-profile-extra')`/
 * `deriveContentNodeId(pub, kind, path)`), with whichever mix of
 * `'public'`/`'encrypted'` fields it needs - see `acl.test.js`'s own
 * `profileKind` example, which already does exactly this with zero
 * framework changes. `docs/peer-user-management.md` spells this out with a
 * worked example, including 1:n group-encrypted custom fields (`field.
 * set(value, {recipients})` - already supported, no new crypto needed).
 */
import { QuCrypto } from '@qu/core';
import { defineKind, deriveOwnerNodeId } from './kind-schema.js';

export const userKind = defineKind('qu-user', {
  fields: {
    alias: { shape: 'atomic', visibility: 'public' },
    epub: { shape: 'atomic', visibility: 'public' },
    listed: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'owner' },
});

/** @param {Uint8Array} pub @returns {Promise<string>} the self-certifying User-Node id for `pub` - same derivation any `'owner'`-ACL Kind uses (see kind-schema.js's `deriveOwnerNodeId()`). */
export function userNodeId(pub) {
  return deriveOwnerNodeId(pub, userKind.kind);
}

/**
 * GunDB's own "alias defaults to pub" convention: a human-chosen `alias` if
 * one was ever set, otherwise the identity's own pubkey, base64url-encoded
 * (URL/display-safe - the same encoding `@qu/app-shell`'s own routing
 * already uses for a pubkey shown to a human, e.g. `boot.js`'s "Dein
 * eigener Bereich" link - plain base64 routinely contains `/`/`+`, which is
 * fine for config/copy-paste but awkward for display/URLs).
 * @param {string|null|undefined} alias
 * @param {Uint8Array|string} pub - `string` = already base64(-url) encoded.
 * @returns {string}
 */
export function resolveAlias(alias, pub) {
  if (alias) return alias;
  const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
  return QuCrypto.toBase64Url(pubBytes);
}

/**
 * Polls `field.isSet()` (synchronous - `'public'` visibility needs no
 * decryption to check) until it's `true`, `space.isNodeSynced(nodeId)`
 * confirms a subscribed relay has told this Space everything it currently
 * has (so `isSet()` still being `false` at that point means "genuinely
 * never published," not "just hasn't arrived yet" - same reasoning
 * `@qu/app-core`'s `resolver.js`'s own `waitFor()` already established for
 * this exact tradeoff), or `timeout` elapses, whichever comes first.
 * Re-implemented locally (space-core must never depend on `@qu/app-core`)
 * rather than sharing that function - deliberately smaller: a
 * `'public'`-visibility field's `isSet()` needs no decrypt-and-retry loop
 * `waitFor()`'s own `checkFn` otherwise has to support.
 */
async function waitUntilSet(space, nodeId, field, { timeout, interval = 20 }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (field.isSet()) return true;
    if (space.isNodeSynced(nodeId)) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return field.isSet();
}

/**
 * Creates THIS Space's own identity's User-Node on first call (with
 * `epub` always set, `listed` defaulting to `false` - see this file's own
 * top doc comment), or reconciles an existing one on every later call -
 * idempotent across process restarts, not just within one: briefly waits
 * (`timeout`, default generous enough for a real relay round-trip) to see
 * whether a profile ALREADY exists (this Space's own local storage, or a
 * subscribed relay's mirror) before deciding "new," so a caller that simply
 * calls this once per boot (the intended usage - see `@qu/app-shell`'s
 * `shell.js`) never resets a previously-chosen `alias`/`listed` back to
 * their defaults on a later run. `alias`/`listed`, if GIVEN, always apply
 * (an explicit call always wins) regardless of new-or-existing; omitted
 * ones are left exactly as they are for an existing profile, or unset/
 * `false` (their documented defaults) for a brand new one.
 *
 * A REAL, ACCEPTED RESIDUAL: if this Space is offline with no local
 * storage at all (never seen this profile before, no relay to ask), this
 * necessarily treats it as "new" and writes defaults - if the profile
 * DOES already exist elsewhere (a different device, under the SAME
 * identity, that set `listed: true`), the two concurrent `'listed'` writes
 * race at the Yjs/CRDT level once both sides eventually sync, same honest
 * tradeoff any offline-first optimistic write already has elsewhere in
 * this framework (see e.g. `grant.js`'s own "write-before-grant" doc
 * comment for another instance of "correctness needs the other side to
 * have actually been seen first").
 * @param {import('./space.js').Space} space
 * @param {{alias?: string|null, listed?: boolean, timeout?: number}} [options]
 * @returns {Promise<import('./node.js').SpaceNode>}
 */
export async function ensureUserProfile(space, { alias, listed, timeout = 1500 } = {}) {
  const nodeId = await userNodeId(space.identity.signingPub);
  const { node } = await space.useNode(nodeId, userKind);
  const alreadyExists = await waitUntilSet(space, nodeId, node.field('epub'), { timeout });

  if (!alreadyExists) {
    await node.field('epub').set(QuCrypto.toBase64(space.identity.xPublicKey));
    await node.field('listed').set(listed ?? false);
    if (alias) await node.field('alias').set(alias);
  } else {
    if (alias !== undefined) await node.field('alias').set(alias);
    if (listed !== undefined) await node.field('listed').set(listed);
  }
  return node;
}

/**
 * Given a list of CANDIDATE pubkeys (from whatever peer-discovery a
 * deployment already has - a relay's own `/members.json`, a contacts
 * list, ... - this function deliberately invents no new enumeration
 * mechanism of its own, see `docs/peer-user-management.md`), resolves
 * each one's User-Node and returns only those that opted IN to `listed`
 * (the opposite of the default - see this file's own top doc comment) -
 * `{pub, alias, epub}` for each, `alias` already resolved via
 * `resolveAlias()` so a caller never has to special-case "no alias set."
 * Releases every Node it subscribed to purely for this lookup before
 * returning (unlike `ensureUserProfile()`, which deliberately leaves THIS
 * Space's own profile subscribed) - this is a one-shot peek, not a
 * standing watch.
 * @param {import('./space.js').Space} space
 * @param {Array<Uint8Array|string>} pubs
 * @param {{timeout?: number}} [options]
 * @returns {Promise<Array<{pub: Uint8Array, alias: string, epub: string|null}>>}
 */
export async function filterListedUsers(space, pubs, { timeout = 1500 } = {}) {
  const results = await Promise.all(
    pubs.map(async (pub) => {
      const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
      const nodeId = await userNodeId(pubBytes);
      const { node, release } = await space.useNode(nodeId, userKind);
      await waitUntilSet(space, nodeId, node.field('listed'), { timeout });
      const [alias, epub, listed] = await Promise.all([node.field('alias').get(), node.field('epub').get(), node.field('listed').get()]);
      release();
      return listed === true ? { pub: pubBytes, alias: resolveAlias(alias, pubBytes), epub } : null;
    })
  );
  return results.filter((entry) => entry !== null);
}
