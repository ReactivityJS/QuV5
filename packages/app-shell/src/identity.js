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
 */
import { QuCrypto } from '@qu/core';

/** The one, central `localStorage` key `shell.js` loads/creates this browser's identity under - see this file's own doc comment on why it's a single fixed key, not per-app. */
export const IDENTITY_STORAGE_KEY = 'qu-identity';

/**
 * @param {{getItem: (key: string) => string|null, setItem: (key: string, value: string) => void}} storage - e.g. `localStorage`.
 * @param {string} key
 * @returns {Promise<{signingKey: Uint8Array, signingPub: Uint8Array, xPrivateKey: Uint8Array, xPublicKey: Uint8Array}>}
 */
export async function loadOrCreateIdentity(storage, key) {
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
