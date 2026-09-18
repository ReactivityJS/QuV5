/**
 * BROWSER ADAPTER PACK — the real-deployment adapter set for a client
 * running in an actual browser (`@qu/app-shell`'s `shell.js` is the
 * reference caller): `'indexeddb'` storage (survives a reload) and
 * `'ws-client'` transport (a real relay connection), plus the identity
 * adapters every environment gets (`'memory'`/`'local-storage'`/
 * `'session-storage'`).
 *
 * Deliberately its own file, importing ONLY the browser-safe subpaths
 * (`@qu/space-storage/indexeddb-store`, `@qu/space-transport/ws-client-
 * transport`) - never either package's main barrel, which also pulls in
 * Node-only code (`node:fs`, the `ws` package) that a browser bundler
 * cannot resolve (see `shell.js`'s own doc comment, and each of those
 * subpath files' own, for the full "why"). A caller that imports THIS
 * file and nothing else from `@qu/bootstrap`'s adapter packs never drags
 * in Node-only code, the same guarantee `shell.js` already had before this
 * package existed - just declared once, here, instead of re-derived at
 * every call site that wires a browser Space.
 *
 * ONLY `storage`/`transport`, deliberately NOT `identity` - `./memory.js`
 * and this file would otherwise both try to register the exact same
 * `'identity'` adapter names the moment a deployment composes both (e.g.
 * "browser storage/transport, but an ephemeral in-memory identity for a
 * throwaway room instance"), which `AdapterRegistry.register()` rejects as
 * a duplicate. Call `registerIdentityStoreAdapters()` (`../identity-
 * stores.js`) once, separately, regardless of which of THIS slot's packs
 * you also compose - see docs/bootstrap-adapter-registry.md.
 */
import { createIndexedDbStore, isIndexedDbAvailable } from '@qu/space-storage/indexeddb-store';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';

/** @param {import('../adapter-registry.js').AdapterRegistry} registry */
export function registerBrowserAdapters(registry) {
  registry.register('storage', 'indexeddb', () => {
    if (!isIndexedDbAvailable()) throw new Error("storage adapter 'indexeddb': no indexedDB on this runtime (privacy mode, or no browser)");
    return createIndexedDbStore();
  });
  registry.register('transport', 'ws-client', ({ url, ...options } = {}) => {
    if (!url) throw new Error("transport adapter 'ws-client' needs a { url }");
    return new WsClientTransport(url, options);
  });
}
