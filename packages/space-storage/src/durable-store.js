/**
 * DURABLE STORE — the "persistent" tier. For this PoC, backed by a plain
 * in-process object rather than real disk/IndexedDB/leveldb I/O, so the
 * whole demo runs via `node --test` without a browser or a filesystem
 * fixture - but the CONTRACT is what a real backend (an append-only file,
 * `y-leveldb`, a small SQLite table) would also expose: `append()`/`load()`
 * over the exact same sealed envelope shape `@qu/space-transport` sends
 * over the wire. A real backend swaps the object below for actual I/O
 * without any caller-visible change - same "adapter, not a rewrite" shape
 * QuStore's own storage adapters (`packages/runtime/src/*-adapter.js`) use.
 *
 * Passing an existing `backingStore` object lets a test "restart" a Space
 * (construct a fresh Space/Node against the SAME backing store) to prove
 * reload-from-storage without actually killing the process - see
 * space-core's test/poc-demo.test.js.
 */
export function createDurableStore(backingStore = new Map()) {
  return {
    async append(nodeId, envelope) {
      const list = backingStore.get(nodeId) ?? [];
      list.push(envelope);
      backingStore.set(nodeId, list);
    },
    async load(nodeId) {
      return [...(backingStore.get(nodeId) ?? [])];
    },
    /** Exposed so a test can assert on the raw, still-sealed rows - proving no plaintext ever reached "disk". */
    _backingStore: backingStore,
  };
}
