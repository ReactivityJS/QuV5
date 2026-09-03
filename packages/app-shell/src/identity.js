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
 */
import { QuCrypto } from '@qu/core';

/** The one, central `localStorage` key `shell.js` loads/creates this browser's identity under - see this file's own doc comment on why it's a single fixed key, not per-app. */
export const IDENTITY_STORAGE_KEY = 'qu-identity';

/**
 * One in-flight promise per `key`, not per call - `storage.getItem()` is
 * synchronous, but generating a FRESH keypair genuinely isn't (Web
 * Crypto), so two callers racing for the same never-yet-created `key` on
 * the SAME page load (e.g. `dev-console.js`'s `window.Qu` and `shell.js`'s
 * own `<qu-app-shell>` boot, now that both can run on one page) would
 * otherwise both see "nothing stored yet," both generate their OWN
 * separate keypair, and both write - the second write silently winning,
 * leaving whichever caller got the first (now-orphaned, unpersisted)
 * keypair permanently out of sync with what's actually in storage. Keying
 * by `key` (not a single global lock) keeps two DIFFERENT identities
 * (different storage keys, e.g. distinct demo scripts) fully independent.
 */
const inFlight = new Map();

/**
 * @param {{getItem: (key: string) => string|null, setItem: (key: string, value: string) => void}} storage - e.g. `localStorage`.
 * @param {string} key
 * @returns {Promise<{signingKey: Uint8Array, signingPub: Uint8Array, xPrivateKey: Uint8Array, xPublicKey: Uint8Array}>}
 */
export function loadOrCreateIdentity(storage, key) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = loadOrCreateIdentityOnce(storage, key).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function loadOrCreateIdentityOnce(storage, key) {
  const raw = storage.getItem(key);
  if (raw) {
    const obj = JSON.parse(raw);
    return {
      signingKey: QuCrypto.fromBase64(obj.signingKey),
      signingPub: QuCrypto.fromBase64(obj.signingPub),
      xPrivateKey: QuCrypto.fromBase64(obj.xPrivateKey),
      xPublicKey: QuCrypto.fromBase64(obj.xPublicKey),
    };
  }
  const kp = await QuCrypto.generateKeypair();
  const identity = { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  storage.setItem(
    key,
    JSON.stringify({
      signingKey: QuCrypto.toBase64(identity.signingKey),
      signingPub: QuCrypto.toBase64(identity.signingPub),
      xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
      xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
    })
  );
  return identity;
}

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
