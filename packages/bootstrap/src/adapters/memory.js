/**
 * MEMORY ADAPTER PACK — the universal, zero-network, zero-disk adapter set:
 * safe to register in ANY environment (browser, Node, a test) since nothing
 * here touches `localStorage`/`indexedDB`/`node:fs`/a real socket. The
 * right pack for tests, demos, and any genuinely ephemeral/temporary peer
 * (see `identity-stores.js`'s own doc comment on the `'memory'` identity
 * adapter - a GunDB-style "fake user"/room-instance is exactly this pack's
 * `'memory'` identity + `'in-process'` transport combination).
 *
 * `'in-process'` transport needs a shared `hub` (one per simulated
 * "relay" - every peer that should be able to reach each other connects to
 * the SAME hub instance) - `createSharedInProcessHub()` is re-exported here
 * so a caller doesn't also need to import `@qu/space-transport` directly
 * just to set one up.
 *
 * ONLY `storage`/`volatileStorage`/`transport`, deliberately NOT
 * `identity` - see `./browser.js`'s own doc comment on why identity
 * registration is its own, separately-called step
 * (`registerIdentityStoreAdapters()`, `../identity-stores.js`), not bundled
 * into any one environment pack.
 */
import { createInProcessHub, InProcessTransport } from '@qu/space-transport/in-process-transport';
import { createMemoryStore } from '@qu/space-storage/memory-store';

export { createInProcessHub as createSharedInProcessHub };

/** @param {import('../adapter-registry.js').AdapterRegistry} registry */
export function registerMemoryAdapters(registry) {
  registry.register('storage', 'memory', () => createMemoryStore());
  registry.register('volatileStorage', 'memory', () => createMemoryStore());
  registry.register('transport', 'in-process', ({ hub, peerId = crypto.randomUUID() } = {}) => {
    if (!hub) throw new Error("transport adapter 'in-process' needs a shared { hub } - see createSharedInProcessHub()");
    return new InProcessTransport(hub, peerId);
  });
}
