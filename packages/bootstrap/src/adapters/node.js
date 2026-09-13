/**
 * NODE ADAPTER PACK — the server/CLI-side counterpart to `./browser.js`:
 * `'file'` storage (real on-disk persistence, the relay/Docker deployment's
 * own tier) and `'durable'` storage (in-process, test-only simulation of a
 * real backend - see `space-storage`'s own `durable-store.js` doc comment),
 * plus a Node-capable `'ws-client'` transport (the same adapter NAME as
 * `./browser.js`'s, so a config written once doesn't care whether it ends
 * up resolved by this pack or that one - only ONE of the two packs is ever
 * registered in a given process, never both, so there is no name clash in
 * practice) using the `ws` package instead of a native browser global.
 *
 * Safe to import from plain Node (no DOM/browser global assumed) - the
 * mirror-image of `./browser.js`'s own "browser-safe subpaths only" rule,
 * just the other direction: this file is never meant to be bundled into a
 * browser page at all.
 *
 * ONLY `storage`/`transport`, deliberately NOT `identity` - see
 * `./browser.js`'s own doc comment on why identity registration is its
 * own, separately-called step (`registerIdentityStoreAdapters()`, `../
 * identity-stores.js`), not bundled into any one environment pack.
 */
import { createFileStore, createDurableStore } from '@qu/space-storage';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import WebSocket from 'ws';

/** @param {import('../adapter-registry.js').AdapterRegistry} registry */
export function registerNodeAdapters(registry) {
  registry.register('storage', 'file', ({ dataDir } = {}) => {
    if (!dataDir) throw new Error("storage adapter 'file' needs a { dataDir }");
    return createFileStore(dataDir);
  });
  registry.register('storage', 'durable', ({ backingStore } = {}) => createDurableStore(backingStore));
  registry.register('transport', 'ws-client', ({ url, ...options } = {}) => {
    if (!url) throw new Error("transport adapter 'ws-client' needs a { url }");
    return new WsClientTransport(url, { WebSocketImpl: WebSocket, ...options });
  });
}
