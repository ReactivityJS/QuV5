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
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import { EventBus } from '@qu/events';
import { autoCompactOnJoin } from '@qu/space-plugins';
import '@qu/space-components/elements'; // registers <qu-view>/<qu-bind>/<qu-list> - see that module's own doc comment. Side-effect only import, deliberately unused otherwise.
import { deriveContentNodeId, adminAppManifestKind, adminTemplateKind, adminPageKind, ADMIN_REALM_ANCHOR } from '@qu/app-core';
import { loadOrCreateIdentity, joinSpace, fetchMembers, fetchRelayAdmins, IDENTITY_STORAGE_KEY } from './identity.js';
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
      // `relayAdmins` constructor doc comment, and `relay-server.js`'s own "ADMIN REALM"-adjacent
      // `GET /relay-admins.json` doc comment for the server side of this public, unauthenticated read).
      const relayAdmins = isPlatformMode ? await fetchRelayAdmins().catch(() => []) : [];

      const transport = new WsClientTransport(relayUrl);
      await transport.connect();
      const space = new Space({ identity, members, relayAdmins, transport });

      if (isPlatformMode) {
        // The admin realm's own transport/Space - see relay-server.js's own "ADMIN REALM" doc
        // comment for the server side of this `/admin-ws` convention. Built lazily (boot.js only
        // calls this the first time a route actually resolves into `realm: 'admin'`) - the SAME
        // identity as the main Space (no separate admin identity to manage), it just may or may not
        // turn out to be one of the admin realm's own configured members.
        const connectAdminSpace = async () => {
          const adminUrl = relayUrl.replace(/\/?$/, '') + '/admin-ws';
          const httpBase = relayUrl.startsWith('wss:') ? relayUrl.replace(/^wss:/, 'https:') : relayUrl.replace(/^ws:/, 'http:');
          const adminMembers = await fetchMembers({ baseUrl: httpBase, path: '/admin-members.json' }).catch(() => []);
          const adminTransport = new WsClientTransport(adminUrl);
          await adminTransport.connect();
          const adminBus = new EventBus();
          const adminSpace = new Space({ identity, members: adminMembers, transport: adminTransport, bus: adminBus });
          // The admin realm's content is genuinely 'encrypted' (kinds.js's "THE ADMIN REALM" doc
          // comment) - unlike the main Space's own public app content, it DOES have the late-joiner
          // gap `@qu/space-plugins`' autoCompactOnJoin() exists to close (see that file's own doc
          // comment). Only the BUILT-IN console's own well-known ids are covered here - any OTHER
          // admin-realm content a deployment installs later would need its own `.watch(nodeId)` call
          // to stay reachable for a newly added admin, a currently undocumented gap for anything
          // beyond this one console.
          const manifestId = await deriveOwnerNodeId(ADMIN_REALM_ANCHOR, adminAppManifestKind.kind);
          const templateId = await deriveContentNodeId(ADMIN_REALM_ANCHOR, adminTemplateKind.kind, 'main');
          const pageId = await deriveContentNodeId(ADMIN_REALM_ANCHOR, adminPageKind.kind, '/');
          autoCompactOnJoin(adminSpace, adminBus, [manifestId, templateId, pageId]);
          return adminSpace;
        };
        startPlatform({ space, connectAdminSpace, mountEl: this, window });
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
