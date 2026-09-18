/**
 * ADAPTER REGISTRY — the generic half of the Mountpoint/Adapter-Registry
 * work package (docs/quv5-vs-quv3-decision.md, Arbeitspaket 2): a thin,
 * framework-agnostic map from `(slot, name)` to a FACTORY function, so a
 * deployment can pick which concrete adapter implementation backs each
 * "slot" `bootstrapSpace()` (bootstrap-space.js) needs - `'identity'`,
 * `'transport'`, `'storage'`, `'volatileStorage'` today, anything else a
 * future slot wants tomorrow - by NAME, at boot time, rather than a
 * hardcoded `import`.
 *
 * Deliberately empty by default: this file registers nothing itself. A
 * caller builds up exactly the set of adapters it actually wants bundled by
 * calling one or more `register*Adapters(registry)` helpers (see
 * `./adapters/memory.js`/`./adapters/browser.js`/`./adapters/node.js`) -
 * the same "explicit opt-in, no hidden auto-discovery" posture
 * `alias.js`'s `AliasRegistry` already takes for Space itself (this
 * package's own doc comment). This is what keeps a browser bundle from
 * ever pulling in Node-only code (`node:fs`, the `ws` package) just
 * because SOME adapter pack somewhere registers a Node adapter - nothing
 * is registered, and therefore nothing is imported, unless a caller's own
 * code path actually does it.
 *
 * A `(slot, name)` pair is registered at most once - re-registering the
 * same pair is very likely a deployment bug (two adapter packs both
 * claiming `storage:'memory'`, say), not something to silently let the
 * second call win.
 */

export class AdapterRegistry {
  constructor() {
    /** @type {Map<string, (options: object) => *|Promise<*>>} `${slot}:${name}` -> factory. */
    this._factories = new Map();
  }

  /**
   * @param {string} slot - e.g. `'identity'`/`'transport'`/`'storage'`/`'volatileStorage'`.
   * @param {string} name - e.g. `'memory'`/`'indexeddb'`/`'ws-client'`.
   * @param {(options: object) => *|Promise<*>} factory - Called with whatever options `bootstrapSpace()`'s own `{adapter, ...options}` config carried, minus `adapter` itself. May return a Promise.
   * @returns {this} Chainable - `register()` calls from a `register*Adapters()` helper typically run several in a row.
   */
  register(slot, name, factory) {
    const key = `${slot}:${name}`;
    if (this._factories.has(key)) {
      throw new Error(`AdapterRegistry: "${name}" is already registered for slot "${slot}" - two adapter packs are claiming the same name`);
    }
    this._factories.set(key, factory);
    return this;
  }

  /** @param {string} slot @param {string} name @returns {boolean} */
  has(slot, name) {
    return this._factories.has(`${slot}:${name}`);
  }

  /** Every adapter name currently registered for `slot`, for a helpful error message (see `create()`) or an admin UI that wants to list "what's available". @param {string} slot @returns {string[]} */
  names(slot) {
    const prefix = `${slot}:`;
    return [...this._factories.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  /**
   * Resolves `(slot, name)` to a live adapter instance by calling its
   * registered factory with `options`. Throws a descriptive error (naming
   * every OTHER adapter actually registered for this same slot, so a typo
   * is easy to spot) rather than returning `undefined` - an unresolvable
   * adapter is always a configuration mistake worth failing loudly for,
   * never a value a caller could sensibly treat as "none".
   * @param {string} slot
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<*>}
   */
  async create(slot, name, options = {}) {
    const factory = this._factories.get(`${slot}:${name}`);
    if (!factory) {
      const known = this.names(slot);
      const hint = known.length > 0 ? `known adapters for "${slot}": ${known.join(', ')}` : `no adapters registered for slot "${slot}" at all`;
      throw new Error(`AdapterRegistry: no "${name}" adapter registered for slot "${slot}" (${hint})`);
    }
    return await factory(options);
  }
}
