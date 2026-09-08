/**
 * EXTENSION POINTS — the plugin/composability primitive ported from Qu V3's
 * `@qu/foundation` (`actions[]` pure-data slots + `contributes[]`/
 * `ExtensionPointHost` live-code slots), adapted to V5: V3 needed dynamic
 * `import()` of a contributor's OWN bundle because its apps are separately
 * served files; V5's apps already live in-process together (bundles are
 * plain ES modules imported by whichever package wires them, exactly like
 * `admin-sections.js`'s own `registerAdminSection()` did before this file
 * existed), so a contribution is a plain, synchronous, module-load-time
 * registration - no loader, no integrity pinning, no per-point manifest
 * parsing. The REGISTRY shape (ordered, id-addressable, fault-isolated) is
 * what actually mattered from V3's design; this file keeps exactly that and
 * drops everything that was only there to cross a network/bundle boundary.
 *
 * ONE REGISTRY, THREE READ SHAPES - deliberately unified rather than kept
 * as V3's two separate mechanisms (`actions.js` vs `extension-points.js`):
 * a contribution is `{point, id, appId?, order?, handler?, ...data}`.
 * `handler` is OPTIONAL - a contribution with none is a pure DATA entry
 * (label/icon/hrefTemplate, `resolveActionHref()` below is the convenience
 * for that shape); a contribution WITH one can be read through:
 *   - `renderSlot(point, container, payload)` - every contributor with a
 *     handler mounts its OWN DOM into its OWN freshly-appended child
 *     container (never the shared `container` itself), so one
 *     contributor's markup can never clobber another's.
 *   - `collect(point, payload)` - gathers every handler's return value into
 *     one flat, order-preserving array (`undefined` contributes nothing, an
 *     array return is spread) - for points where the caller wants ANSWERS
 *     back (e.g. "which extra actions does a page/entity offer"), not
 *     rendered DOM.
 *   - `renderFrom(point, appId, container, payload)` - calls exactly the
 *     ONE contributor registered under `appId` - for points where only the
 *     producing app knows how to render its own result (e.g. a search hit).
 * `listContributions(point)` reads the raw, sorted entries directly - the
 * right call for a DATA-only point (admin sections, `actions[]`-style menu
 * entries) that no caller ever wants "rendered" or "collected", just listed.
 *
 * FAULT ISOLATION, same posture as `@qu/events`' `EventBus`: a throwing
 * handler is caught and logged, never aborts the other contributors or the
 * caller - one broken plugin must never take down the page/menu/list it
 * contributed into.
 *
 * ORDERING: `order` (default 0, lower first), ties break by registration
 * sequence (stable) - the same convention `@qu/events`, `admin-sections.js`
 * and V3's own `extensionOrder` admin override all already use. A later
 * admin-configurable override (V3's `extension-order.js`) is real, separate
 * work this registry leaves room for (re-`contribute()` the same `id` with
 * a new `order` - already idempotent, see `contribute()` below) but does
 * not itself build.
 */
export class ExtensionPointHost {
  /** @type {Map<string, Array<{key: string, point: string, id: string, appId?: string, order: number, seq: number, handler?: Function, [extra: string]: *}>>} */
  #points = new Map();
  #seq = 0;

  /**
   * Registers (or, called again with the SAME `point`+`id`/`appId`,
   * RE-registers - idempotent, last write wins, exactly like
   * `admin-sections.js`'s own `Map.set()` did) one contribution.
   * @param {string} point - The extension point's name, e.g. `"cms.pageActions"`.
   * @param {{id: string, appId?: string, order?: number, handler?: Function, [extra: string]: *}} contribution -
   *   `id` must be unique for this `point` (scoped to `appId` when given, so
   *   two different apps may each contribute their own `id: "edit"` to the
   *   same point without colliding). `handler`, if present, must be a
   *   function - required only by `renderSlot()`/`collect()`/`renderFrom()`,
   *   never by `listContributions()`. Any other field (`label`, `icon`,
   *   `hrefTemplate`, ...) is carried through verbatim.
   * @returns {() => void} Unregisters this exact contribution.
   */
  contribute(point, { id, appId, order = 0, handler, ...extra } = {}) {
    if (!point) throw new Error('ExtensionPointHost.contribute: "point" is required');
    if (!id) throw new Error('ExtensionPointHost.contribute: "id" is required');
    if (handler !== undefined && typeof handler !== 'function') {
      throw new Error(`ExtensionPointHost.contribute: "handler" must be a function when provided (point "${point}", id "${id}")`);
    }
    const key = appId ? `${appId}:${id}` : id;
    const list = this.#points.get(point) ?? [];
    const existingIdx = list.findIndex((c) => c.key === key);
    // Re-contributing the SAME key reuses its original `seq` (never bumps to the back of the queue
    // for same-`order` ties) - matching `admin-sections.js`'s pre-existing `Map.set()` semantics,
    // where updating an already-present key never moves it in iteration order.
    const seq = existingIdx !== -1 ? list[existingIdx].seq : this.#seq++;
    const entry = { key, point, id, appId, order, seq, handler, ...extra };
    if (existingIdx !== -1) list[existingIdx] = entry;
    else list.push(entry);
    this.#points.set(point, list);
    return () => this.uncontribute(point, key);
  }

  /** Removes one contribution. `key` is either the plain `id` (no `appId` given at `contribute()` time) or `"<appId>:<id>"`. A no-op for an unknown point/key - never throws, matching every other "correct no-op" framework wiring in Qu. */
  uncontribute(point, key) {
    const list = this.#points.get(point);
    if (!list) return;
    const idx = list.findIndex((c) => c.key === key);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Every registered contribution for `point`, sorted by (`order`, registration sequence). Never mutates the internal list - callers may freely iterate/copy the result. @returns {Array<object>} */
  listContributions(point) {
    return [...(this.#points.get(point) ?? [])].sort((a, b) => a.order - b.order || a.seq - b.seq);
  }

  /**
   * Mounts every contributor with a `handler` into its OWN child element,
   * appended to `container` in order. Returns the created child elements
   * (render order) so a caller doing route-based teardown can remove them
   * without having to remember which were whose.
   * @param {string} point @param {Element} container @param {*} [payload]
   * @returns {Promise<Element[]>}
   */
  async renderSlot(point, container, payload) {
    const created = [];
    for (const { handler, key } of this.listContributions(point)) {
      if (typeof handler !== 'function') continue; // a data-only contribution at a point also read via renderSlot() - silently not rendered, not an error.
      const doc = container.ownerDocument ?? globalThis.document;
      const child = doc.createElement('div');
      child.dataset.quExtension = key;
      container.appendChild(child);
      created.push(child);
      try {
        await handler(child, payload);
      } catch (err) {
        console.error(`[ExtensionPointHost] renderSlot handler for "${point}" (${key}) threw:`, err);
      }
    }
    return created;
  }

  /**
   * Gathers every handler's return value into one flat array, in order.
   * `undefined` contributes nothing; an array return is spread, not nested
   * (so a single contributor may itself offer several items, e.g. several
   * context-menu entries from one plugin).
   * @param {string} point @param {*} [payload]
   * @returns {Promise<Array<*>>}
   */
  async collect(point, payload) {
    const out = [];
    for (const { handler, key } of this.listContributions(point)) {
      if (typeof handler !== 'function') continue;
      try {
        const result = await handler(payload);
        if (result !== undefined) for (const item of [].concat(result)) out.push(item);
      } catch (err) {
        console.error(`[ExtensionPointHost] collect handler for "${point}" (${key}) threw:`, err);
      }
    }
    return out;
  }

  /**
   * Calls exactly the one contributor registered under `appId` for `point`.
   * Returns `undefined` (never throws) when no such contributor exists -
   * the same "correct no-op" contract `renderSlot()`/`collect()` already
   * have for an empty/no-handler point.
   * @param {string} point @param {string} appId @param {Element} container @param {*} [payload]
   */
  async renderFrom(point, appId, container, payload) {
    const entry = this.listContributions(point).find((c) => c.appId === appId && typeof c.handler === 'function');
    if (!entry) return undefined;
    try {
      return await entry.handler(container, payload);
    } catch (err) {
      console.error(`[ExtensionPointHost] renderFrom handler for "${point}" (${entry.key}) threw:`, err);
      return undefined;
    }
  }

  /** Test-only escape hatch, same reasoning as `admin-sections.js`'s own `_clearAdminSectionsForTest()`: a fresh `node --test` process registers module-load-time contributions exactly once, but a test registering its OWN throwaway contribution needs to undo that without leaking into later tests in the same process. Clears every point. */
  _clearForTest() {
    this.#points.clear();
  }

  /** Same as `_clearForTest()`, scoped to one `point` - for a shared, process-wide host (e.g. `@qu/app-shell`'s own instance) where clearing every OTHER point's real, module-load-time contributions would be wrong. */
  _clearPointForTest(point) {
    this.#points.delete(point);
  }
}

/**
 * Fills a `{...}`-style href template with `params` (each occurrence
 * URI-component-encoded) - the convenience `actions[]`-shaped, data-only
 * contributions (no `handler`) exist for, e.g.
 * `resolveActionHref({hrefTemplate: "#/chat/{pub}"}, {pub: "abc"})` ->
 * `"#/chat/abc"`. A named param missing from `params` resolves to `""`,
 * never throws or leaves the literal `{name}` in the result - the same
 * "correct no-op over hard failure" posture used throughout this package.
 * @param {{hrefTemplate?: string}} contribution @param {Record<string, string>} [params]
 * @returns {string}
 */
export function resolveActionHref(contribution, params = {}) {
  return (contribution?.hrefTemplate ?? '').replace(/\{(\w+)\}/g, (_, name) => (params[name] !== undefined ? encodeURIComponent(params[name]) : ''));
}
