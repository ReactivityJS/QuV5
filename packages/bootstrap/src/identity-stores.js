/**
 * IDENTITY STORES — the generic "where does THIS peer's own local identity
 * keypair live" primitive, promoted from `@qu/app-shell`'s own `identity.js`
 * (which re-exports `loadOrCreateIdentity`/`IDENTITY_STORAGE_KEY` from here
 * now, unchanged for every existing caller) into framework-core: deciding
 * WHERE a local identity persists is exactly the kind of bootstrap-time,
 * adapter-shaped choice this package exists for (docs/
 * bootstrap-adapter-registry.md), not something specific to a browser App
 * Shell - a Node-hosted relay, a CLI, or a future non-App-Shell client all
 * want the same "create once, reload on every later call" behavior.
 *
 * THREE REGISTERED FLAVORS, one real axis: how long the identity survives.
 *   - `'local-storage'` - survives a reload AND a browser restart (same
 *     origin). The "primary local identity" the user's own framing asks
 *     for - one identity per browser/profile, reused across every app this
 *     origin serves (see `@qu/app-shell`'s `identity.js` own doc comment on
 *     why that's deliberate).
 *   - `'session-storage'` - survives a reload, gone once the tab closes.
 *   - `'memory'` - survives only as long as THIS PROCESS's own module state
 *     does (a plain in-memory `Map`, keyed by `key`): multiple
 *     `bootstrapSpace()` calls in the SAME process with the SAME `key`
 *     reuse the same generated identity, but nothing survives a restart.
 *     The right default for a genuinely TEMPORARY identity - GunDB-style
 *     "fake user"/room-instance, a test, a demo peer - see this package's
 *     own architecture doc for why this is deliberately NOT the same thing
 *     as "no persistence at all, a fresh keypair every call": a caller that
 *     wants THAT can simply never register/use an identity adapter and
 *     generate+pass a keypair directly (`bootstrapSpace()`'s `identity`
 *     param accepts an already-built identity object just as well as an
 *     `{adapter, ...}` reference - see that file's own doc comment).
 *
 * All three ultimately call the SAME `loadOrCreateIdentity(storage, key)` -
 * the only thing that differs is what `storage` (a plain `{getItem,
 * setItem}` duck type) they hand it. A deployment that wants a FOURTH
 * flavor (e.g. a filesystem-backed identity for a CLI) just registers its
 * own `storage`-shaped adapter against the `'identity'` slot directly - no
 * change needed here.
 */
import { QuCrypto } from '@qu/core';

/**
 * One in-flight promise per `key` (not per call): `storage.getItem()` is
 * synchronous, but generating a FRESH keypair genuinely isn't (Web Crypto) -
 * two callers racing for the same never-yet-created `key` would otherwise
 * both see "nothing stored yet," both generate a DIFFERENT keypair, and
 * both write - the second write silently winning, leaving the first
 * caller's (now-orphaned) keypair permanently out of sync with what's
 * actually in storage. Module-level (shared across every `storage`/`key`
 * pair) since the race is about `key`, not about which `storage` backend
 * happens to be asked for it.
 */
const inFlight = new Map();

/**
 * @param {{getItem: (key: string) => string|null, setItem: (key: string, value: string) => void}} storage - e.g. `localStorage`/`sessionStorage`, or a plain in-memory `Map`-backed stand-in.
 * @param {string} key
 * @returns {Promise<{signingKey: Uint8Array, signingPub: Uint8Array, xPrivateKey: Uint8Array, xPublicKey: Uint8Array}>}
 */
export function loadOrCreateIdentity(storage, key) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = loadOrCreateIdentityOnce(storage, key).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function loadOrCreateIdentityOnce(storage, key) {
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

/** A plain `{getItem, setItem}` backend over an in-process `Map` - `'memory'`'s own backing store, one shared instance for every key (the key itself already namespaces entries). */
function createMemoryBackend() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  };
}
const memoryBackend = createMemoryBackend();

/**
 * Registers the `'identity'` slot's three built-in, zero-extra-dependency
 * adapters - see this file's own top doc comment for what each one means.
 * @param {import('./adapter-registry.js').AdapterRegistry} registry
 * @param {{defaultKey?: string}} [options] - `defaultKey` - fallback storage key when a caller's `bootstrapSpace()` config omits its own `key` (default `'qu-identity'`, the same fixed key `@qu/app-shell`'s `shell.js` already uses).
 */
export function registerIdentityStoreAdapters(registry, { defaultKey = 'qu-identity' } = {}) {
  registry.register('identity', 'memory', ({ key = defaultKey } = {}) => loadOrCreateIdentity(memoryBackend, key));
  registry.register('identity', 'local-storage', ({ key = defaultKey } = {}) => {
    if (typeof localStorage === 'undefined') throw new Error("identity adapter 'local-storage': no global localStorage on this runtime");
    return loadOrCreateIdentity(localStorage, key);
  });
  registry.register('identity', 'session-storage', ({ key = defaultKey } = {}) => {
    if (typeof sessionStorage === 'undefined') throw new Error("identity adapter 'session-storage': no global sessionStorage on this runtime");
    return loadOrCreateIdentity(sessionStorage, key);
  });
}
