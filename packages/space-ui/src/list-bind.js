/**
 * LIST BIND — reconciles a real DOM container's children against an
 * `@qu/space-core` list `Field`'s (`shape: 'list'`, see field.js's
 * `ListField`) current array on every change, doing the MINIMAL DOM
 * mutation needed rather than clearing and re-rendering the whole list on
 * every remote/local write - "atomic updates/diffs" for a list, in the
 * sense that a concurrent push from another peer (Yjs' own CRDT ordering
 * already resolved WHERE it lands in the array - see kind-schema.js) only
 * ever inserts ONE new element here, it never re-renders siblings that
 * didn't change.
 *
 * KEYED, not index-based: `key(item, index)` must return a STABLE string
 * identifying an item across re-renders (e.g. the item's own `id` field) -
 * a `ListField` has no per-index update, only `push()` (see that class's
 * own doc comment), so this is the DOM-side answer to "an item's position
 * can shift as concurrent pushes interleave, but its identity shouldn't."
 * An item whose key persists across a reconcile is patched in place via
 * `update(el, item, index)` if given, or otherwise compared by VALUE
 * (`JSON.stringify` - cheap enough for typical list items, and necessary
 * since `ListField.toArray()` decrypts/deserializes a brand-new plain
 * object on every call, so two calls are never `===` even when nothing
 * actually changed) - only a genuinely different value gets re-rendered.
 * Either way, only `insertBefore`, never a fresh `render()`, handles a
 * pure position change - a reordered item MOVES its existing element,
 * never torn down and rebuilt just because its index shifted.
 */

/**
 * @param {Element} container
 * @param {{toArray(): Promise<*[]>, observe(cb: () => void): () => void}} field
 * @param {{key: (item: *, index: number) => string, render: (item: *, index: number) => Element, update?: ((el: Element, item: *, index: number) => void) | null}} options
 * @returns {() => void} Stops the binding (unobserves the field; does NOT remove already-rendered DOM - a caller tearing down the whole container clears it themselves).
 */
export function bindList(container, field, { key, render, update = null }) {
  /** @type {Map<string, Element>} */
  const elByKey = new Map();
  /** @type {Map<string, string>} key -> last-rendered item's JSON snapshot - see this file's own doc comment on why value comparison, not reference comparison, is what actually skips redundant renders here. */
  const snapshotByKey = new Map();

  async function reconcile() {
    const items = await field.toArray();
    const seen = new Set();
    let previousEl = null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue; // ciphertext this identity can't decrypt (see ListField.toArray()'s own doc comment) - nothing to render.
      const k = key(item, i);
      seen.add(k);
      const snapshot = JSON.stringify(item);

      let el = elByKey.get(k);
      if (!el) {
        el = render(item, i);
        elByKey.set(k, el);
      } else if (update) {
        update(el, item, i);
      } else if (snapshot !== snapshotByKey.get(k)) {
        const replacement = render(item, i);
        el.replaceWith(replacement);
        elByKey.set(k, replacement);
        el = replacement;
      }
      snapshotByKey.set(k, snapshot);

      const expectedNext = previousEl ? previousEl.nextSibling : container.firstChild;
      if (expectedNext !== el) container.insertBefore(el, expectedNext); // a no-op move is skipped implicitly - insertBefore(el, el.nextSibling) would still be cheap, but this avoids even that.
      previousEl = el;
    }

    for (const [k, el] of elByKey) {
      if (!seen.has(k)) {
        el.remove();
        elByKey.delete(k);
        snapshotByKey.delete(k);
      }
    }
  }

  const unobserve = field.observe(reconcile);
  reconcile();
  return () => unobserve();
}
