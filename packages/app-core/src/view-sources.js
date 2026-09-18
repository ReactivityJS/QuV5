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
 * THREE ADAPTERS - `'pages'` (any `qu-route-registry` entry, optionally
 * filtered to routes starting with a given `prefix` - "a blog is just
 * pages under `/blog/`," this file's own top doc comment), `'shared-list'`
 * (any `sharedListKind` list, kinds.js's own doc comment - a guestbook),
 * and `'collection'` (any `defineCollectionKind()` collection - a blog's
 * posts, a contact list, a forum's threads, "Blog-Posts usw." in the
 * user's own framing - kinds.js's own `defineCollectionKind()` doc
 * comment). Unlike the other two, a Collection's `itemKind`/`registryKind`
 * are actual Kind-Schema OBJECTS a View's own plain-data `sources` field
 * cannot reference by name alone (a View is app-agnostic Space data, it
 * cannot import an app's own module to get them back) - so a `'collection'`
 * source's `params` carries them directly (`{itemKind, registryKind,
 * registryField}`, exactly `defineCollectionKind()`'s own return value,
 * plus which of the item's own fields map onto the normalized shape - see
 * that adapter's own doc comment below for the full parameter list).
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
import { QuCrypto } from '@qu/core';
import { deriveOwnerNodeId, deriveContentNodeId } from '@qu/space-core';
import { routeRegistryKind, sharedListKind, sharedListAnchor, adminRouteRegistryKind, globalAppAnchor } from './kinds.js';

function normalize({ title = '', excerpt = '', route = null, timestamp = null, raw = null }) {
  return { title, excerpt, route, timestamp, raw };
}

export const VIEW_SOURCE_ADAPTERS = {
  /**
   * @param {{prefix?: string, ownerPrefix?: string}} params - `prefix` (optional) keeps only routes
   * starting with it, e.g. `'/blog/'` - "a blog is just pages under one route prefix" (this file's
   * own top doc comment). Omit for every published route.
   *
   * `ownerPrefix` (optional) - CROSS-APP sourcing: reads a DIFFERENT `realm: 'global'` app's own
   * route registry (`adminRouteRegistryKind`, anchored on `globalAppAnchor(ownerPrefix)`) instead of
   * THIS View's own owner - the "app-übergreifend" Views requirement (the user's own framing): a
   * View defined under one app's CMS can still merge/filter another app's own Pages into its feed.
   * Omit entirely (unchanged, pre-existing behavior) for the common case, a View reading its OWN
   * app's Pages. A `'shared-list'` source (below) already works cross-app with NO such param at all -
   * a shared list's id is anchored on a hash of its own NAME (`sharedListAnchor()`), never on any
   * app's identity, so any View may already source ANY shared list by name regardless of which app
   * registered it.
   */
  pages: {
    async open(space, { appAdminPub, kinds }, params) {
      const crossApp = !!params?.ownerPrefix;
      const registryKind = crossApp ? adminRouteRegistryKind : (kinds?.routeRegistryKind ?? routeRegistryKind);
      const owner = crossApp ? await globalAppAnchor(params.ownerPrefix) : appAdminPub;
      const id = await deriveOwnerNodeId(owner, registryKind.kind);
      const { node, release } = await space.useNode(id, registryKind);
      const field = node.field('routes');
      const read = async () =>
        (await field.toArray())
          .filter(Boolean)
          .filter((r) => !params?.prefix || r.route.startsWith(params.prefix))
          .map((r) => normalize({ title: r.title, excerpt: r.excerpt ?? '', route: r.route, raw: r }));
      return { id, read, observe: (cb) => field.observe(cb), release };
    },
  },
  /**
   * @param {{name: string, filter?: Record<string, *>}} params - `name`: which named shared list
   * (`dev.js`'s `pushToSharedList()`) - required, no default: unlike `'pages'`, there is no single
   * "every shared list" enumeration to fall back to.
   *
   * `name`/`message`/`ts` is a CONVENTION, not a schema `sharedListKind`
   * itself enforces (its own doc comment: entries are caller-defined plain
   * objects) - a guestbook entry's "who signed it"/"what they wrote"/"when"
   * maps onto it directly, and reusing the SAME three keys for a different
   * shared list (a forum topic's "title"/"author line"/"posted at," a chat
   * message's "sender"/"text"/"sent at" - see `docs/example-apps.md`) is
   * what lets ONE adapter serve all of them without per-list configuration.
   * An entry MAY also carry its own `route` (e.g. a forum topic linking to
   * its own detail page, `/forum/topic/<id>`) - passed through as-is,
   * `null` if absent (a guestbook entry has none, unchanged from before
   * this existed) - the same `item.route` a `'pages'` source item already
   * provides, so an `itemTemplate`'s `<a data-qu-view-link>` (`@qu/app-shell`'s
   * `view-actions.js`) works identically regardless of which source
   * produced a given item.
   *
   * `filter` (optional) - a plain `{key: value}` equality match applied to
   * each entry's OWN raw object (`Object.entries(filter).every(([k, v]) =>
   * entry[k] === v)`) BEFORE normalizing - what lets MANY logically
   * separate feeds share ONE physical shared list (and therefore one
   * pre-registered name, see `dev.js`'s `registerApp()` own `sharedLists`
   * doc comment) instead of needing a new, unregistered list name per
   * feed: a Forum's per-topic reply View (`docs/example-apps.md`) filters
   * ONE `<prefix>:replies` list down to `{topicId}`, rather than creating
   * an unpredictable `<prefix>:topic:<id>` list name per topic that the
   * relay was never told to expect.
   */
  'shared-list': {
    async open(space, _ctx, params) {
      const anchor = await sharedListAnchor(params.name);
      const id = await deriveOwnerNodeId(anchor, sharedListKind.kind);
      const { node, release } = await space.useNode(id, sharedListKind);
      const field = node.field('entries');
      const matchesFilter = (e) => !params.filter || Object.entries(params.filter).every(([key, value]) => e[key] === value);
      const read = async () =>
        (await field.toArray())
          .filter(Boolean)
          .filter(matchesFilter)
          .map((e) => normalize({ title: e.name ?? '', excerpt: e.message ?? '', route: e.route ?? null, timestamp: e.ts ?? null, raw: e }));
      return { id, read, observe: (cb) => field.observe(cb), release };
    },
  },
  /**
   * @param {{itemKind: object, registryKind: object, registryField?: string, ownerPub?: Uint8Array|string, titleField?: string, excerptField?: string, routeField?: string, timestampField?: string}} params -
   * `itemKind`/`registryKind`/`registryField` come straight from `kinds.js`'s `defineCollectionKind()`
   * own return value (required - unlike `'pages'`/`'shared-list'`, there is no built-in Kind to fall
   * back to; a Collection is entirely caller-defined). `ownerPub` (optional) defaults to this View's
   * own `appAdminPub` - pass a different one to source someone ELSE's collection, same posture
   * `'pages'`'s own `ownerPrefix` cross-app sourcing takes. `titleField`/`excerptField`/`routeField`/
   * `timestampField` (all optional) name WHICH of the item's own caller-defined fields map onto the
   * normalized shape (kinds.js's own doc comment: a Collection's fields are entirely up to the
   * caller - "a blog post's `{title, author, publishedAt, tags, body}`" - so unlike `'pages'`/
   * `'shared-list'`, there is no fixed convention this adapter could assume; omitting one simply
   * leaves that normalized field at its default `''`/`null`). Every item's OWN full field set is
   * still available via `item.raw` regardless of which of the four are mapped.
   *
   * LIVE at TWO levels, not just one (unlike every other source here): the registry's own item list
   * (`resolver.js`'s `resolveCollectionItems()`'s same `{name: path}` entries) - an item being
   * added/removed - AND each individual item's OWN Y.Doc (`node.doc`'s raw `'update'` event, not a
   * single field's `observe()` - a Collection item has several caller-defined fields, and any one of
   * them changing should recompute the feed, not just whichever one this adapter happens to map).
   * Item subscriptions are opened lazily (as `read()` encounters them) and kept open, reference-
   * counted at the `Space` level (`useNode()`), across recomputes - released all at once in
   * `release()`, along with the registry's own. A brand-new item's OWN first sync is explicitly
   * waited for (up to `itemSyncTimeout`, default 1500ms) the FIRST time `read()` encounters it -
   * without this, `read()` would race the item's own subscribe reply exactly the way `openLiveView()`'s
   * own `waitUntilSynced()` already prevents for a source's `id` itself, just one level deeper (a
   * Collection item is a SEPARATE Node from its registry, unlike `'pages'`/`'shared-list'`, whose
   * normalized fields already live inside the registry/list entry with nothing further to sync). A
   * subsequent, still-unsynced edge case (arriving well past `itemSyncTimeout`) self-corrects the
   * moment that item's sync actually lands regardless, since that itself is a `doc.on('update')`
   * firing, triggering exactly one more recompute - same honest "only as good as what's synced
   * locally, but keeps getting better" posture `setQuery()`'s own doc comment already accepts.
   */
  collection: {
    async open(space, { appAdminPub }, params) {
      const { itemKind, registryKind, registryField = 'items', ownerPub, titleField, excerptField, routeField, timestampField, itemSyncTimeout = 1500 } = params;
      if (!itemKind || !registryKind) {
        throw new Error('view-sources: \'collection\' source requires { itemKind, registryKind } - see defineCollectionKind()');
      }
      const owner = ownerPub ? (typeof ownerPub === 'string' ? QuCrypto.fromBase64(ownerPub) : ownerPub) : appAdminPub;
      const registryId = await deriveOwnerNodeId(owner, registryKind.kind);
      const { node: registryNode, release: releaseRegistry } = await space.useNode(registryId, registryKind);
      const registryListField = registryNode.field(registryField);

      let notify = null; // set by observe() below - shared recompute trigger for BOTH the registry and every item.
      /** @type {Map<string, {node: import('@qu/space-core').SpaceNode, release: () => void, onUpdate: () => void}>} path -> open item subscription. */
      const itemSubs = new Map();

      async function ensureItemOpen(path) {
        const existing = itemSubs.get(path);
        if (existing) return existing.node;
        const itemId = await deriveContentNodeId(owner, itemKind.kind, path);
        const { node: itemNode, release: releaseItem } = await space.useNode(itemId, itemKind);
        const onUpdate = () => notify?.();
        itemNode.doc.on('update', onUpdate);
        itemSubs.set(path, { node: itemNode, release: releaseItem, onUpdate });
        await waitUntilSynced(space, itemId, itemSyncTimeout); // see this adapter's own doc comment on why - only meaningful the FIRST time (a later call finds `existing` above and returns immediately).
        return itemNode;
      }

      /** Releases any item subscription for a path no longer in the registry - a Collection item removed since the last read() must not leak its subscription forever. */
      function releaseRemoved(currentPaths) {
        for (const [path, sub] of itemSubs) {
          if (currentPaths.has(path)) continue;
          sub.node.doc.off('update', sub.onUpdate);
          sub.release();
          itemSubs.delete(path);
        }
      }

      const read = async () => {
        const entries = (await registryListField.toArray()).filter(Boolean);
        releaseRemoved(new Set(entries.map((e) => e.name)));
        return Promise.all(
          entries.map(async (entry) => {
            const itemNode = await ensureItemOpen(entry.name);
            const raw = { path: entry.name };
            for (const fieldName of itemNode.fieldNames()) raw[fieldName] = await itemNode.field(fieldName).get();
            return normalize({
              title: (titleField ? raw[titleField] : null) ?? '',
              excerpt: (excerptField ? raw[excerptField] : null) ?? '',
              route: (routeField ? raw[routeField] : null) ?? null,
              timestamp: (timestampField ? raw[timestampField] : null) ?? null,
              raw,
            });
          })
        );
      };

      return {
        id: registryId,
        read,
        observe(cb) {
          notify = cb;
          const unobserveRegistry = registryListField.observe(cb);
          return () => {
            unobserveRegistry();
            notify = null;
          };
        },
        release() {
          for (const [, sub] of itemSubs) {
            sub.node.doc.off('update', sub.onUpdate);
            sub.release();
          }
          itemSubs.clear();
          releaseRegistry();
        },
      };
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
 * as if it were a single ordinary list Field. It also carries a `setQuery()`
 * for CLIENT-SIDE full-text search - see this function's own "UPDATE" note.
 * @param {import('@qu/space-core').Space} space
 * @param {{appAdminPub: Uint8Array, kinds?: object, sources: Array<{type: string, [k: string]: *}>, sortBy?: string|null, sortOrder?: 'asc'|'desc', limit?: number|null, syncTimeout?: number, searchFields?: string[]}} config - `config` is a resolved View's own field values (`resolveView()`'s return shape), NOT the View's Node id - callers read the View first, then open it. `syncTimeout` (default 3000ms) bounds how long the FIRST `recompute()` waits for every source's initial relay sync before running with whatever arrived - see `waitUntilSynced()`'s own doc comment. `searchFields` (default `['title', 'excerpt']`) names which of a normalized item's OWN fields `setQuery()` matches against.
 * @returns {Promise<{toArray: () => Promise<Array<object>>, observe: (cb: () => void) => (() => void), setQuery: (text: string) => Promise<void>, close: () => void}>}
 *
 * UPDATE - `setQuery()`: A live, case-insensitive SUBSTRING filter applied
 * to every merged item BEFORE `sortBy`/`limit` (so a search narrows what
 * gets ranked/capped, rather than searching only within an already-capped
 * top-N) - deliberately client-side, over whatever this View's sources
 * have ALREADY synced locally: no relay-side search index/query exists
 * (a relay only ever forwards signed envelopes, see `@qu/space-transport`'s
 * relay.js - the same reason a `'pages'` source's routing Node, not a
 * relay query, is what enumerates routes at all). Only as good as what a
 * client has synced, same honest limitation `ListField.slice()`'s own doc
 * comment already accepts for "reduces LOCAL cost only." A `'pages'`
 * source's `item.excerpt` (routeRegistryKind's own doc comment) is what
 * makes this search page/post CONTENT, not just titles - captured once at
 * publish time (`dev.js`'s `publishRoute()`/`publishGlobalRoute()`), not
 * kept in sync on a later edit, same scope cut as the aggregate index's
 * own cached title. Reactive like everything else here: `setQuery()`
 * re-runs `recompute()` and notifies observers, same as a source changing
 * on its own; an empty/whitespace-only query clears the filter entirely.
 */
export async function openLiveView(space, { appAdminPub, kinds, sources, sortBy = null, sortOrder = 'desc', limit = null, syncTimeout = 3000, searchFields = ['title', 'excerpt'] }) {
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
  let query = '';
  const listeners = new Set();
  const compare = compareBy(sortBy, sortOrder);

  // STALE-RESULT GUARD: `recompute()` is called from every source's own `observe(cb)` callback
  // (below) and is NEVER awaited there (an adapter's own change-notification is fire-and-forget,
  // same posture `field.js`'s own write path already takes elsewhere in this codebase) - so two
  // (or more) recompute() calls CAN genuinely overlap, e.g. a single logical Text-field edit
  // sealing as TWO separate envelopes (delete then insert, `field.js`'s `TextField`), each firing
  // its own `doc.on('update')` and therefore its own recompute(). Without this guard, whichever
  // call happens to finish LAST wins - even if it started FIRST and is reading the now-STALE
  // pre-edit state (a real, reproduced bug: a `'collection'` source's item-level watch surfaced
  // this exact interleaving - see architecture.md's own Views section, "A STALE-RECOMPUTE RACE").
  // `generation` makes
  // "a NEWER recompute already started" detectable: a call whose own `read()` resolves after some
  // LATER call already began discards its own (now-superseded) result instead of overwriting
  // `current` with it.
  let generation = 0;
  async function recompute() {
    const thisGeneration = ++generation;
    const all = (await Promise.all(opened.map((o) => o.read()))).flat();
    if (thisGeneration !== generation) return; // a newer recompute() started while this one's read() was in flight - stale, discard.
    const matched = query ? all.filter((item) => searchFields.some((f) => String(item[f] ?? '').toLowerCase().includes(query))) : all;
    if (compare) matched.sort(compare);
    current = limit != null ? matched.slice(0, limit) : matched;
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
    // See this function's own "UPDATE" doc comment. Awaits the recompute so a caller (a search
    // box's own input handler) can rely on `toArray()` reflecting the new query the moment this
    // resolves, not just "eventually, once observe() fires."
    async setQuery(text) {
      query = (text ?? '').trim().toLowerCase();
      await recompute();
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
