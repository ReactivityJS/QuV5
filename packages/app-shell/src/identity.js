/**
 * IDENTITY / JOIN — the App Shell's own bootstrap identity: ONE keypair per
 * browser/profile, generated once and kept only in caller-supplied
 * `storage` (`localStorage` in a real browser - see `shell.js`), never sent
 * anywhere but its PUBLIC halves. Same mechanism `demo/web/main.js`'s own
 * `loadOrCreateIdentity()`/join flow already established for the chat demo
 * client - generalized here so any App Shell deployment can reuse it,
 * rather than reinventing it per app.
 *
 * DELIBERATELY CENTRAL, NOT PER-APP: `shell.js` reads `IDENTITY_STORAGE_KEY`
 * below - a SINGLE fixed key, not derived from `app-admin-pub`/the current
 * app's manifest in any way - so a browser visiting several DIFFERENT
 * `qu-app` apps served from the SAME origin (a "Quniverse"-style platform
 * hosting many apps behind one relay, docs/app-shell-arbeitsauftrag.md's
 * own leitmotiv) uses the SAME identity for all of them, exactly the way a
 * person is one identity across many Spaces elsewhere in this framework
 * (see `@qu/space-core`'s `alias.js` for the one place that DOES want
 * per-Space unlinkability, and deliberately derives a separate keypair for
 * it - the opposite of what a platform's own visitor identity wants). This
 * is what avoids "per-app identity conflicts": there is only ever one
 * identity to reconcile, whether the Shell boots a single app or many.
 * A caller who genuinely wants per-app-isolated identities can still pass
 * a different `key` to `loadOrCreateIdentity()` directly - this file
 * doesn't hardcode using `IDENTITY_STORAGE_KEY`, `shell.js` does.
 *
 * SCOPE OF "central": `localStorage` is per-ORIGIN - this centralizes
 * identity across every app one relay/origin serves, not across separate
 * relays/domains. Genuine cross-origin identity portability (the same
 * person, a different relay entirely) needs explicit export/import and is
 * real, separate work, not something this file does today.
 *
 * `joinSpace()` calls the relay's OWN, already-existing `POST /join`/
 * `GET /members.json` endpoints (`@qu/space-transport`'s
 * `relay-app-server.js`) - this is deliberately not a new mechanism: it's
 * how a `'members'`-ACL Kind's content (`qu-page`/`qu-template`/`qu-style`,
 * see `@qu/app-core`'s `kinds.js`) becomes readable by an anonymous
 * visitor at all (docs/app-shell-arbeitsauftrag.md §12's own documented
 * tradeoff), reusing the relay's existing self-service membership, not a
 * new "public content" ACL mode.
 *
 * `loadOrCreateIdentity()` is exactly the "remember me" primitive: create
 * once, persist under `IDENTITY_STORAGE_KEY`, silently reload the SAME
 * identity on every later call for that key - `shell.js`'s own boot flow
 * already relies on this, and `dev-console.js`'s `window.Qu` (loaded on
 * the relay's own unconfigured setup page, `build.mjs`'s `renderIndexHtml()`)
 * calls this SAME function for the SAME key, deliberately - no separate
 * persistence mechanism to keep in sync.
 *
 * PROMOTED TO `@qu/bootstrap` - re-exported here UNCHANGED (this is a
 * plain re-export, the exact same function object, not a reimplementation)
 * so every existing caller of THIS module keeps working with zero changes.
 * "Where does a peer's local identity live" turned out to be exactly the
 * kind of bootstrap-time, adapter-shaped choice `@qu/bootstrap` exists for
 * (see docs/bootstrap-adapter-registry.md and `@qu/bootstrap`'s own
 * `identity-stores.js`) - not something specific to a browser App Shell.
 * Re-exporting rather than duplicating also matters CORRECTNESS-wise, not
 * just for tidiness: this module's own doc comment above describes
 * `dev-console.js` and `shell.js` relying on calling the EXACT SAME
 * function (sharing its module-level in-flight-promise race guard) for
 * the same key - two independent copies of the same logic would silently
 * break that guarantee the moment `shell.js` resolved its identity through
 * a DIFFERENT copy (e.g. via `@qu/bootstrap`'s own `AdapterRegistry`)
 * than `dev-console.js` still called directly.
 */
import { QuCrypto } from '@qu/core';

export { loadOrCreateIdentity } from '@qu/bootstrap';

/** The one, central `localStorage` key `shell.js` loads/creates this browser's identity under - see this file's own doc comment on why it's a single fixed key, not per-app. */
export const IDENTITY_STORAGE_KEY = 'qu-identity';

/**
 * Registers `identity` as a `'members'`-mode Space member via the relay's
 * `POST /join`, then reads back the FULL current member list via
 * `GET /members.json` (which already includes this identity - `/join`
 * completes before this resolves).
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, name: string, identity: object}} params
 * @returns {Promise<Array<{pub: Uint8Array, xPub: Uint8Array}>>}
 */
export async function joinSpace({ fetchImpl = fetch, baseUrl = '', name, identity }) {
  const joinRes = await fetchImpl(`${baseUrl}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pub: QuCrypto.toBase64(identity.signingPub), xPub: QuCrypto.toBase64(identity.xPublicKey) }),
  });
  if (!joinRes.ok) throw new Error(`joinSpace: /join failed: ${joinRes.status} ${await joinRes.text()}`);

  const membersRes = await fetchImpl(`${baseUrl}/members.json`);
  const rawMembers = await membersRes.json();
  return rawMembers.map((m) => ({ pub: QuCrypto.fromBase64(m.pub), xPub: QuCrypto.fromBase64(m.xPub) }));
}

/**
 * READ-ONLY fetch of `GET /members.json` (or another `{pub, xPub}`-shaped
 * endpoint via `path`) - a plain, unauthenticated read of whoever is
 * currently a `'members'`-ACL member, independent of `joinSpace()`'s own
 * self-registration POST. Used standalone by any caller that only needs to
 * construct a `Space` with the right member/recipient list without also
 * joining (`joinSpace()` does both in one call for the common case).
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string, path?: string}} params
 * @returns {Promise<Array<{pub: Uint8Array, xPub: Uint8Array}>>}
 */
export async function fetchMembers({ fetchImpl = fetch, baseUrl = '', path = '/members.json' } = {}) {
  const membersRes = await fetchImpl(`${baseUrl}${path}`);
  const rawMembers = await membersRes.json();
  return rawMembers.map((m) => ({ pub: QuCrypto.fromBase64(m.pub), xPub: QuCrypto.fromBase64(m.xPub) }));
}

/**
 * Reads `GET /relay-admins.json` (`relay-server.js`'s own doc comment) -
 * a DIFFERENT shape from `fetchMembers()` above on purpose: a plain array
 * of base64 SIGNING pubkeys only, never `{pub, xPub}` pairs, because the
 * main Space's own `acl.write: 'relay-admins'` check (`@qu/space-core`'s
 * kind-schema.js) never needs an encryption recipient - `qu-platform-apps`
 * is `'public'`-visibility (see this file's own top doc comment on why a
 * DIFFERENT helper exists at all rather than reusing `fetchMembers()` here:
 * calling that one against this endpoint would silently misparse every
 * entry - `m.pub` on a bare string is `undefined` - leaving the resulting
 * `Space` unable to verify ANY `qu-platform-apps` write it receives).
 * @param {{fetchImpl?: typeof fetch, baseUrl?: string}} [params]
 * @returns {Promise<Array<Uint8Array>>}
 */
export async function fetchRelayAdmins({ fetchImpl = fetch, baseUrl = '' } = {}) {
  const res = await fetchImpl(`${baseUrl}/relay-admins.json`);
  const rawPubs = await res.json();
  return rawPubs.map((pubB64) => QuCrypto.fromBase64(pubB64));
}
