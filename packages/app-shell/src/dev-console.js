/**
 * DEV CONSOLE — exposes `window.Qu`, a small identity-bootstrapping API any
 * page this bundle loads on gets for free, the relay's own UNCONFIGURED
 * setup page in particular (`build.mjs`'s `renderIndexHtml()`, the "no
 * QU_APP_ADMIN_PUB/QU_RELAY_ADMINS set yet" branch): rather than making
 * an operator run a separate script just to GENERATE a bootstrapping
 * identity, the setup page itself now loads this SAME bundle (`/bundle.js`,
 * already built and served regardless of configuration state) and this
 * module runs unconditionally, independent of whether a `<qu-app-shell>`
 * element exists on the page at all.
 *
 * "REMEMBER ME" IS NOT NEW HERE - `identity.js`'s `loadOrCreateIdentity()`
 * already IS that primitive (create once, persist under
 * `IDENTITY_STORAGE_KEY`, silently reload the same identity on every later
 * page load) - `shell.js`'s own `<qu-app-shell>` boot flow already relies
 * on it. This module calls the EXACT SAME function for the EXACT SAME key,
 * on purpose: whoever opens the unconfigured setup page becomes, for free,
 * the SAME identity their browser will later use to VISIT the app once
 * it's configured - a natural way to become your own app's first
 * app-admin, not a second, parallel identity to keep track of. See
 * `identity.js`'s own doc comment for why concurrent callers of
 * `loadOrCreateIdentity()` for the same key (this module AND, on an
 * ALREADY-configured page, `<qu-app-shell>`'s own boot, both present in
 * the same `/bundle.js`) can't race each other into generating two
 * different keypairs.
 *
 * DOM CONVENTION (optional, purely a display convenience - nothing here
 * requires it): an element matching `[data-qu-pub]`/`[data-qu-xpub]`
 * anywhere on the page gets its `textContent` set to the current
 * identity's base64 signing/X25519 pubkey once ready - `build.mjs`'s own
 * unconfigured-page markup uses this so the exact values `QU_APP_ADMIN_PUB`/
 * `QU_MEMBERS_JSON`/`QU_RELAY_ADMINS` expect are copy-pasteable straight off
 * the page, no devtools required -
 * `window.Qu` itself (`Qu.pub`/`Qu.xPub`/`Qu.identity`) stays available
 * for anyone who prefers the console, or wants the raw keys for a script.
 */
import { QuCrypto } from '@qu/core';
import { loadOrCreateIdentity, IDENTITY_STORAGE_KEY } from './identity.js';

/**
 * @param {{storage?: {getItem: Function, setItem: Function, removeItem: Function}, doc?: Document, win?: {location?: {reload: Function}}}} [params]
 * @returns {Promise<{QuCrypto: object, identity: object, pub: string, xPub: string, regenerate: () => Promise<void>}>} the same object assigned to `window.Qu`.
 */
export async function initDevConsole({ storage = globalThis.localStorage, doc = globalThis.document, win = globalThis } = {}) {
  const identity = await loadOrCreateIdentity(storage, IDENTITY_STORAGE_KEY);
  const pub = QuCrypto.toBase64(identity.signingPub);
  const xPub = QuCrypto.toBase64(identity.xPublicKey);

  const api = {
    QuCrypto,
    identity,
    pub,
    xPub,
    /** Discards the stored identity and reloads - the next load generates (and persists) a fresh one. Irreversible: any pubkey already handed to a relay's config becomes unusable by this browser afterward. */
    async regenerate() {
      storage.removeItem(IDENTITY_STORAGE_KEY);
      win.location?.reload();
    },
  };
  win.Qu = api;

  const pubEl = doc?.querySelector('[data-qu-pub]');
  if (pubEl) pubEl.textContent = pub;
  const xPubEl = doc?.querySelector('[data-qu-xpub]');
  if (xPubEl) xPubEl.textContent = xPub;

  doc?.dispatchEvent(new (win.CustomEvent ?? CustomEvent)('qu-dev-console-ready', { detail: api }));
  return api;
}
