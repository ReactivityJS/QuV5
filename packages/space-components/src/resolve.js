/**
 * RESOLVE — turns a Component's own attributes/properties plus DOM
 * ancestry (context.js) into a real `{space, kindSchema, nodeId}` Node
 * reference, then (`resolveField()`) into an actual subscribed `Field`
 * handle - the one piece of logic `qu-view.js`/`qu-bind.js`/`qu-list.js`
 * all share.
 */
import { findQuSpace, findQuKind, findQuSelf } from './context.js';

/**
 * THREE ways to supply the Kind-Schema + Node id together, deliberately -
 * Custom Element attributes are always strings (confirmed true here the
 * same way QuV3's own `components.js` doc comment says it is), so a
 * Kind-Schema OBJECT can never be an attribute value:
 *   - `el.kindSchema` + `el.nodeId` (JS properties) - set directly by
 *     whatever code already has the real Kind-Schema object/id in scope
 *     (framework code rendering a template, or an app's own bootstrapping
 *     script). Always works, needs no registry.
 *   - `kind="name"` + `node-id="..."` (plain string attributes) - for
 *     markup a CMS author typed with no JS access at all. `kind` resolves
 *     via `findQuKind(el, name)` against the nearest ancestor's `.quKinds`
 *     registry - an app that wants ITS OWN Kinds bindable this way sets
 *     `.quKinds = {name: kindSchema}` on `<qu-app-shell>` (or any wrapping
 *     element) itself; `@qu/space-components` ships no built-in registry of
 *     its own (it has no idea what Kinds any given app defines - see
 *     `@qu/app-core`'s `kinds.js`, `defineCollectionKind()`). `node-id`
 *     itself is expected to be a literal, human-typeable id - fine for a
 *     shared/self-certifying Node whose id is a well-known constant, but
 *     NOT for a content-addressed one (`deriveContentNodeId()`'s output is
 *     a hash, nobody types that by hand) - see `self` right below for that
 *     case specifically.
 *   - `self` (a plain boolean attribute, empty or `"true"`) - resolves
 *     BOTH `kindSchema` and `nodeId` together, via `findQuSelf(el)`
 *     (`context.js`'s own doc comment) against whichever page is currently
 *     rendered in `el`'s own ancestry (`@qu/app-shell`'s `boot.js` sets
 *     this on every render). The one case `kind`/`node-id` genuinely can't
 *     cover: "bind to a field on THIS SAME page," the overwhelmingly
 *     common case for a hand-authored Template, and the reason
 *     Qu-Components in Template HTML had no practical story before this
 *     existed. Takes priority over `kind`/`node-id` if somehow both are
 *     present (a self-contradictory case, no reason to prefer the other
 *     two over the more specific `self`).
 *
 * @param {Element} el
 * @returns {{space: object, kindSchema: object, nodeId: string}|null} `null` if anything required isn't resolvable yet (not necessarily an error - see resolveField()'s own retry).
 */
export function resolveNodeRef(el) {
  const space = findQuSpace(el);
  if (!space) return null;
  if (el.hasAttribute('self')) {
    const self = findQuSelf(el);
    if (!self || !self.kindSchema || !self.nodeId) return null;
    return { space, kindSchema: self.kindSchema, nodeId: self.nodeId };
  }
  const kindName = el.getAttribute('kind');
  const kindSchema = el.kindSchema ?? (kindName ? findQuKind(el, kindName) : null);
  const nodeId = el.nodeId ?? el.getAttribute('node-id');
  if (!kindSchema || !nodeId) return null;
  return { space, kindSchema, nodeId };
}

/**
 * Shared by qu-view.js/qu-bind.js/qu-list.js: resolves `el`'s Node
 * reference, retrying ONCE on the next microtask if it isn't available yet
 * (an ancestor may set `.quSpace`/`.quKinds`/`.nodeId` in the same
 * synchronous block AFTER appending this element - `appendChild()` runs
 * `connectedCallback()` synchronously, the exact ordering hazard QuV3's
 * own `findQu()` doc comment describes), then subscribes
 * (`space.useNode()`) and returns the requested field handle.
 *
 * @param {Element} el
 * @param {number} generation - `el`'s own connect/disconnect counter.
 * @param {() => number} getGeneration - reads `el`'s CURRENT generation
 *   fresh; if it no longer matches `generation` by the time an `await`
 *   below resolves, `el` was disconnected (or reconnected) while this was
 *   in flight - any Node already acquired is released immediately and
 *   `null` is returned instead of being handed to a caller that has
 *   already moved on.
 * @returns {Promise<{field: object, release: () => void}|null>}
 */
export async function resolveField(el, generation, getGeneration) {
  let ref = resolveNodeRef(el);
  if (!ref) {
    await Promise.resolve();
    if (getGeneration() !== generation) return null;
    ref = resolveNodeRef(el);
    if (!ref) return null;
  }
  const fieldName = el.getAttribute('field');
  if (!fieldName) return null;
  const { space, kindSchema, nodeId } = ref;
  const { node, release } = await space.useNode(nodeId, kindSchema);
  if (getGeneration() !== generation) {
    release();
    return null;
  }
  return { field: node.field(fieldName), release };
}
