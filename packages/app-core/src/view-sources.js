/**
 * VIEW SOURCE ADAPTERS — `kinds.js`'s own `viewKind` doc comment: a View's
 * `sources` field never names a Kind-Schema object directly (a View is
 * PLAIN Space data, an app-agnostic recipe - it can't import an app's own
 * `defineCollectionKind()` result to serialize into a field), only a
 * `type` STRING plus caller-defined params. This file is the ONE place
 * that maps such a `type` to the actual `@qu/space-core` calls needed to
 * (a) read the source's CURRENT items and (b) be notified when they
 * change - i.e. exactly the two capabilities `openLiveView()` (this file)
 * needs from every source, regardless of what Kind backs it.
 *
 * EVERY ADAPTER NORMALIZES TO THE SAME SHAPE - `{title, excerpt, route,
 * timestamp, raw}` (`raw` = the source's own unmodified item, for a
 * caller that needs more than the four common fields) - so a View can
 * MIX sources of completely different Kinds into one merged, sorted feed
 * (the user's own "user-feed combines Blog + Gästebuch" example): a Page
 * has no `excerpt`, a guestbook entry has no `route` - both still produce
 * every key, `null`/`''` where a source has nothing to offer, so a caller
 * (or an `itemTemplate`'s `<qu-slot>`) never has to know which source
 * type produced a given item just to read a common field off it.
 *
 * ONLY TWO ADAPTERS FOR NOW - `'pages'` (any `qu-route-registry` entry,
 * optionally filtered to routes starting with a given `prefix` - "a blog
 * is just pages under `/blog/`," this file's own top doc comment) and
 * `'shared-list'` (any `sharedListKind` list, kinds.js's own doc comment -
 * a guestbook). A `'collection'` adapter (`defineCollectionKind()`'s own
 * items) is real, natural future work, deliberately NOT built here yet:
 * unlike the two above, a Collection's `itemKind`/`registryKind` are
 * actual Kind-Schema OBJECTS a View's own plain-data `sources` field
 * cannot reference by name alone - it would need a caller-supplied
 * `{itemKind, registryKind}` LOOKUP TABLE keyed by some string the View
 * config names, a real but separate piece of plumbing, not a blocker for
 * the two sources already asked for.
 *
 * EACH ADAPTER'S `open()` returns `{read, observe, release}`:
 *   - `read()` - `async () => Array<NormalizedItem>` - the source's
 *     CURRENT items, right now.
 *   - `observe(callback)` - registers `callback` to fire whenever this
 *     source's underlying list changes; returns an unobserve function.
 *   - `release()` - the matching `Space.useNode()` release, called once
 *     this source is no longer needed (a View closing, or a caller
 *     switching to a different View entirely).
 * `openLiveView()` opens every configured source THIS way, keeps them all
 * open for the View's own lifetime (unlike every OTHER resolver in this
 * package, which is one-shot: `useNode()`+read+`release()` immediately -
 * a live View is deliberately NOT that, since "stay open and notify on
 * change" is the entire point), and recomputes the merged/sorted/limited
 * result whenever ANY ONE of them fires.
 */
import { deriveOwnerNodeId } from '@qu/space-core';
import { routeRegistryKind, sharedListKind, sharedListAnchor } from './kinds.js';

function normalize({ title = '', excerpt = '', route = null, timestamp = null, raw = null }) {
  return { title, excerpt, route, timestamp, raw };
}

export const VIEW_SOURCE_ADAPTERS = {
  /** @param {{prefix?: string}} params - `prefix` (optional) keeps only routes starting with it, e.g. `'/blog/'` - "a blog is just pages under one route prefix" (this file's own top doc comment). Omit for every published route. */
  pages: {
    async open(space, { appAdminPub, kinds }, params) {
      const registryKind = kinds?.routeRegistryKind ?? routeRegistryKind;
      const id = await deriveOwnerNodeId(appAdminPub, registryKind.kind);
      const { node, release } = await space.useNode(id, registryKind);
      const field = node.field('routes');
      const read = async () =>
        (await field.toArray())
          .filter(Boolean)
          .filter((r) => !params?.prefix || r.route.startsWith(params.prefix))
          .map((r) => normalize({ title: r.title, route: r.route, raw: r }));
      return { id, read, observe: (cb) => field.observe(cb), release };
    },
  },
  /** @param {{name: string}} params - which named shared list (`dev.js`'s `pushToSharedList()`) - required, no default: unlike `'pages'`, there is no single "every shared list" enumeration to fall back to. */
  'shared-list': {
    async open(space, _ctx, params) {
      const anchor = await sharedListAnchor(params.name);
      const id = await deriveOwnerNodeId(anchor, sharedListKind.kind);
      const { node, release } = await space.useNode(id, sharedListKind);
      const field = node.field('entries');
      const read = async () =>
        (await field.toArray())
          .filter(Boolean)
          .map((e) => normalize({ title: e.name ?? '', excerpt: e.message ?? '', timestamp: e.ts ?? null, raw: e }));
      return { id, read, observe: (cb) => field.observe(cb), release };
    },
  },
};

/** Polls until `space.isNodeSynced(id)` (a subscribed relay has confirmed everything it currently has for `id` was delivered) or `timeout` elapses - see `Space.isNodeSynced()`'s own doc comment. `openLiveView()`'s own reason for needing this at all: `Space.useNode()` only awaits SENDING its subscribe request, never the relay's reply - reading a source's `read()` immediately after `open()` would otherwise race that reply and see an empty/stale snapshot on the FIRST recompute, indistinguishable from "this source is genuinely empty." */
async function waitUntilSynced(space, id, timeout) {
  const deadline = Date.now() + timeout;
  while (!space.isNodeSynced(id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function compareBy(sortBy, sortOrder) {
  if (!sortBy) return null;
  const dir = sortOrder === 'asc' ? 1 : -1;
  return (a, b) => {
    const av = a[sortBy] ?? '';
    const bv = b[sortBy] ?? '';
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  };
}

/**
 * Opens a LIVE, merged, sorted, limited view over one or more sources -
 * this file's own top doc comment explains the shape/rationale in full.
 * LIVE means every SOURCE (`config.sources`) is watched - it does NOT
 * mean the View's own definition Node is watched too: `config` is read
 * ONCE, by the caller, before calling this (`resolver.resolveView()`) -
 * editing a View's `sources`/`sortBy`/`itemTemplate` afterward only takes
 * effect the NEXT time something calls `resolveView()`+`openLiveView()`
 * again (e.g. `@qu/app-shell`'s `wireViews()` re-wiring on a fresh page
 * render), same as any other Space content: an already-rendered page
 * never "hot-reloads" a Template/Style edit either. Watching the View's
 * OWN config live too is real, separate future work, not attempted here.
 * The returned object is deliberately `{toArray, observe}` - the EXACT
 * interface `@qu/space-core`'s own `ListField` already exposes, and the
 * ONLY interface `@qu/space-ui`'s `bindList()` needs from whatever it
 * binds to - so a caller (`@qu/app-shell`'s `view-actions.js`) can hand
 * this straight to `bindList()` with ZERO adapter code of its own, exactly
 * as if it were a single ordinary list Field.
 * @param {import('@qu/space-core').Space} space
 * @param {{appAdminPub: Uint8Array, kinds?: object, sources: Array<{type: string, [k: string]: *}>, sortBy?: string|null, sortOrder?: 'asc'|'desc', limit?: number|null, syncTimeout?: number}} config - `config` is a resolved View's own field values (`resolveView()`'s return shape), NOT the View's Node id - callers read the View first, then open it. `syncTimeout` (default 3000ms) bounds how long the FIRST `recompute()` waits for every source's initial relay sync before running with whatever arrived - see `waitUntilSynced()`'s own doc comment.
 * @returns {Promise<{toArray: () => Promise<Array<object>>, observe: (cb: () => void) => (() => void), close: () => void}>}
 */
export async function openLiveView(space, { appAdminPub, kinds, sources, sortBy = null, sortOrder = 'desc', limit = null, syncTimeout = 3000 }) {
  const opened = await Promise.all(
    sources.map((source) => {
      const adapter = VIEW_SOURCE_ADAPTERS[source.type];
      if (!adapter) throw new Error(`openLiveView: unknown source type "${source.type}" - known types: ${Object.keys(VIEW_SOURCE_ADAPTERS).join(', ')}`);
      return adapter.open(space, { appAdminPub, kinds }, source);
    })
  );
  // See `waitUntilSynced()`'s own doc comment - without this, a caller opening a View for the
  // FIRST time on a fresh connection would race every source's own initial relay reply, seeing an
  // empty feed indistinguishable from "genuinely nothing published yet."
  await Promise.all(opened.map((o) => waitUntilSynced(space, o.id, syncTimeout)));

  let current = [];
  const listeners = new Set();
  const compare = compareBy(sortBy, sortOrder);

  async function recompute() {
    const all = (await Promise.all(opened.map((o) => o.read()))).flat();
    if (compare) all.sort(compare);
    current = limit != null ? all.slice(0, limit) : all;
    for (const cb of listeners) cb();
  }

  const unobserves = opened.map((o) => o.observe(() => recompute()));
  await recompute();
  let closed = false;

  return {
    toArray: async () => current,
    observe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    // Idempotent - safe to call more than once (a caller's OWN try/finally reaching for close()
    // again after an earlier code path already called it is an easy, realistic mistake, not
    // something worth a confusing "tried to remove event handler that doesn't exist" Yjs warning
    // over on the second call).
    close() {
      if (closed) return;
      closed = true;
      for (const unobserve of unobserves) unobserve();
      for (const o of opened) o.release();
      listeners.clear();
    },
  };
}
