/**
 * <qu-app-shell> — the ONE fixed piece of application JavaScript a Relay
 * serves (docs/app-shell-arbeitsauftrag.md §3): a DOM marker + lifecycle
 * hook, not a component system (that's `@qu/app-renderer`'s `qu-slot`/
 * future `qu-*` component registry, a separate concern). Its
 * `connectedCallback` runs the FRONT half of the boot sequence (Identity ->
 * join -> Transport -> Space, docs §4) and hands the result to `boot.js`'s
 * `startApp()`/`startPlatform()` for the rest.
 *
 * ONE of two attributes decides what gets booted, never both - the ONE
 * thing that tells an otherwise-generic App Shell what to load (docs §5):
 *   - `app-admin-pub="<base64 pubkey>"` - a SINGLE app, `startApp()` (docs §5-18).
 *   - `relay-admin-pub` - a bare, boolean-style marker (its VALUE carries no
 *     meaning - `qu-platform-apps` is `'relay-admins'`-ACL, checked against
 *     the relay's own boot-time `QU_RELAY_ADMINS` list, never against one
 *     pubkey embedded in this markup, see `@qu/app-core`'s `kinds.js` own
 *     doc comment) - a PLATFORM of however many apps that registry lists,
 *     path-prefix-routed, `startPlatform()` (docs §19-21) - takes priority
 *     if both are present.
 * A real deployment sets whichever one in the `index.html` a Relay serves,
 * alongside this script - see `public/index.html` in this package for the
 * reference markup, and this package's own README/docs pointer for how a
 * Relay would serve this file the same way `relay-app-server.js` already
 * serves `demo/web/` today (see that file's own "SERVES AN APP" doc
 * comment).
 *
 * THIS FILE ONLY LOADS IN A BROWSER (or a DOM-shimmed environment, e.g.
 * jsdom with `HTMLElement`/`customElements` on `globalThis`) - it is
 * deliberately excluded from this package's own `index.js` (which stays
 * plain-Node-importable, see that file's own doc comment) since a bare
 * `class extends HTMLElement` throws the moment this module evaluates
 * under plain Node.
 *
 * ALSO INITIALIZES `window.Qu` UNCONDITIONALLY (`initDevConsole()`,
 * `dev-console.js`), independent of whether a `<qu-app-shell>` element
 * exists on the page at all - this is what lets the relay's own
 * UNCONFIGURED setup page (`build.mjs`'s `renderIndexHtml()`) load this
 * SAME bundle and offer a working identity-bootstrapping console before
 * any app/platform is even configured. See that file's own doc comment.
 */
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import '@qu/space-components/elements'; // registers <qu-view>/<qu-bind>/<qu-list> - see that module's own doc comment. Side-effect only import, deliberately unused otherwise.
import { loadOrCreateIdentity, joinSpace, fetchRelayAdmins, IDENTITY_STORAGE_KEY } from './identity.js';
import { initDevConsole } from './dev-console.js';
import { startApp, startPlatform } from './boot.js';

export class QuAppShell extends HTMLElement {
  async connectedCallback() {
    try {
      // A bare boolean-style attribute (no value carries meaning any more - `platformAppsKind` is
      // `'relay-admins'`-ACL, checked against the relay's own boot-time QU_RELAY_ADMINS list, never
      // against one pubkey embedded in this markup - see build.mjs's own doc comment) - PRESENCE is
      // what decides `startPlatform()` vs `startApp()` below, so `hasAttribute()`, not truthiness of
      // a (possibly empty-string) value.
      const isPlatformMode = this.hasAttribute('relay-admin-pub');
      const appAdminPubB64 = this.getAttribute('app-admin-pub');
      const relayUrl = this.getAttribute('relay-url') ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
      const name = this.getAttribute('display-name') ?? `visitor-${Math.random().toString(36).slice(2, 8)}`;

      const identity = await loadOrCreateIdentity(localStorage, IDENTITY_STORAGE_KEY);
      const members = await joinSpace({ name, identity });
      // Only fetched in PLATFORM mode - a single-app deployment never touches `qu-platform-apps`
      // at all, so there is nothing here for it to independently verify (see `Space`'s own
      // `relayAdmins` constructor doc comment, and `relay-server.js`'s own `GET /relay-admins.json`
      // doc comment for the server side of this public, unauthenticated read).
      const relayAdmins = isPlatformMode ? await fetchRelayAdmins().catch(() => []) : [];

      const transport = new WsClientTransport(relayUrl);
      await transport.connect();
      const space = new Space({ identity, members, relayAdmins, transport });

      if (isPlatformMode) {
        // The admin app lives in this SAME main Space now (kinds.js's own "THE ADMIN APP" doc
        // comment) - no separate transport/Space/identity to build. Any visitor's own regular
        // identity works the moment its pubkey is listed in QU_RELAY_ADMINS.
        startPlatform({ space, mountEl: this, window });
      } else {
        startApp({ space, appAdminPub: QuCrypto.fromBase64(appAdminPubB64), mountEl: this, window });
      }
    } catch (err) {
      this.textContent = `Qu App Shell: boot failed - ${err.message}`;
      throw err;
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('qu-app-shell')) {
  customElements.define('qu-app-shell', QuAppShell);
}

initDevConsole().catch((err) => console.error('Qu dev console failed to initialize:', err));
