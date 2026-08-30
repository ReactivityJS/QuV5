/**
 * <qu-app-shell> — the ONE fixed piece of application JavaScript a Relay
 * serves (docs/app-shell-arbeitsauftrag.md §3): a DOM marker + lifecycle
 * hook, not a component system (that's `@qu/app-renderer`'s `qu-slot`/
 * future `qu-*` component registry, a separate concern). Its
 * `connectedCallback` runs the FRONT half of the boot sequence (Identity ->
 * join -> Transport -> Space, docs §4) and hands the result to `boot.js`'s
 * `startApp()` for the rest.
 *
 * `app-admin-pub` is read from the element's own attribute, never
 * hardcoded - it is the ONE thing that tells an otherwise-generic App
 * Shell which application's content to load (docs §5). A real deployment
 * sets it in the `index.html` a Relay serves, alongside this script -
 * see `public/index.html` in this package for the reference markup, and
 * this package's own README/docs pointer for how a Relay would serve this
 * file the same way `relay-app-server.js` already serves `demo/web/`
 * today (see that file's own "SERVES AN APP" doc comment).
 *
 * THIS FILE ONLY LOADS IN A BROWSER (or a DOM-shimmed environment, e.g.
 * jsdom with `HTMLElement`/`customElements` on `globalThis`) - it is
 * deliberately excluded from this package's own `index.js` (which stays
 * plain-Node-importable, see that file's own doc comment) since a bare
 * `class extends HTMLElement` throws the moment this module evaluates
 * under plain Node.
 */
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import { loadOrCreateIdentity, joinSpace, IDENTITY_STORAGE_KEY } from './identity.js';
import { startApp } from './boot.js';

export class QuAppShell extends HTMLElement {
  async connectedCallback() {
    try {
      const appAdminPub = QuCrypto.fromBase64(this.getAttribute('app-admin-pub'));
      const relayUrl = this.getAttribute('relay-url') ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
      const name = this.getAttribute('display-name') ?? `visitor-${Math.random().toString(36).slice(2, 8)}`;

      const identity = await loadOrCreateIdentity(localStorage, IDENTITY_STORAGE_KEY);
      const members = await joinSpace({ name, identity });

      const transport = new WsClientTransport(relayUrl);
      await transport.connect();
      const space = new Space({ identity, members, transport });

      startApp({ space, appAdminPub, mountEl: this, window });
    } catch (err) {
      this.textContent = `Qu App Shell: boot failed - ${err.message}`;
      throw err;
    }
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('qu-app-shell')) {
  customElements.define('qu-app-shell', QuAppShell);
}
