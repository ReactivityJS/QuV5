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
 *
 * UPDATE - PERSISTENT CLIENT STORAGE: `Space` is constructed with
 * `@qu/space-storage`'s `indexeddb-store.js` (when available) as its
 * `storage` - previously this Space was always memory-only, so every
 * reload/tab-open re-synced every Node touched during that session from
 * scratch over the network, even for a returning visitor with nothing new
 * to fetch. No change to `Space`/`Node`/`Field` themselves was needed -
 * `_hydrateFromStorage()` already reads local storage FIRST, instantly,
 * before ever sending a subscribe request; this was simply the first real
 * implementation of that param actually usable in a browser (the relay
 * side already had one, `file-store.js`).
 *
 * UPDATE - MOUNTPOINT/ADAPTER-REGISTRY: WHICH concrete storage/transport
 * adapter backs this Space is no longer a hardcoded `import` here - this
 * file builds an `@qu/bootstrap` `AdapterRegistry` (`./browser.js`'s own
 * pack: `'indexeddb'` storage, `'ws-client'` transport, the exact same two
 * classes this file used to construct by hand) and hands `bootstrapSpace()`
 * a plain config naming them by STRING (`{adapter: 'indexeddb'}`/
 * `{adapter: 'ws-client', url}`) instead (see docs/bootstrap-adapter-
 * registry.md) - a deployment that wants a DIFFERENT adapter (a different
 * persistent-storage backend, a non-WebSocket transport) swaps the config
 * value, never this file's own code.
 */
import { QuCrypto } from '@qu/core';
import { ensureUserProfile } from '@qu/space-core';
import { AdapterRegistry, bootstrapSpace, registerIdentityStoreAdapters } from '@qu/bootstrap';
import { registerBrowserAdapters } from '@qu/bootstrap/browser';
import '@qu/space-components/elements'; // registers <qu-view>/<qu-bind>/<qu-list> - see that module's own doc comment. Side-effect only import, deliberately unused otherwise.
import { joinSpace, fetchRelayAdmins, IDENTITY_STORAGE_KEY } from './identity.js';
import { initDevConsole } from './dev-console.js';
import { startApp, startPlatform } from './boot.js';

/**
 * This Shell's own registry - built once, module-scope (every
 * `<qu-app-shell>` instance on the SAME page shares it; registering twice
 * would throw, see `AdapterRegistry.register()`'s own doc comment, and
 * there is no reason a second element on the same page would want a
 * DIFFERENT set of adapters anyway). `registerIdentityStoreAdapters()` is
 * its own call (not part of `registerBrowserAdapters()`) on purpose -
 * see `@qu/bootstrap`'s `adapters/browser.js` own doc comment on why
 * identity registration is always a separate step, regardless of which
 * storage/transport pack(s) a deployment composes alongside it.
 */
const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry, { defaultKey: IDENTITY_STORAGE_KEY });
registerBrowserAdapters(registry);

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

      const identity = await registry.create('identity', 'local-storage', { key: IDENTITY_STORAGE_KEY });
      // joinSpace()'s own POST-then-GET is a genuine dependency (the member list must already
      // include the just-joined identity) and stays sequential - but fetchRelayAdmins() is a
      // completely independent, unauthenticated read (only fetched in PLATFORM mode - a single-app
      // deployment never touches `qu-platform-apps` at all, so there is nothing here for it to
      // independently verify, see `Space`'s own `relayAdmins` constructor doc comment) - run it
      // CONCURRENTLY with joinSpace() instead of waiting for it to finish first.
      const [members, relayAdmins] = await Promise.all([joinSpace({ name, identity }), isPlatformMode ? fetchRelayAdmins().catch(() => []) : []]);

      // `bootstrapSpace()` (`@qu/bootstrap`) resolves `transport`/`storage` through `registry` by
      // NAME - `'indexeddb'`/`'ws-client'` are exactly the two classes this file used to construct
      // by hand (see this file's own top doc comment) - calls `transport.connect()` itself, and
      // defaults `bus` to a fresh `EventBus` (unlike `Space`'s own quieter `null` default) - the
      // same real bus `cms-actions.js`'s `wireCms()` needs (Space's own `bus` getter doc comment) to
      // tell a save the RELAY silently rejected apart from one that genuinely succeeded. `storage`
      // falls back to memory-only (`Space`'s own default, `storage: null`) if this runtime has no
      // `indexedDB` at all (a privacy mode that removed it, an embedding context) - checked directly
      // against the global rather than through the registry, since "is this adapter even usable
      // here" is an environment question, not something resolving the adapter itself should have to
      // answer by throwing.
      const { space } = await bootstrapSpace({
        registry,
        identity,
        members,
        relayAdmins,
        transport: { adapter: 'ws-client', url: relayUrl },
        storage: typeof indexedDB !== 'undefined' ? { adapter: 'indexeddb' } : null,
      });

      // This SAME local identity's own User-Node (`@qu/space-core`'s `ensureUserProfile()`,
      // Arbeitspaket 5's Peer-User-Verwaltung primitive) - idempotent across reloads (storage
      // hydrates it before this ever has to touch the network, same as everything else `Space`
      // already local-first's), so this is what makes the local identity loaded above genuinely
      // double as one central user across every `<qu-app-shell>`-served app on this origin
      // (this file's own top doc comment on `IDENTITY_STORAGE_KEY` being a single fixed key) -
      // not just a bare keypair, but a discoverable `alias`/`epub` profile any OTHER peer can
      // resolve from just this identity's pubkey, with zero relay-admin/app involvement.
      await ensureUserProfile(space);

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
