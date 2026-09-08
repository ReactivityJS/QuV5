/**
 * CONTENT RESOLVER — the "fachliche Auflösung von Application Content"
 * (docs/app-shell-arbeitsauftrag.md §23): translates a Kind + path into
 * live content, entirely through `@qu/space-core`'s own `useNode()`/field
 * API. Deliberately NOT a new storage abstraction (§23/§24 of the docs) -
 * every method here is a thin, read-only wrapper around
 * `space.useNode(id, kindSchema)` plus a bounded wait for that Node's
 * fields to actually have synced (local-first: instant if this Space
 * already has it in storage; otherwise however long the network round-trip
 * to a subscribed relay/peer takes, capped by `timeout`).
 *
 * Override resolution (docs §15 - User Override -> App Override -> Global
 * Content -> Framework Default) is NOT implemented here yet: this Phase-1
 * resolver only ever looks at ONE owner (the app's own admin identity) -
 * see docs/app-shell-arbeitsauftrag.md's own "Nicht-Ziele" section. Adding
 * the other three levels later is a matter of trying more `ownerPub`s in
 * priority order before falling through to `null` (the "framework
 * default", which `@qu/app-renderer` already provides for a missing
 * template/page) - not a redesign of this class.
 */
import { QuCrypto } from '@qu/core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { deriveContentNodeId } from './content-id.js';
import { appManifestKind, routeRegistryKind, templateRegistryKind, styleRegistryKind, pageKind, templateKind, styleKind, groupKind, privatePageKind, sharedListKind, sharedListAnchor, viewKind } from './kinds.js';

const DEFAULT_KINDS = { appManifestKind, routeRegistryKind, templateRegistryKind, styleRegistryKind, pageKind, templateKind, styleKind, viewKind };

/**
 * Resolves `checkFn`'s first non-null/non-undefined value, `timeout`
 * elapsing, or `space.isNodeSynced(nodeId)` (`@qu/space-core`'s `Space`,
 * `_handleIncoming()`'s own doc comment on the relay's `sync-ack`) having
 * been `true` for a full `settle` window while `checkFn` is STILL empty -
 * whichever comes first. `isNodeSynced()` means a subscribed relay has
 * explicitly confirmed it has told this Space everything it CURRENTLY has
 * mirrored for `nodeId` as of subscribe-time - genuinely nothing published
 * there is one of the two things that can mean, and there is no point
 * burning the REST of `timeout` once it's known. Before this existed,
 * resolving a Node that simply never existed (a brand-new visitor's
 * first-ever page, `boot.js`'s `ensureSelfProvisioned()` being the most
 * visible case) always burned its FULL configured timeout (up to several
 * seconds, stacked across several sequential resolve calls) even against an
 * instantly-responding relay - "still waiting" and "confirmed absent" were
 * indistinguishable client-side before the relay itself started sending
 * this ack at all.
 *
 * EVENT-DRIVEN, not polled, when `space.bus` exists (`Space`'s own `bus`
 * getter - real in production, `@qu/app-shell`'s `shell.js` always
 * constructs one): subscribes to `space.node.<nodeId>.changed` and
 * `space.node.<nodeId>.sync-ack` (both already emitted by `Space`
 * regardless of whether anything here ever listened, see `space.js`'s own
 * `_emitChangeEvents()`/`_handleIncoming()`) and re-runs `checkFn` only
 * when one of those actually fires - resolves the INSTANT the real signal
 * arrives, not up to a poll `interval` later, and spends zero cycles
 * between events. Falls back to a bounded poll loop (`interval`, default
 * 20ms) ONLY when `space` has no `bus` (some lower-level test setups,
 * `isNodeSynced()`'s own state is still correct without one - only the
 * EVENT announcing a change to it is unavailable) - never a silent
 * behavior change, still resolves the exact same value either way.
 *
 * `settle` (default 150ms, the SAME margin `@qu/app-shell`'s
 * `verifyWritesAcked()` already uses for the identical reason) is NOT
 * cosmetic: `isNodeSynced()` only describes what the relay's OWN mirror
 * held at the moment it computed the ack, never anything about a write from
 * a COMPLETELY DIFFERENT peer that was already in flight to the relay at
 * that same moment - `subscribers.get(nodeId).add(fromPeerId)` (relay.js's
 * `handleSubscribe()`) happens BEFORE that snapshot is read, so such a
 * write is still guaranteed to reach this subscriber as an ordinary live
 * forward, just not necessarily BEFORE the (already async, storage-backed)
 * `sync-ack` itself arrives - two independent peers' messages have no
 * relative ordering guarantee at all (relay.js's own per-peer `peerQueues`
 * run fully concurrently with each other). Resolving the instant
 * `isNodeSynced()` flips true, with no settle margin, was a REAL, caught
 * regression: a genuinely-existing page, written by a different identity
 * moments earlier, would routinely resolve to `null` for a fresh visitor
 * subscribing right after, purely because that in-flight live update
 * hadn't been locally applied yet at the exact instant the (separately
 * timed) empty ack arrived (`test/live-app-resolver.test.js`, a REAL
 * multi-peer scenario, caught it immediately - a same-identity self-check
 * like `ensureSelfProvisioned()`'s never raced this way, since nothing else
 * can concurrently write a not-yet-created identity's own Nodes, which is
 * exactly why this bug went unnoticed until a cross-peer test exercised
 * it). `settle` gives any such near-simultaneous write a real window to
 * actually arrive and update `checkFn` before this gives up (armed as a
 * single timer the moment `isNodeSynced()` is first observed true, cleared
 * the instant a LATER `changed` event makes `checkFn` truthy - not reset by
 * every event, exactly like the old poll loop's own `syncedAt ??= ...`)
 * - narrows the remaining race to "an update that took upward of `settle`
 * to physically arrive after being sent," astronomically rarer than
 * "arrived in some arbitrary order relative to an unrelated ack" ever was.
 * Still local-first regardless of any of this: the very first `checkFn()`
 * call (before either the event subscriptions or `isNodeSynced()` are ever
 * consulted) is what makes an ALREADY-locally-known value resolve
 * instantly, synchronously, with no event round-trip at all.
 */
async function waitFor(space, nodeId, checkFn, { timeout = 4000, interval = 20, settle = 150 } = {}) {
  const initial = await checkFn();
  if (initial !== null && initial !== undefined) return initial;

  const bus = space.bus;
  if (!bus) return waitForByPolling(space, nodeId, checkFn, { timeout, interval, settle });

  return new Promise((resolve) => {
    let done = false;
    let settleTimer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(deadlineTimer);
      offChanged();
      offSyncAck();
      resolve(value);
    };
    const recheck = async () => {
      if (done) return;
      const value = await checkFn();
      if (value !== null && value !== undefined) finish(value);
      else if (space.isNodeSynced(nodeId) && settleTimer === null) settleTimer = setTimeout(() => finish(null), settle);
    };
    const offChanged = bus.on(`space.node.${nodeId}.changed`, recheck);
    const offSyncAck = bus.on(`space.node.${nodeId}.sync-ack`, recheck);
    const deadlineTimer = setTimeout(() => finish(null), timeout);
    recheck(); // covers "already synced by the time we started listening" - isNodeSynced() is current STATE, not a replayed event.
  });
}

/** The pre-event-driven implementation, kept as `waitFor()`'s own fallback for a `space` with no `bus` configured - see that function's own doc comment. Identical semantics, just re-checking on a fixed `interval` instead of on the real underlying events. */
async function waitForByPolling(space, nodeId, checkFn, { timeout, interval, settle }) {
  const deadline = Date.now() + timeout;
  let syncedAt = null;
  for (;;) {
    const value = await checkFn();
    if (value !== null && value !== undefined) return value;
    if (space.isNodeSynced(nodeId)) {
      syncedAt ??= Date.now();
      if (Date.now() - syncedAt >= settle) return null;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export class ContentResolver {
  /**
   * @param {import('@qu/space-core').Space} space
   * @param {{appAdminPub: Uint8Array|string, kinds?: {appManifestKind, routeRegistryKind, pageKind, templateKind, styleKind}}} params
   *   `appAdminPub` = the app owner's Ed25519 signing pubkey (raw bytes or
   *   base64), whose Nodes this resolver looks up. See this file's own doc
   *   comment for why only one owner is supported yet. `kinds` overrides
   *   which Kind-Schemas each method resolves against - defaults to the
   *   ordinary public `qu-app`/`qu-page`/`qu-template`/`qu-style` set;
   *   `platform.js`'s global-app resolution passes the `qu-admin-*`
   *   variants (`kinds.js`'s own "GLOBAL APP CONTENT" doc comment) instead,
   *   together with that app's own `globalAppAnchor(prefix)` as
   *   `appAdminPub` - every id-derivation call below is unchanged either
   *   way, only WHICH Kind (and therefore which envelope visibility/ACL)
   *   it resolves against.
   */
  constructor(space, { appAdminPub, kinds = DEFAULT_KINDS }) {
    this._space = space;
    this._appAdminPub = typeof appAdminPub === 'string' ? QuCrypto.fromBase64(appAdminPub) : appAdminPub;
    this._kinds = kinds;
  }

  /** @returns {Promise<{name, version, rootTemplate, defaultRoute, theme, metadata}|null>} `null` if no manifest is published (or it hasn't synced within `timeout`). */
  async resolveManifest({ timeout } = {}) {
    const appManifestKind = this._kinds.appManifestKind;
    const id = await deriveOwnerNodeId(this._appAdminPub, appManifestKind.kind);
    const { node, release } = await this._space.useNode(id, appManifestKind);
    const manifest = await waitFor(this._space, id, async () => {
      const name = await node.field('name').get();
      if (!name) return null;
      const [version, rootTemplate, defaultRoute, theme, metadata] = await Promise.all([
        node.field('version').get(),
        node.field('rootTemplate').get(),
        node.field('defaultRoute').get(),
        node.field('theme').get(),
        node.field('metadata').get(),
      ]);
      return { name, version, rootTemplate, defaultRoute, theme, metadata };
    }, { timeout });
    release();
    return manifest;
  }

  /** @returns {Promise<Array<{route: string, title: string}>>} Every route this app has published (docs §12) - for enumeration (nav/sitemap), never for resolving one already-known route (see router.js). Empty array if no registry exists yet. */
  async resolveRoutes({ timeout } = {}) {
    const routeRegistryKind = this._kinds.routeRegistryKind;
    const id = await deriveOwnerNodeId(this._appAdminPub, routeRegistryKind.kind);
    const { node, release } = await this._space.useNode(id, routeRegistryKind);
    await waitFor(this._space, id, () => (node.field('routes').length > 0 ? true : null), { timeout: timeout ?? 500 });
    const routes = await node.field('routes').toArray();
    release();
    return routes.filter(Boolean);
  }

  /**
   * @param {string} route
   * @param {{timeout?: number, hold?: boolean}} [options] - `hold: true`
   *   (default `false`) skips this method's own usual internal `release()`
   *   and returns `{page, release}` instead of the bare `page` - for a
   *   caller (a CMS "click to load into the edit form" handler is the
   *   reference case) about to possibly WRITE to this exact Node moments
   *   later and wanting to keep it subscribed across that window, instead
   *   of `Space.useNode()`'s own ref-counted teardown tearing the local
   *   Y.Doc down the instant this read's own reference count would
   *   otherwise drop to zero - a fresh re-subscribe for the edit would then
   *   need a full relay replay before writing, exactly the "does not exist
   *   (or has not synced)" production bug architecture.md §7 documents.
   *   Was previously worked around per-app (`@qu/app-shell`'s own
   *   `cms-actions.js`, `holdEdit()`) by calling `useNode()` a SEPARATE,
   *   redundant extra time; `hold` moves the same correct pattern into this
   *   shared resolver instead, so no app needs to reinvent it. The caller
   *   owns calling `release()` eventually either way (when a different item
   *   is loaded, the form is reset, or the edit completes) - `hold: true`
   *   with the returned `release()` never called leaks exactly like any
   *   other un-released `useNode()` handle would.
   * @returns {Promise<{route, title, template, content, data, style}|null>|Promise<{page: object|null, release: () => void}>}
   *   Bare `page` (`null` if this route has no published page, or it hasn't
   *   synced within `timeout`) when `hold` is falsy (default); `{page,
   *   release}` when `hold` is true, `page` itself following the exact same
   *   null-or-object shape either way. `data` is kinds.js's `pageKind` own
   *   structured-data field (an arbitrary JSON object, or `null` if never
   *   set) - see its own doc comment; `style` is that same Kind's own
   *   per-page style-name override (`null` = fall back to the Manifest's
   *   `theme`, `runtime.js`'s `AppRuntime.resolveRoute()` own doc comment) -
   *   neither is part of the sync-readiness check below, a page missing
   *   either is a perfectly normal, backward-compatible page, not an
   *   unsynced one.
   */
  async resolvePage(route, { timeout, hold = false } = {}) {
    const pageKind = this._kinds.pageKind;
    const id = await deriveContentNodeId(this._appAdminPub, pageKind.kind, route);
    const { node, release } = await this._space.useNode(id, pageKind);
    const page = await waitFor(this._space, id, async () => {
      // GATE ON isNodeSynced() FIRST - a REAL, caught bug (architecture.md §7's own "does not exist
      // (or has not synced)" production report, and this file's own resolveGroup()/resolveSharedList()
      // doc comments describe the identical root cause): a fresh re-subscribe (e.g. right after an
      // edit torn the previous local Y.Doc down, `Space.useNode()`'s own ref-counted teardown) replays
      // EVERY envelope this Node ever had, oldest first - "title/content are both non-empty" can
      // already be true on the OLD pre-edit value, several envelopes before the LATEST edit has even
      // been applied. Waiting for the relay's own sync-ack first means every envelope it currently has
      // - the edit included - is guaranteed already applied before ANY field below is read, so this
      // never returns a stale intermediate value merely because it happened to already be non-empty.
      if (!this._space.isNodeSynced(id)) return null;
      const title = await node.field('title').get();
      const content = node.field('content').get();
      // Wait for BOTH: `title`/`content` are written as SEPARATE envelopes (see kinds.js/node.js's
      // own doc comments) - a Node id's very existence (title synced) does not mean every OTHER
      // field synced too, especially over a real network. Same "empty string reads as not-yet-
      // synced" tradeoff resolveTemplate()/resolveStyle() below already accept for their own single
      // field - a genuinely empty page body is a rare enough edge case not worth resolving here.
      if (!title || !content) return null;
      const template = await node.field('template').get();
      const data = await node.field('data').get();
      const style = await node.field('style').get();
      return { route, title, template, content, data, style };
    }, { timeout });
    if (hold) return { page, release };
    release();
    return page;
  }

  /** @returns {Promise<Array<{name: string}>>} Every template name this app owner has published (`dev.js`'s `createTemplate()` auto-registers - see `kinds.js`'s own `templateRegistryKind` doc comment) - for a CMS-style editor to list "every template," never for resolving one already-known name (see `resolveTemplate()`). Empty array if no registry exists yet. */
  async resolveTemplateNames({ timeout } = {}) {
    const templateRegistryKind = this._kinds.templateRegistryKind;
    const id = await deriveOwnerNodeId(this._appAdminPub, templateRegistryKind.kind);
    const { node, release } = await this._space.useNode(id, templateRegistryKind);
    await waitFor(this._space, id, () => (node.field('templates').length > 0 ? true : null), { timeout: timeout ?? 500 });
    const templates = await node.field('templates').toArray();
    release();
    return templates.filter(Boolean);
  }

  /** @returns {Promise<Array<{name: string}>>} Every style name this app owner has published - see `resolveTemplateNames()`'s own doc comment, identical shape. */
  async resolveStyleNames({ timeout } = {}) {
    const styleRegistryKind = this._kinds.styleRegistryKind;
    const id = await deriveOwnerNodeId(this._appAdminPub, styleRegistryKind.kind);
    const { node, release } = await this._space.useNode(id, styleRegistryKind);
    await waitFor(this._space, id, () => (node.field('styles').length > 0 ? true : null), { timeout: timeout ?? 500 });
    const styles = await node.field('styles').toArray();
    release();
    return styles.filter(Boolean);
  }

  /** @param {string} name @param {{timeout?: number, hold?: boolean}} [options] - see `resolvePage()`'s own doc comment on `hold`. @returns {Promise<string|null>|Promise<{value: string|null, release: () => void}>} A template's HTML (`null` if unpublished/unsynced within `timeout`) when `hold` is falsy (default); `{value, release}` when `hold` is true. */
  async resolveTemplate(name, { timeout, hold = false } = {}) {
    const templateKind = this._kinds.templateKind;
    const id = await deriveContentNodeId(this._appAdminPub, templateKind.kind, name);
    const { node, release } = await this._space.useNode(id, templateKind);
    const html = await waitFor(this._space, id, () => {
      // See resolvePage()'s own doc comment on gating on isNodeSynced() first - same reasoning,
      // applied here for an EDITED template's html (single field, but still re-write-able, still
      // subject to the same "stale intermediate value happens to already be non-empty" race).
      if (!this._space.isNodeSynced(id)) return null;
      const value = node.field('html').get();
      return value ? value : null;
    }, { timeout });
    if (hold) return { value: html, release };
    release();
    return html;
  }

  /** @param {string} name @param {{timeout?: number, hold?: boolean}} [options] - see `resolvePage()`'s own doc comment on `hold`. @returns {Promise<string>|Promise<{value: string, release: () => void}>} A stylesheet's CSS (`''` if unpublished/unsynced within `timeout`) when `hold` is falsy (default); `{value, release}` when `hold` is true. */
  async resolveStyle(name, { timeout, hold = false } = {}) {
    if (!name) return hold ? { value: null, release: () => {} } : null;
    const styleKind = this._kinds.styleKind;
    const id = await deriveContentNodeId(this._appAdminPub, styleKind.kind, name);
    const { node, release } = await this._space.useNode(id, styleKind);
    // 2000ms, not the generic 4000ms other resolve*() methods fall back to (kinds.js's
    // ADMIN_KINDS/DEFAULT_KINDS resolveManifest()/resolvePage()/resolveTemplate() all share
    // waitFor()'s own default) - a missing/never-configured theme is common enough that a shorter
    // wait keeps that case snappy, but 'content'-ACL Kinds (kind-schema.js) now need a genuine
    // extra round-trip (the creating owner's own transparent self-grant, see space.js's own
    // createNode() doc comment) before their first write is even readable, so the OLD 1000ms could
    // occasionally time out real, existing content under real network/CPU load - not just "no
    // theme set."
    const css = await waitFor(this._space, id, () => {
      // See resolvePage()'s own doc comment on gating on isNodeSynced() first - identical reasoning.
      if (!this._space.isNodeSynced(id)) return null;
      const value = node.field('css').get();
      return value !== '' ? value : null;
    }, { timeout: timeout ?? 2000 });
    if (hold) return { value: css ?? '', release };
    release();
    return css ?? '';
  }

  /**
   * Enumerates every item currently registered in a Collection (kinds.js's
   * `defineCollectionKind()`) - the SAME "registry Node, not a query"
   * pattern `resolveTemplateNames()`/`resolveStyleNames()` above already
   * use, generalized to any caller-defined Collection instead of the two
   * built-in ones. Only returns each item's own `path` (the registry's
   * `{name: path}` entries, `dev.js`'s `createCollectionItem()`) - call
   * `resolveCollectionItem()` for one item's actual field data.
   * @param {{registryKind: object, registryField: string, ownerPub?: Uint8Array|string, timeout?: number}} params - `registryKind`/`registryField` come straight from `defineCollectionKind()`'s own return value. `ownerPub` defaults to this resolver's own configured `appAdminPub` (the common case, listing YOUR OWN collection) - pass a different one to read someone else's, if already known through some other channel.
   * @returns {Promise<Array<{name: string}>>}
   */
  async resolveCollectionItems({ registryKind, registryField, ownerPub, timeout } = {}) {
    const owner = ownerPub ? (typeof ownerPub === 'string' ? QuCrypto.fromBase64(ownerPub) : ownerPub) : this._appAdminPub;
    const id = await deriveOwnerNodeId(owner, registryKind.kind);
    const { node, release } = await this._space.useNode(id, registryKind);
    await waitFor(this._space, id, () => (node.field(registryField).length > 0 ? true : null), { timeout: timeout ?? 500 });
    const items = await node.field(registryField).toArray();
    release();
    return items.filter(Boolean);
  }

  /**
   * Resolves ONE Collection item's own field data by its `path` (the same
   * key `resolveCollectionItems()` returns as each entry's `name`) - the
   * generic counterpart to `resolveTemplate()`/`resolveStyle()`, for any
   * caller-defined item shape (`defineCollectionKind()`'s `fields`). Waits
   * for ANY ONE of the item's own fields to have a value as its "the Node
   * itself has synced" signal - unlike `resolvePage()`'s fixed
   * `title`+`content` check, a Collection's field set is entirely
   * caller-defined, so there's no fixed field name to wait on specifically.
   * @param {string} path
   * @param {{itemKind: object, ownerPub?: Uint8Array|string, timeout?: number}} params
   * @returns {Promise<object|null>} every field's current value, keyed by field name; `null` if unpublished/unsynced within `timeout`.
   */
  async resolveCollectionItem(path, { itemKind, ownerPub, timeout } = {}) {
    const owner = ownerPub ? (typeof ownerPub === 'string' ? QuCrypto.fromBase64(ownerPub) : ownerPub) : this._appAdminPub;
    const id = await deriveContentNodeId(owner, itemKind.kind, path);
    const { node, release } = await this._space.useNode(id, itemKind);
    const fieldNames = Object.keys(itemKind.fields);
    const item = await waitFor(this._space, id, async () => {
      const values = {};
      let anySet = false;
      for (const name of fieldNames) {
        const value = await node.field(name).get();
        values[name] = value;
        if (value !== null && value !== undefined && value !== '') anySet = true;
      }
      return anySet ? values : null;
    }, { timeout });
    release();
    return item;
  }

  /**
   * @param {string} name
   * @param {{ownerPub?: Uint8Array|string, timeout?: number}} [params] - `ownerPub` defaults to this resolver's own configured `appAdminPub` (the common case - a group owned by the SAME identity as the content it protects), same convention `resolveCollectionItems()` already uses.
   * @returns {Promise<{name: string, members: Array<{pub: Uint8Array, xPub: Uint8Array}>}|null>} `null` if unpublished/unsynced within `timeout`. `members` are decoded back to raw bytes - the exact shape `createPrivatePage()`'s own `recipients` param expects (`members.map(m => m.xPub)`).
   */
  async resolveGroup(name, { ownerPub, timeout } = {}) {
    const owner = ownerPub ? (typeof ownerPub === 'string' ? QuCrypto.fromBase64(ownerPub) : ownerPub) : this._appAdminPub;
    const id = await deriveContentNodeId(owner, groupKind.kind, name);
    const { node, release } = await this._space.useNode(id, groupKind);
    const group = await waitFor(this._space, id, async () => {
      // Unlike a brand-new Node's FIRST-ever write (where a field going from empty to non-empty IS
      // the "is it here yet" signal every other `waitFor()` caller in this file relies on), an EDIT
      // to an ALREADY-EXISTING group's `members` list has no such tell: `members` was already
      // non-empty before the edit (`dev.js`'s `editGroup()`), so a caller whose OWN earlier read
      // already released this Node (this class's own "every read releases when done" contract) and
      // is now re-subscribing from scratch could see a PARTIALLY-applied replay - `name` (unchanged
      // since creation) already in, but `members`' own LATEST envelope not yet applied - and hand
      // back a "found a value" result built from the STALE list, genuinely indistinguishable from
      // the fresh one by shape alone. `isNodeSynced()` (`Space`'s own doc comment) closes that gap:
      // it only goes true once a subscribed relay confirms EVERYTHING it currently has for this id
      // has already been delivered, and this codebase's own serial, arrival-ordered message
      // processing (`Space._handleIncoming()`'s own doc comment) guarantees every envelope ahead of
      // that confirmation in the same reply is already applied by the time it arrives - so gating on
      // it here is what makes a re-read after an edit actually see the edit, not just eventually.
      if (!this._space.isNodeSynced(id)) return null;
      const groupName = await node.field('name').get();
      if (!groupName) return null;
      const rawMembers = await node.field('members').get();
      const members = (rawMembers ?? []).map((m) => ({ pub: QuCrypto.fromBase64(m.pub), xPub: QuCrypto.fromBase64(m.xPub) }));
      return { name: groupName, members };
    }, { timeout });
    release();
    return group;
  }

  /**
   * `privatePageKind`'s counterpart to `resolvePage()` - see that method's
   * own doc comment (identical shape/sync-readiness reasoning). `null`
   * covers BOTH "no such route" AND "this route exists, but the currently
   * signed-in identity is not an authorized reader" - genuinely
   * indistinguishable on purpose (kinds.js's own `privatePageKind` doc
   * comment) - a non-recipient's `Space` never even integrates the
   * encrypted update in the first place, so from here it looks exactly
   * like nothing was ever published.
   * @param {string} route
   * @returns {Promise<{route, title, template, content, data}|null>}
   */
  async resolvePrivatePage(route, { timeout } = {}) {
    const id = await deriveContentNodeId(this._appAdminPub, privatePageKind.kind, route);
    const { node, release } = await this._space.useNode(id, privatePageKind);
    const page = await waitFor(this._space, id, async () => {
      // Same "an EDIT to an already-existing value has no empty-to-non-empty tell" gap
      // `resolveGroup()`'s own doc comment above explains in full - `editPrivatePage()` can update
      // `content` without every OTHER field, so a re-subscribe racing a partially-applied replay
      // could otherwise return an internally-inconsistent mix of a stale and a fresh field. Gating
      // on `isNodeSynced()` first means every envelope the relay already had for this id (the latest
      // edit included) is guaranteed applied before any field below is even read.
      if (!this._space.isNodeSynced(id)) return null;
      const title = await node.field('title').get();
      const content = node.field('content').get();
      if (!title || !content) return null;
      const template = await node.field('template').get();
      const data = await node.field('data').get();
      return { route, title, template, content, data };
    }, { timeout });
    release();
    return page;
  }

  /**
   * Every entry currently on a NAMED shared list (`kinds.js`'s
   * `sharedListKind` doc comment) - `[]` both while genuinely empty (a
   * brand-new guestbook nobody has signed yet) AND if the list has never
   * been written to at all - deliberately indistinguishable, the same
   * "empty array if no registry exists yet" default `resolveTemplateNames()`/
   * `resolveStyleNames()` already accept for their own registries.
   * Gated on `isNodeSynced()` rather than "entries is non-empty" (unlike
   * every OTHER resolver method here): an empty list is a perfectly valid,
   * final answer for this Kind, so "wait for a non-empty value" would hang
   * out the full `timeout` for a real, already-synced, still-empty
   * guestbook - waiting for the relay's sync-ack instead means an empty
   * result comes back as fast as a genuinely populated one does.
   * @param {string} name - see `pushToSharedList()`.
   * @returns {Promise<Array<object>>}
   */
  async resolveSharedList(name, { timeout } = {}) {
    const anchor = await sharedListAnchor(name);
    const id = await deriveOwnerNodeId(anchor, sharedListKind.kind);
    const { node, release } = await this._space.useNode(id, sharedListKind);
    const entries = await waitFor(this._space, id, async () => {
      if (!this._space.isNodeSynced(id)) return null;
      return (await node.field('entries').toArray()).filter(Boolean);
    }, { timeout });
    release();
    return entries ?? [];
  }

  /**
   * Resolves a View's OWN configuration (`kinds.js`'s `viewKind` doc
   * comment) - `sources`/`sortBy`/`sortOrder`/`limit`/`itemTemplate`, NOT
   * its resolved items - `@qu/app-core`'s `view-sources.js`'s
   * `openLiveView(space, {appAdminPub: ownerPub ?? this._appAdminPub,
   * kinds: this._kinds, ...resolved})` is what turns this into an actual
   * live, merged item feed. Kept separate on purpose: reading a View's
   * config is an ordinary one-shot resolve (this class's own established
   * shape), while OPENING it is a persistent subscription with its own
   * lifecycle (`openLiveView()`'s own `close()`) this class's "every read
   * releases when done" contract was never designed for.
   * @param {string} name
   * @param {{ownerPub?: Uint8Array|string, timeout?: number, hold?: boolean}} [options] - see `resolvePage()`'s own doc comment on `hold`.
   * @returns {Promise<{sources: Array<object>, sortBy: string|null, sortOrder: string, limit: number|null, itemTemplate: string}|null>|Promise<{view: object|null, release: () => void}>}
   *   Bare `view` when `hold` is falsy (default); `{view, release}` when `hold` is true.
   */
  async resolveView(name, { ownerPub, timeout, hold = false } = {}) {
    const owner = ownerPub ? (typeof ownerPub === 'string' ? QuCrypto.fromBase64(ownerPub) : ownerPub) : this._appAdminPub;
    const viewKindHere = this._kinds.viewKind ?? viewKind;
    const id = await deriveContentNodeId(owner, viewKindHere.kind, name);
    const { node, release } = await this._space.useNode(id, viewKindHere);
    const view = await waitFor(this._space, id, async () => {
      // See resolvePage()'s own doc comment on gating on isNodeSynced() first - identical reasoning.
      if (!this._space.isNodeSynced(id)) return null;
      const itemTemplate = node.field('itemTemplate').get();
      if (!itemTemplate) return null;
      const sources = await node.field('sources').get();
      const sortBy = await node.field('sortBy').get();
      const sortOrder = await node.field('sortOrder').get();
      const limit = await node.field('limit').get();
      const route = await node.field('route').get();
      const template = await node.field('template').get();
      return { sources: sources ?? [], sortBy: sortBy ?? null, sortOrder: sortOrder ?? 'desc', limit: limit ?? null, itemTemplate, route: route ?? null, template: template ?? null };
    }, { timeout });
    if (hold) return { view, release };
    release();
    return view;
  }
}
