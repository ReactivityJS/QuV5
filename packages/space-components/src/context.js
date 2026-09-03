/**
 * CONTEXT — ancestor-DOM resolution for the declarative Qu Components
 * (qu-view.js/qu-bind.js/qu-list.js), the same pattern the sibling project
 * QuV3's `packages/ui/src/components.js` established (`findQu()`/
 * `findSyncFetch()`): a Component reaches its Space by walking UP the DOM
 * for a plain property set on some ancestor - never a global singleton, so
 * two independently-booted `<qu-app-shell>`s (or a test harness mounting a
 * Component in isolation) never collide.
 *
 * `.quSpace` (a `@qu/space-core` `Space`) and `.quKinds` (`{[name]:
 * kindSchema}`) are DELIBERATELY separate properties, not bundled into one
 * object - the same split QuV3's own doc comment gives for keeping `.qu`/
 * `.syncFetch` apart: `@qu/app-shell`'s `boot.js` owns and sets `.quSpace`
 * (it constructs the `Space`), but has no knowledge of any particular
 * app's own Kind-Schemas - `.quKinds` is instead something an app sets
 * itself. See resolve.js's own doc comment for the two ways a Component
 * ends up with a Kind-Schema either way.
 */

function walkUp(el, test) {
  let node = el;
  while (node) {
    if (test(node)) return node;
    node = node.parentNode || node.host || null;
  }
  return null;
}

/** @param {Element} el @returns {import('@qu/space-core').Space|null} */
export function findQuSpace(el) {
  const found = walkUp(el, (n) => n.quSpace != null);
  return found ? found.quSpace : null;
}

/** @param {Element} el @param {string} name @returns {object|null} The Kind-Schema registered under `name` on the nearest ancestor exposing `.quKinds`, or null. */
export function findQuKind(el, name) {
  const found = walkUp(el, (n) => n.quKinds != null);
  return found ? (found.quKinds[name] ?? null) : null;
}

/**
 * A `<qu-view>`/`<qu-bind>` acts on itself unless it has exactly one child
 * ELEMENT, in which case that child (e.g. a wrapped `<input>`) becomes the
 * bind target instead - same rule QuV3's own `resolveTarget()` uses,
 * letting a template author write `<qu-bind field="alias"><input></qu-bind>`
 * when a real form control is needed, without the Component itself ever
 * needing to know about form controls.
 * @param {Element} el
 */
export function resolveTarget(el) {
  return el.children.length === 1 ? el.children[0] : el;
}

const FORBIDDEN_ATTR_MODES = new Set(['innerHTML', 'outerHTML']);

/**
 * Shared by qu-view.js/qu-bind.js: a live-bound field's value is Space
 * data, not template markup that has already been through
 * `sanitizeHtml()` (see @qu/app-renderer's sanitizer.js) - rendering it as
 * markup via `attr="innerHTML"` would reopen exactly the injection risk
 * that pipeline exists to close, for BOTH read-only and two-way binding
 * alike. A caller that genuinely needs rich HTML from Space data renders
 * it template-side via `pageKind.data` instead (already sanitized in
 * `render.js`).
 * @param {string} attrMode @throws {Error} if `attrMode` is forbidden.
 */
export function assertSafeAttrMode(attrMode) {
  if (FORBIDDEN_ATTR_MODES.has(attrMode)) {
    throw new Error(`attr="${attrMode}" is not supported - live Space data is never rendered as markup here, see context.js's own doc comment`);
  }
}

/**
 * Reads a (possibly dot-separated) property path off a plain object - used
 * for `<qu-list>`'s `key`/item-scoped `<qu-view field="...">` lookups,
 * which read straight off an already-resolved item VALUE, not a Space
 * Node.
 * @param {*} obj @param {string} path
 */
export function getPath(obj, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), obj);
}
