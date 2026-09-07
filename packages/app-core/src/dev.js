/**
 * DEV / ADMIN API — bootstraps an empty Space into a working app (docs
 * §25): thin wrappers around `Space.createNode()`, nothing more. Every
 * function here writes AS `space`'s own identity - that identity IS the
 * app-admin (and, for `qu-page`/`qu-template`/`qu-style`, the initial
 * OWNER - see kinds.js's own doc comment on why those are `acl.write:
 * 'content'`) for whatever it creates. `Space.createNode()` derives the
 * content-addressed id AND issues the creating identity a transparent
 * self-grant itself for `'content'`-ACL Kinds (see space.js's own doc
 * comment) - these functions only ever pass `path`, never compute/pass an
 * `id` by hand. A reader elsewhere (`ContentResolver`) must be told that
 * SAME identity's pubkey as `appAdminPub` to find anything these functions
 * create. Extending write access to a SPECIFIC other identity (e.g. "let
 * user X edit exactly this page") is `space.grantWriter(id, kind,
 * granteePub, {path})` - not something this file wraps, since it is
 * already exactly one call.
 */
import { deriveOwnerNodeId, stampMeta } from '@qu/space-core';
import { QuCrypto } from '@qu/core';
import { deriveContentNodeId } from './content-id.js';
import {
  appManifestKind,
  routeRegistryKind,
  templateRegistryKind,
  styleRegistryKind,
  pageKind,
  templateKind,
  styleKind,
  groupKind,
  privatePageKind,
  sharedListKind,
  sharedListAnchor,
  viewKind,
  platformAppsKind,
  PLATFORM_REGISTRY_ANCHOR,
  adminAppManifestKind,
  adminPageKind,
  adminTemplateKind,
  adminStyleKind,
  adminRouteRegistryKind,
  adminViewKind,
  globalAppAnchor,
} from './kinds.js';

/** Memoized per-prefix - `globalAppAnchor()` (kinds.js) hashes on every call, cheap but pointless to redo for the SAME prefix within one process. */
const globalAppAnchorCache = new Map();
function cachedGlobalAppAnchor(prefix) {
  if (!globalAppAnchorCache.has(prefix)) globalAppAnchorCache.set(prefix, globalAppAnchor(prefix));
  return globalAppAnchorCache.get(prefix);
}

/**
 * Polls `checkFn` (may itself be async - `'atomic'`-shape fields' own
 * `.get()` is a Promise, `'text'`-shape's is not, see field.js) until it
 * returns truthy, `timeout` elapses, or (when `space`/`nodeId` are given)
 * `space.isNodeSynced(nodeId)` has been true for a full `settle` window
 * while `checkFn` is still falsy - the SAME "a relay's `sync-ack` means
 * don't bother waiting out the rest of the timeout for a Node that's
 * confirmed to not exist, but give a settle margin first" fast-path
 * `resolver.js`'s own identically-shaped `waitFor()` uses (see that
 * function's own doc comment on both `isNodeSynced()` and `settle` - in
 * particular why the settle margin is NOT optional: a concurrent write
 * from a genuinely different peer has no ordering guarantee relative to an
 * empty sync-ack), local here (not imported from resolver.js) so this file
 * stays independent of that one. `space`/`nodeId` are OPTIONAL (default
 * `null`) - every `edit*()` call site below omits them (an edit's own
 * "does this exist" check has no single `nodeId` fast-path win worth
 * threading through every call site for now), only
 * `getOrSyncRegistryNode()` passes them, since it sits directly in
 * `createTemplate()`/`createStyle()`'s own hot path (a brand-new
 * identity's first-ever registry write, exactly the sequence `boot.js`'s
 * `ensureSelfProvisioned()` runs on a first-time visit).
 */
async function waitForSync(checkFn, { timeout = 3000, interval = 20, settle = 150, space = null, nodeId = null } = {}) {
  const deadline = Date.now() + timeout;
  let syncedAt = null;
  for (;;) {
    if (await checkFn()) return true;
    if (space?.isNodeSynced(nodeId)) {
      syncedAt ??= Date.now();
      if (Date.now() - syncedAt >= settle) return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** A `'text'`-shape field (field.js's `TextField`) has no `set()` - only `get()`/`insert()`/`delete()` (real Y.Text, collaborative-editing-shaped) - so "replace the whole value" is delete-everything-then-insert, two ordinary local mutations, not one. Both are synchronous/fire-and-forget on the field itself (see field.js) - the resulting Yjs updates still seal/send exactly like any other write, just as two envelopes instead of one. */
function replaceText(field, value, { recipients } = {}) {
  const current = field.get();
  if (current) field.delete(0, current.length, { recipients });
  if (value) field.insert(0, value, { recipients });
}

/** Creates (or overwrites) this Space identity's App Manifest - see kinds.js's `appManifestKind`. */
export async function createApp(space, { name, version = '1.0', rootTemplate = null, defaultRoute = '/', theme = null, metadata = '' }) {
  return space.createNode(appManifestKind, { name, version, rootTemplate, defaultRoute, theme, metadata });
}

/**
 * Locates this identity's `'named'`-ACL registry Node (`routeRegistryKind`/
 * `templateRegistryKind`/`styleRegistryKind`), subscribing and waiting for
 * it to sync from the relay FIRST if it isn't already locally attached -
 * NEVER blindly `Space.createNode()`s over an id that might already have
 * entries elsewhere. A real, deployment-observed bug this fixes: the
 * OLD `space.getNode(id) ?? space.createNode(...)` pattern treated
 * "not currently attached in THIS Space instance" (true on every fresh
 * page load/session, regardless of whether the registry already has
 * entries from an EARLIER session) as "genuinely doesn't exist yet" -
 * `createNode()` then forks a brand-new, causally-unrelated Y.Doc and
 * `stampMeta()`s it as if this were the Node's first-ever creation,
 * exactly the trap `space.js`'s own `stampMeta()` doc comment warns
 * against (a competing doc for an already-created Node, not a graceful
 * merge - the SAME class of bug `editTemplate()`/`editStyle()`/
 * `editPage()` already guard against for content Nodes, just never
 * applied to registries). The practical symptom: a route/template/style
 * that had synced back in from an EARLIER call briefly (or, in the
 * unlucky case, `stampMeta()`'s meta-key race, permanently) disappears
 * from the registry a NEW call to `registerContentName()`/`publishRoute()`
 * appends to, right after an operation that looked otherwise successful.
 * Only STAMPS the Node (see below) once a bounded wait genuinely confirms
 * it has never been stamped (`meta.get('kind')` still unset) - checked via
 * `meta`, not the list field's own length, since an empty-but-real
 * registry (the split second between its own creation and its first entry
 * being pushed) must not be mistaken for "never existed." 500ms default,
 * matching `resolver.js`'s own already-accepted "does this registry exist
 * yet" tradeoff (`resolveTemplateNames()`/`resolveStyleNames()`/
 * `resolveRoutes()`'s identical default) - the ONLY case that ever pays
 * this cost is a brand-new app's FIRST template/style/published route
 * (nothing to discover yet, so the wait always runs to completion); an
 * app-admin's client that keeps this registry Node held open across an
 * editing session (e.g. `@qu/app-shell`'s CMS, holding it for the
 * session's whole lifetime rather than releasing it after every single
 * read) never pays it again after the first call, since
 * `space.getNode(id)` above then finds it immediately.
 *
 * FALLS BACK TO `stampMeta()` ON THE NODE WE ALREADY HAVE OPEN, NEVER TO
 * `space.createNode()` - a SECOND, real bug this once had, caught building
 * the Guestbook/Forum apps (`@qu/app-shell`): `space.useNode(id,
 * registryKind)` a few lines up already attached (and cached, in `Space`'s
 * own `_nodes` map) whatever Node object this call is going to use,
 * SYNCHRONOUSLY, before the `waitForSync()` wait even starts - so ANY
 * OTHER concurrent caller for the SAME id within this SAME Space instance
 * (e.g. `wireViews()` opening a live `'shared-list'` source on the very
 * page whose form is about to `pushToSharedList()` into that SAME list - a
 * Guestbook's own index renders both on one page) finds and shares that
 * EXACT node too, `field.observe()`-subscribing to it. `space.createNode()`
 * unconditionally forks a BRAND NEW Y.Doc and overwrites `_nodes.set(id,
 * ...)` with it - orphaning that other caller's subscription on the old
 * (still real, still correct) doc forever: it silently stops receiving ANY
 * further update for that id (`Space._handleIncoming()` only ever routes
 * to whatever `_nodes.get(id)` currently returns), while THIS call's own
 * write lands on the fresh, disconnected replacement - a write the relay
 * genuinely acks (nothing rejects it) yet invisible to the very page that
 * just made it. Restamping the node we already hold - the SAME
 * `stampMeta()` `space.createNode()` itself uses internally - never
 * discards anything, so no subscriber is ever orphaned; safe to invoke
 * more than once too (Yjs' own per-key last-write-wins on `meta` merges
 * harmlessly if real content turns out to have been in flight after all).
 */
async function getOrSyncRegistryNode(space, registryKind, ownerPub = space.identity.signingPub) {
  const id = await deriveOwnerNodeId(ownerPub, registryKind.kind);
  const existing = space.getNode(id);
  if (existing) return existing;
  const { node } = await space.useNode(id, registryKind);
  const alreadyExists = await waitForSync(() => node.meta.get('kind') !== undefined, { timeout: 500, space, nodeId: id });
  // `space.identity.signingPub` - NOT this function's own `ownerPub` param, matching exactly what
  // `space.createNode()` itself would have stamped (it always meta-stamps as the CALLING identity,
  // never as whatever `id` was derived from) - for a shared list specifically, `ownerPub` here is
  // actually `sharedListAnchor()`'s content hash, not a real identity, so stamping IT as `ownerPub`
  // would be a meaningless value in a field meant to record who actually originated this Node.
  if (!alreadyExists) stampMeta(node.doc, registryKind, space.identity.signingPub);
  return node;
}

/** One entry, deduplicated by `name` - shared by `createTemplate()`/`createStyle()` below so a caller never has to remember a separate "publish" call the way `qu-page`'s own `publishRoute()` historically needed (kept separate, unchanged, for backward compatibility). */
async function registerContentName(space, registryKind, fieldName, name) {
  const node = await getOrSyncRegistryNode(space, registryKind);
  const existing = await node.field(fieldName).toArray();
  if (!existing.some((entry) => entry?.name === name)) await node.field(fieldName).push({ name });
  return node;
}

/** Creates a template at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-template', name)` - `Space.createNode()` derives it (and self-grants) itself, see this file's own top doc comment. Also registers `name` into `templateRegistryKind` (kinds.js) so `ContentResolver.resolveTemplateNames()` can enumerate it - see `editTemplate()` for updating an EXISTING template instead of creating a new one. */
export async function createTemplate(space, { name, html }) {
  const node = await space.createNode(templateKind, { html }, { path: name });
  await registerContentName(space, templateRegistryKind, 'templates', name);
  return node;
}

/** Creates a stylesheet at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-style', name)` - see `createTemplate()`'s own doc comment (registry included). */
export async function createStyle(space, { name, css }) {
  const node = await space.createNode(styleKind, { css }, { path: name });
  await registerContentName(space, styleRegistryKind, 'styles', name);
  return node;
}

/** Creates a page at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-page', route)` - see `createTemplate()`'s own doc comment. `template` is a template NAME (resolved via content-id.js at render time), not a Node id. `data` is optional STRUCTURED content beyond the single `content` blob - see kinds.js's `pageKind` own doc comment on its `data` field (an arbitrary JSON object, one extra named `<qu-slot>` filled per top-level key). Does NOT auto-register into `routeRegistryKind` (unlike `createTemplate()`/`createStyle()`'s own registries) - call `publishRoute()` separately, unchanged pre-existing behavior. */
export async function createPage(space, { route, title, template = null, content = '', data = null }) {
  return space.createNode(pageKind, { route, title, template, content, data }, { path: route });
}

/**
 * UPDATES a Node the identity behind `ownerPub` already owns (created
 * earlier - by THIS process or another one entirely, possibly a
 * DIFFERENT identity than `space.identity` - see "GRANTED CO-EDITORS"
 * below) - unlike `createTemplate()`, this never calls `Space.createNode()`
 * again (which would derive a BRAND NEW, empty local `Y.Doc` unrelated to
 * whatever this Node's existing remote history already is - silently
 * orphaning it, not "updating" it). Instead: `Space.useNode()` (subscribes
 * if not already attached, replaying any existing history INCLUDING the
 * founding grant - kind-schema.js's own "THE 'content' ACL mode" doc
 * comment on why that replay matters here specifically) then a field
 * write on the result. Waits for the CURRENT value to actually be visible
 * first - not because the write itself needs it, but because `useNode()`
 * only guarantees its OWN subscribe request has been SENT, not that the
 * reply (grant + history) has ARRIVED yet; without waiting, a write issued
 * too early could lose the same "write raced ahead of its own grant" race
 * `Space.createNode()`'s self-grant sequencing exists to avoid. In the CMS
 * UI's own real usage this is normally an instant no-op: the editor
 * already resolved (and displayed) the current value before offering
 * "Save" at all, so the Node is already fully synced locally by the time
 * this runs.
 *
 * GRANTED CO-EDITORS: `ownerPub` defaults to `space.identity.signingPub`
 * (the common "edit my own content" case), but a `grantContentWriter()`ed
 * identity is NOT the owner - the Node's id is still derived from the
 * OWNER's pubkey (`deriveContentNodeId(ownerPub, kind, path)`, unchanged
 * by who is granted), so a grantee must pass the real owner's pubkey
 * explicitly. `space.identity` still signs the write either way - THAT
 * signature (not `ownerPub`) is what the relay checks against its grants.
 * @param {import('@qu/space-core').Space} space
 * @param {{name: string, html: string, ownerPub?: Uint8Array, timeout?: number}} params
 */
export async function editTemplate(space, { name, html, ownerPub = space.identity.signingPub, timeout } = {}) {
  const id = await deriveContentNodeId(ownerPub, templateKind.kind, name);
  const { node, release } = await space.useNode(id, templateKind);
  const synced = await waitForSync(() => node.field('html').get() !== '', { timeout });
  if (!synced) {
    release();
    throw new Error(`editTemplate: template "${name}" does not exist (or has not synced within ${timeout ?? 3000}ms) - use createTemplate() for a genuinely new one`);
  }
  replaceText(node.field('html'), html);
  release();
  return node;
}

/** Style counterpart to `editTemplate()` - see its own doc comment (including `ownerPub`). */
export async function editStyle(space, { name, css, ownerPub = space.identity.signingPub, timeout } = {}) {
  const id = await deriveContentNodeId(ownerPub, styleKind.kind, name);
  const { node, release } = await space.useNode(id, styleKind);
  const synced = await waitForSync(() => node.field('css').get() !== '', { timeout });
  if (!synced) {
    release();
    throw new Error(`editStyle: style "${name}" does not exist (or has not synced within ${timeout ?? 3000}ms) - use createStyle() for a genuinely new one`);
  }
  replaceText(node.field('css'), css);
  release();
  return node;
}

/** Page counterpart to `editTemplate()` - see its own doc comment (including `ownerPub`). Only fields actually passed are updated; omit `title`/`template`/`content`/`data` to leave them unchanged. `title`/`template`/`data` are `'atomic'`-shape (`field.set()`); `content` is `'text'`-shape, see `replaceText()`'s own doc comment. `data` is kinds.js's `pageKind` own structured-data field (see its doc comment) - passing it REPLACES the whole object (an `'atomic'` field is one opaque last-write-wins value, not merged key-by-key). */
export async function editPage(space, { route, title, template, content, data, ownerPub = space.identity.signingPub, timeout } = {}) {
  const id = await deriveContentNodeId(ownerPub, pageKind.kind, route);
  const { node, release } = await space.useNode(id, pageKind);
  // Wait for BOTH title AND content (separate envelopes - see resolver.js's own resolvePage() doc
  // comment on why title alone isn't enough) - content specifically needs its Y.Text placeholder to
  // already exist before replaceText()/insert() below can touch it (field.js's TextField.ytext
  // getter throws otherwise), regardless of whether THIS call is even editing `content`.
  const synced = await waitForSync(async () => {
    const t = await node.field('title').get();
    return t !== '' && node.field('content').get() !== '';
  }, { timeout });
  if (!synced) {
    release();
    throw new Error(`editPage: page "${route}" does not exist (or has not synced within ${timeout ?? 3000}ms) - use createPage() for a genuinely new one`);
  }
  if (title !== undefined) await node.field('title').set(title);
  if (template !== undefined) await node.field('template').set(template);
  if (content !== undefined) replaceText(node.field('content'), content);
  if (data !== undefined) await node.field('data').set(data);
  release();
  return node;
}

/** `{pub, xPub}` (raw bytes, `Space`'s own `members` shape) -> the SAME shape base64-encoded, `groupKind`'s own storage format (kinds.js's own doc comment on why: readable/comparable as plain JSON, same convention `platformAppsKind`'s entries already use for pubkeys). */
function toBase64Pair({ pub, xPub }) {
  return { pub: QuCrypto.toBase64(pub), xPub: QuCrypto.toBase64(xPub) };
}

/**
 * Creates a GROUP (kinds.js's own `groupKind` doc comment) - a named,
 * self-owned, editable member list any `'content'`-ACL Kind can later
 * encrypt for (`createPrivatePage()`/`editPrivatePage()` below, or a
 * future app's own equivalent - `@qu/app-core`'s `ContentResolver.resolveGroup()`
 * resolves a group's CURRENT members back into the raw X25519 pubkeys such
 * a write actually needs). Node id = `deriveContentNodeId(space.identity.signingPub,
 * 'qu-group', name)` - many per owner, same as `createPage()`/`createTemplate()`.
 * @param {import('@qu/space-core').Space} space
 * @param {{name: string, members: Array<{pub: Uint8Array, xPub: Uint8Array}>}} params -
 *   include the creator's OWN identity in `members` if they want to see themselves
 *   listed as a group member later (`Space._effectiveRecipients()` guarantees the
 *   OWNER can always decrypt their own group-encrypted writes regardless - this is
 *   only about the group's own membership LISTING, a separate, cosmetic concern).
 */
export async function createGroup(space, { name, members }) {
  return space.createNode(groupKind, { name, members: members.map(toBase64Pair) }, { path: name });
}

/**
 * REPLACES a group's ENTIRE member list (kinds.js's own `groupKind` doc
 * comment on why this is "last write wins," never a merge) - add/remove a
 * member by reading the CURRENT list first (`ContentResolver.resolveGroup()`),
 * then calling this with the full, updated array; there is no separate
 * add/remove primitive. Existing content already encrypted for the group's
 * PREVIOUS member list is unaffected (its own ciphertext was sealed once,
 * at write time, for whoever was a member THEN) - only a LATER write
 * (re-resolving the group's now-current members first) actually reflects
 * a membership change; this is the exact same "no retroactive re-encryption"
 * tradeoff any group-messaging system with forward secrecy in mind accepts.
 * @param {import('@qu/space-core').Space} space
 * @param {{name: string, members: Array<{pub: Uint8Array, xPub: Uint8Array}>, ownerPub?: Uint8Array, timeout?: number}} params
 */
export async function editGroup(space, { name, members, ownerPub = space.identity.signingPub, timeout } = {}) {
  const id = await deriveContentNodeId(ownerPub, groupKind.kind, name);
  const { node, release } = await space.useNode(id, groupKind);
  // Gating on `name !== null` ALONE (as every other `edit*()` here does for its own single-field
  // check) is not enough for `members`: this Node's `useNode()` call above may have built a BRAND
  // NEW local Y.Doc (this identity's own earlier read already released it), and `name`/`members`
  // arrive as SEPARATE envelopes - `name` can already be applied while `members`' own creation
  // envelope is still in flight. Writing `members` before that lands is a REAL, observed Yjs
  // hazard, not a cosmetic race: this call's `.set()` builds its new item's causal "left" pointer
  // from whatever THIS doc currently has for that key - if the original `members` envelope hasn't
  // landed yet, the new item is built with NO causal link to it at all, so a later reader who
  // applies BOTH ends up with two genuinely CONCURRENT items for the same key. Yjs's own tie-break
  // for that case depends on the two writes' random per-Y.Doc clientIDs, not on which one happened
  // later - an edit can then unpredictably lose to the very value it meant to overwrite, roughly
  // half the time. `space.isNodeSynced(id)` (gated inside the checkFn itself, not just passed
  // through to `waitForSync()`'s own separate "give up early" fast-path below) is what closes this:
  // it only goes true once a subscribed relay confirms EVERY envelope it currently has for this id
  // - `members`' own creation envelope included - has already been delivered and applied.
  const synced = await waitForSync(() => space.isNodeSynced(id) && node.field('name').get() !== null, { timeout, space, nodeId: id });
  if (!synced) {
    release();
    throw new Error(`editGroup: group "${name}" does not exist (or has not synced within ${timeout ?? 3000}ms) - use createGroup() for a genuinely new one`);
  }
  await node.field('members').set(members.map(toBase64Pair));
  release();
  return node;
}

/**
 * Creates a PRIVATE/SHARED page (kinds.js's own `privatePageKind` doc
 * comment) - same shape as `createPage()`, but every field except `route`
 * is encrypted for `recipients` instead of every Space member. Omit
 * `recipients` entirely (it defaults to `[]`, NOT `undefined` - a real,
 * caught-before-shipping distinction: `space.createNode()`/field.js's own
 * `recipients ?? this._ctx.recipientXPubKeys()` treats `undefined` as "no
 * override, use the ordinary full-Space default" - passing `undefined`
 * through here would silently encrypt for EVERY Space member instead of
 * the genuinely-private page this function's own name promises) for a
 * genuinely PRIVATE, single-user page - `Space._effectiveRecipients()`
 * always includes the owner's own key regardless, so "shared with
 * nobody" still means "readable by me."
 * @param {import('@qu/space-core').Space} space
 * @param {{route: string, title: string, template?: string, content?: string, data?: object, recipients?: Array<Uint8Array>}} params -
 *   `recipients` are raw X25519 pubkeys (`ContentResolver.resolveGroup()`'s
 *   own return shape, or an ad-hoc list) - never base64 strings.
 */
export async function createPrivatePage(space, { route, title, template = null, content = '', data = null, recipients = [] } = {}) {
  return space.createNode(privatePageKind, { route, title, template, content, data }, { path: route, recipients });
}

/**
 * Private-page counterpart to `editPage()` - see its own doc comment
 * (including `ownerPub`/the `content` sync-check reasoning, both
 * unchanged here). UNLIKE `createPrivatePage()`, `recipients` has NO
 * default here at all and is REQUIRED the moment this call actually
 * touches an encrypted field (`title`/`template`/`content`/`data`) -
 * there is no "keep the previous audience automatically" option to fall
 * back on, because `recipients` is never stored anywhere, only consulted
 * at WRITE time (`@qu/space-core`'s field.js's own doc comment) - guessing
 * EITHER direction would be a real bug: defaulting to `[]` would silently
 * revoke a whole group's access on the next unrelated edit, defaulting to
 * the full Space membership would silently WIDEN a private page's
 * audience the instant anyone touches it. Pass the SAME (unchanged) or an
 * updated recipient list explicitly every time (`ContentResolver.resolveGroup()`
 * is the usual source). "Does not exist" here is deliberately
 * indistinguishable from "exists, but you are not an authorized reader"
 * (`node.field('title').get()` returns `undefined` for a non-recipient,
 * `null` for genuinely unset - both fail this check the same way) - the
 * correct, privacy-preserving answer either way.
 *
 * NOT RETROACTIVE for a reader who could not decrypt this page's ORIGINAL creation: widening
 * `recipients` here only re-seals the fields THIS call touches - it can never reach `stampMeta()`'s
 * own one-time meta envelope (`@qu/space-core`'s `node.js`), sealed once, at creation, for whoever
 * was a recipient then. A reader outside that original set stays permanently unable to decrypt the
 * meta envelope, and Yjs itself will not integrate ANY later envelope from this Node's original
 * author - however newly re-encrypted for them - while an earlier one in that SAME author's
 * sequence (the meta stamp) stays undecryptable to them (see `@qu/space-core`'s `grant.js`'s own
 * "WRITE-BEFORE-GRANT IS A TRAP" doc comment for the identical gapless-per-author mechanism).
 * Concretely: growing a `groupKind` and re-saving an EXISTING `privatePageKind` with the grown
 * recipient list reaches every member who could ALREADY decrypt that page, live - it does NOT
 * retroactively unlock that same page for a member who joined the group afterward. This is a
 * genuine, correct property (the same "no retroactive decryption of history from before you had a
 * key" guarantee real E2E-encrypted group messaging relies on), not a gap to work around - a new
 * member gets full access to any page `createPrivatePage()`d AFTER they joined instead, since every
 * one of THAT page's envelopes (meta included) is sealed for the CURRENT membership from the start.
 * @param {import('@qu/space-core').Space} space
 * @param {{route: string, title?: string, template?: string, content?: string, data?: object, ownerPub?: Uint8Array, recipients?: Array<Uint8Array>, timeout?: number}} params
 */
export async function editPrivatePage(space, { route, title, template, content, data, ownerPub = space.identity.signingPub, recipients, timeout } = {}) {
  const touchesEncryptedField = title !== undefined || template !== undefined || content !== undefined || data !== undefined;
  if (touchesEncryptedField && recipients === undefined) {
    throw new Error('editPrivatePage: "recipients" is required whenever title/template/content/data changes - there is no automatic "keep the previous audience" (recipients are never stored, only used at write time). Pass the current group\'s members (ContentResolver.resolveGroup()) or whatever list this page should stay visible to, explicitly, every time.');
  }
  const id = await deriveContentNodeId(ownerPub, privatePageKind.kind, route);
  const { node, release } = await space.useNode(id, privatePageKind);
  // Same "an edit's own causal `left` pointer must be built AFTER the field it's overwriting has
  // actually landed, or a later reader can see two genuinely CONCURRENT (unpredictably-ordered)
  // items for that key" hazard `editGroup()`'s own doc comment explains in full - gating on
  // `space.isNodeSynced(id)` here too means every field this Node had before this edit (`template`/
  // `data` included, even though this particular call might only touch `content`) is guaranteed
  // already applied to THIS local doc before any of the writes below run.
  const synced = await waitForSync(async () => {
    if (!space.isNodeSynced(id)) return false;
    const t = await node.field('title').get();
    return t !== null && t !== undefined && node.field('content').get() !== '';
  }, { timeout, space, nodeId: id });
  if (!synced) {
    release();
    throw new Error(`editPrivatePage: page "${route}" does not exist, you are not an authorized reader, or it has not synced within ${timeout ?? 3000}ms - use createPrivatePage() for a genuinely new one`);
  }
  if (title !== undefined) await node.field('title').set(title, { recipients });
  if (template !== undefined) await node.field('template').set(template, { recipients });
  if (content !== undefined) replaceText(node.field('content'), content, { recipients });
  if (data !== undefined) await node.field('data').set(data, { recipients });
  release();
  return node;
}

/**
 * Appends ONE entry to a NAMED shared list (`kinds.js`'s own `sharedListKind`
 * doc comment - a guestbook is the reference use case) - any CURRENT Space
 * member may call this, for ANY `name`, with no prior "create the list"
 * step: `getOrSyncRegistryNode()` (this file's own doc comment on it,
 * already shared by `registerApp()`/`getOrSyncRegistryNode()`'s other
 * callers) transparently creates the Node the FIRST time anyone writes to
 * a given `name`, and simply reuses it every time after - the exact "never
 * blindly `createNode()` over a Node that already exists, just torn down
 * locally between two calls" protection `registerApp()`'s own doc comment
 * explains in full, equally necessary here since MANY different visitors
 * independently calling this for the SAME `name` is the entire point.
 * `entry` is caller-defined (a guestbook might use `{name, message, ts}`) -
 * this Kind imposes no shape on it, same as `groupKind.members`/
 * `platformAppsKind.apps`.
 * @param {import('@qu/space-core').Space} space
 * @param {string} name - which named list (e.g. `'guestbook'`) - see `sharedListAnchor()`.
 * @param {object} entry
 */
export async function pushToSharedList(space, name, entry) {
  const anchor = await sharedListAnchor(name);
  const node = await getOrSyncRegistryNode(space, sharedListKind, anchor);
  await node.field('entries').push(entry);
  return node;
}

/**
 * Creates a View at content-addressed id `deriveContentNodeId(space.
 * identity.signingPub, 'qu-view', name)` - see `createTemplate()`'s own
 * doc comment (registry-free here too: unlike templates/styles, a View
 * has no "list every View this owner has" registry yet, since nothing
 * needs to enumerate them the way a CMS template picker does today - real,
 * separate future work if that's ever needed, not attempted here).
 * `kinds.js`'s own `viewKind` doc comment explains `sources`/`itemTemplate`
 * in full - this is a thin, discoverable wrapper, same shape as every
 * other `create*()` in this file.
 * @param {import('@qu/space-core').Space} space
 * @param {{name: string, sources: Array<{type: string, [k: string]: *}>, sortBy?: string|null, sortOrder?: 'asc'|'desc', limit?: number|null, itemTemplate: string}} params
 */
/**
 * @param {{name: string, route?: string|null, template?: string|null, sources: Array<{type: string, [k: string]: *}>, sortBy?: string|null, sortOrder?: 'asc'|'desc', limit?: number|null, itemTemplate: string}} params -
 *   `route` (optional) makes this View directly visitable, "Views
 *   zusammenklickbar wie bei Drupal" (the user's own framing) - when
 *   given, this ALSO `createPage()`s + `publishRoute()`s a plain wrapper
 *   page at `route` whose entire content is `<div data-qu-view="name">
 *   </div>` (`@qu/app-shell`'s `view-actions.js` hydrates it exactly as it
 *   would for a hand-authored one - a routed View is genuinely nothing
 *   more than this same embed convention, auto-wired). `template`
 *   (optional, only meaningful together with `route`) is that wrapper
 *   page's own `template` name, same as `createPage()`'s own `template`
 *   param - omit for no wrapping template (a bare, unstyled feed).
 *   Omitting `route` entirely (unchanged, pre-existing behavior) creates
 *   an EMBED-ONLY View, meant to be referenced from `<div data-qu-view=
 *   "name">` inside some OTHER, separately-authored page's own content -
 *   the right choice whenever a feed needs to sit alongside other content
 *   (a sidebar, a form on the same page) rather than being the WHOLE page.
 */
export async function createView(space, { name, route = null, template = null, sources, sortBy = null, sortOrder = 'desc', limit = null, itemTemplate }) {
  const node = await space.createNode(viewKind, { sources, sortBy, sortOrder, limit, itemTemplate, route, template }, { path: name });
  if (route) {
    await createPage(space, { route, title: name, template, content: `<div data-qu-view="${name}"></div>` });
    await publishRoute(space, { route, title: name });
  }
  return node;
}

/**
 * Updates an existing View - see `editTemplate()`'s own doc comment
 * (including `ownerPub`) for the full "why never re-`createNode()`"
 * reasoning, identical here. `fields` is a PARTIAL update, same
 * convention `editCollectionItem()` already uses - only keys actually
 * present are written.
 *
 * NOT auto-synced to its wrapper page: unlike `createView()`, this never
 * touches the `route`/`template` wrapper page `createView()` may have
 * made - editing `route` here only changes what THIS View's own record
 * reports (`resolveView()`), it does not move/create/update any page.
 * Real, deliberate scope cut, the same "no rename support" limitation
 * every other `edit*()` in this file already accepts for its own key
 * field - migrating an already-published route safely (old one 404s or
 * redirects? new one needs its own `createPage()`?) is a genuinely
 * separate design question, not attempted here. Setting `route`/`template`
 * on a View that never had one (or changing an existing one) is still a
 * valid partial update, it just won't retroactively create/move the page
 * - call `createPage()`/`publishRoute()` yourself if you need that too.
 */
export async function editView(space, { name, ownerPub = space.identity.signingPub, timeout, ...fields } = {}) {
  const id = await deriveContentNodeId(ownerPub, viewKind.kind, name);
  const { node, release } = await space.useNode(id, viewKind);
  const synced = await waitForSync(() => node.field('itemTemplate').get() !== '', { timeout });
  if (!synced) {
    release();
    throw new Error(`editView: view "${name}" does not exist (or has not synced within ${timeout ?? 3000}ms) - use createView() for a genuinely new one`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'itemTemplate') replaceText(node.field('itemTemplate'), value);
    else await node.field(key).set(value);
  }
  release();
  return node;
}

/**
 * CREATES one item in a Collection (`kinds.js`'s `defineCollectionKind()`)
 * at content-addressed id `deriveContentNodeId(space.identity.signingPub,
 * itemKind.kind, path)` - the exact same self-grant + registry-
 * registration shape `createTemplate()`/`createStyle()` already establish
 * above, generalized to any caller-defined item shape. `path` is the
 * item's own stable key WITHIN the collection (a slug, a numeric id as a
 * string, ...) - not its human-facing title (put that in `fields` instead,
 * e.g. `{title, ...}`, if the item shape has one).
 * @param {import('@qu/space-core').Space} space
 * @param {{itemKind: object, registryKind: object, registryField: string, path: string, fields: object}} params - the first three come straight from `defineCollectionKind()`'s own return value; `fields` are the item's initial field values, matching that Kind's own `fields` declaration.
 */
export async function createCollectionItem(space, { itemKind, registryKind, registryField, path, fields }) {
  const node = await space.createNode(itemKind, fields, { path });
  await registerContentName(space, registryKind, registryField, path);
  return node;
}

/**
 * UPDATES an existing Collection item - see `editTemplate()`'s own doc
 * comment for the full "why never re-`createNode()`" reasoning and the
 * `ownerPub`/granted-co-editor pattern, identical here. `fields` is a
 * PARTIAL update - only keys actually present in it are written, each
 * according to ITS OWN declared shape (`'atomic'` → `field.set()`,
 * `'text'` → `replaceText()`, matching `itemKind.fields[name].shape`).
 * Unlike `editPage()`'s fixed `title`+`content` sync check, a Collection's
 * field set is entirely caller-defined - this waits for ANY ONE of the
 * item's own fields to have a value as its "the Node itself has synced"
 * signal instead.
 * @param {import('@qu/space-core').Space} space
 * @param {{itemKind: object, path: string, fields: object, ownerPub?: Uint8Array, timeout?: number}} params
 */
export async function editCollectionItem(space, { itemKind, path, fields, ownerPub = space.identity.signingPub, timeout } = {}) {
  const id = await deriveContentNodeId(ownerPub, itemKind.kind, path);
  const { node, release } = await space.useNode(id, itemKind);
  const fieldNames = Object.keys(itemKind.fields);
  const synced = await waitForSync(async () => {
    for (const name of fieldNames) {
      const value = await node.field(name).get();
      if (value !== null && value !== undefined && value !== '') return true;
    }
    return false;
  }, { timeout });
  if (!synced) {
    release();
    throw new Error(`editCollectionItem: "${path}" (${itemKind.kind}) does not exist (or has not synced within ${timeout ?? 3000}ms) - use createCollectionItem() for a genuinely new one`);
  }
  for (const [name, value] of Object.entries(fields ?? {})) {
    const field = node.field(name);
    if (typeof field.set === 'function') await field.set(value);
    else if (typeof field.insert === 'function') replaceText(field, value);
    else throw new Error(`editCollectionItem: field "${name}" (shape ${itemKind.fields[name]?.shape}) has no updater`);
  }
  release();
  return node;
}

/**
 * Extends write access to ONE specific piece of `'content'`-ACL content
 * (a page, a template, a style) to ANOTHER identity - "let user X edit
 * exactly this page," the concrete mechanism behind e.g. a relay-admin's
 * "darf dieser User in seinem eigenen Space CMS-Inhalte pflegen" toggle
 * (architecture.md §7). A thin, discoverable wrapper: `space.grantWriter()`
 * (`@qu/space-core`) already does the actual work in one call - this only
 * computes the matching `id` from `(kind, path)` first, so a caller never
 * has to import `deriveContentNodeId` themselves just to grant access.
 * MUST be called by `space`'s OWN identity being the content's actual
 * owner (or an existing grantee - `grantWriter()` doesn't itself check
 * this locally, the relay/every other Space does, see kind-schema.js's
 * own doc comment) - a grant from anyone else is verifiably worthless.
 * @param {import('@qu/space-core').Space} space
 * @param {{kind: object, path: string, granteePub: Uint8Array}} params - `kind` is the Kind-Schema object itself (`pageKind`/`templateKind`/`styleKind`, or an app's own `'content'`-ACL Kind), `path` the SAME route/name the content was created with.
 */
export async function grantContentWriter(space, { kind, path, granteePub }) {
  const id = await deriveContentNodeId(space.identity.signingPub, kind.kind, path);
  return space.grantWriter(id, kind.kind, granteePub, { path });
}

/**
 * Adds one entry to this Space identity's Route Registry (creating it on
 * first call - see kinds.js's `routeRegistryKind` and this file's own
 * `getOrSyncRegistryNode()` doc comment on why that's never a blind
 * `createNode()`) - purely for ENUMERATION (nav/sitemap,
 * `ContentResolver.resolveRoutes()`); a route's Page still resolves
 * independently of this, by direct id derivation (see router.js/
 * resolver.js), so an app remains navigable even if a particular route was
 * never registered here. Unlike `registerContentName()`, never deduplicates
 * by `route` - unchanged, pre-existing behavior (calling this twice for the
 * same route adds two entries).
 */
export async function publishRoute(space, { route, title }) {
  const node = await getOrSyncRegistryNode(space, routeRegistryKind);
  await node.field('routes').push({ route, title });
  return node;
}

/**
 * INSTALLS A WHOLE APP FROM ONE DECLARATIVE BUNDLE (docs §25's "leere App
 * Shell -> ... -> fertige Anwendung," the package-shaped version): a plain
 * object - `{manifest, templates?, styles?, pages?, routes?}` - instead of
 * a sequence of individual `createApp()`/`createTemplate()`/... calls. Not
 * a new mechanism - this is a thin loop over the EXACT SAME functions
 * above, so a bundle is just "the arguments to those calls, written down
 * once" (an ordinary JS/JSON module you can package, version, and reuse -
 * "eine App in ein Package packen," see this package's own README) rather
 * than a bespoke installer script per app.
 *
 * @param {import('@qu/space-core').Space} space - writes as THIS identity - the app-admin for everything the bundle creates (see kinds.js's own doc comment on why `qu-page`/`qu-template`/`qu-style` need this to be a real Space member).
 * @param {{
 *   manifest: {name: string, version?: string, rootTemplate?: string, defaultRoute?: string, theme?: string, metadata?: string},
 *   templates?: Array<{name: string, html: string}>,
 *   styles?: Array<{name: string, css: string}>,
 *   pages?: Array<{route: string, title: string, template?: string, content?: string}>,
 *   routes?: Array<{route: string, title: string}>,
 * }} bundle
 * @returns {Promise<void>}
 */
export async function installAppBundle(space, bundle) {
  await createApp(space, bundle.manifest);
  for (const template of bundle.templates ?? []) await createTemplate(space, template);
  for (const style of bundle.styles ?? []) await createStyle(space, style);
  for (const page of bundle.pages ?? []) await createPage(space, page);
  for (const route of bundle.routes ?? []) await publishRoute(space, route);
}

/**
 * Mounts an already-installed app under a URL path prefix, on the ONE
 * global platform registry (see kinds.js's `platformAppsKind`) - writes as
 * WHICHEVER relay-admin `space`'s own identity is (its `acl.write:
 * 'relay-admins'` ACL accepts any identity `space` was itself constructed
 * with in its own `relayAdmins` list - see `Space`'s own constructor doc
 * comment - and, independently, that the RELAY was booted with the same
 * identity in ITS `relayAdmins` list too; both must agree, same as any
 * other ACL mode). Registering an app here grants it a routing slot only,
 * never write access to anything - the app's own content stays governed
 * entirely by its own `acl.write`/`grantWriter()`. See `platform.js`'s
 * `PlatformRuntime` for how a route gets resolved back through this. This
 * is only ever a PRETTIER ALIAS, never a requirement for reachability: an
 * unregistered app is still reachable at its own owner id (see
 * `platform.js`'s own doc comment on the default, registration-free
 * routing fallback).
 * @param {import('@qu/space-core').Space} space - a relay-admin's own Space (see this function's own doc comment above).
 * @param {{prefix: string, appAdminPub?: Uint8Array, name: string, realm?: 'main'|'global', mode?: 'off'|'global'|'multiuser'}} params
 *   `prefix` is matched against a route's FIRST path segment (no
 *   leading/trailing slash, e.g. `"forum"` for `#/forum/...`).
 *   `realm: 'global'` (default `'main'`) routes this prefix into content
 *   ANY relay-admin collectively administers instead (`appAdminPub` is
 *   ignored/omitted for those entries - a global app has no single owner,
 *   see kinds.js's own "GLOBAL APP CONTENT" doc comment; `prefix` itself IS
 *   the identifier `createGlobalApp()`/etc. anchor their ids on). `mode`
 *   (`realm: 'global'` only, defaults to `'global'` if omitted) - see
 *   kinds.js's own doc comment on the three states; use `setAppMode()`
 *   to change it later for an app already registered.
 */
/**
 * @param {{prefix: string, appAdminPub?: Uint8Array, name: string, realm?: 'main'|'global', mode?: string, sharedLists?: string[], globalViewNames?: string[], personalBundle?: string}} params
 *   `sharedLists` (optional) - every `sharedListKind` NAME (`kinds.js`'s
 *   own doc comment, `pushToSharedList()`) this app's own content uses
 *   (e.g. a Guestbook app registers `[prefix]`, a Forum app registers
 *   `[prefix + ':topics', prefix + ':replies']`) - `@qu/app-shell`'s
 *   `live-app-resolver.js` collects this across EVERY registered app and
 *   feeds it to `createAppResolveKindSchema()`'s own `sharedListNames`
 *   param, the SAME "no relay restart needed" fix `appAdminPub`/`realm:
 *   'global'` already get for their own Kinds - a shared list's id is
 *   anchored on a HASH OF ITS NAME (`relay-resolver.js`'s own doc comment
 *   on why), so unlike an owner-derived id, the relay has no way to
 *   classify a name it was never told about, even dynamically. Omit
 *   entirely for an app that uses no shared lists at all (unchanged
 *   behavior - every existing caller of this function keeps working).
 *
 *   `globalViewNames` (optional, `realm: 'global'` only) - every
 *   `adminViewKind` NAME this global app's own content uses (e.g. a
 *   Guestbook app registers `[prefix + '-feed']`) - the SAME reasoning as
 *   `sharedLists` above, one Kind over: unlike `pageRoutes` (discovered
 *   LIVE by `live-app-resolver.js` watching the app's own route registry,
 *   `kinds.js`'s own `adminRouteRegistryKind` doc comment), a View has no
 *   registry of its own to watch (`createView()`'s own doc comment: "no
 *   'list every View this owner has' registry yet") - so its name has to be
 *   told to the relay up front, right here, the one place it's already
 *   known (the installer choosing this app's own fixed set of View names).
 *
 *   `personalBundle` (optional, `realm: 'global'` only) - a free-form tag
 *   (e.g. `'guestbook'`/`'blog'`) naming WHICH reference app this prefix
 *   is, so `@qu/app-shell`'s `boot.js`/`installed-apps-actions.js` know
 *   which content to self-provision the FIRST time a visitor reaches their
 *   own `#/<prefix>/u/me/` - see `boot.js`'s own doc comment on this
 *   ADDITIVE personal route (never replaces what the bare prefix means,
 *   unlike `mode: 'multiuser'`, which is a different, older mechanism for
 *   a related but distinct need). Omit for a global app with no personal-
 *   instance story at all (the built-in admin console, or any custom app) -
 *   `#/<prefix>/u/me/` then simply resolves nothing, same as today.
 */
export async function registerApp(space, { prefix, appAdminPub, name, realm = 'main', mode, sharedLists, globalViewNames, personalBundle }) {
  // getOrSyncRegistryNode(), not a blind `space.getNode(id) ?? createNode()` - the SAME "never
  // re-createNode() over a Node that already exists, just torn down locally between two calls"
  // reasoning that function's own doc comment already documents for an app's per-owner registries -
  // this ONE global registry is no different: any caller in between (a mode-toggle UI's own
  // `PlatformRuntime.resolveApps()` refresh, another relay-admin's read, ...) may have already
  // useNode()+release()d it, tearing the local Y.Doc back down (`createNode()` never refcounts its
  // own creation - see `boot.js`'s `ensureSelfProvisioned()` doc comment for the general shape of
  // this bug). Blindly `createNode()`ing again in that window would silently wipe every OTHER
  // relay-admin's already-registered app out of THIS write's local view of `apps` until a resync
  // caught up - a real, observed failure (reproduced via the admin console's own mode-toggle
  // buttons calling `setAppMode()` right after a `resolveApps()` refresh).
  const node = await getOrSyncRegistryNode(space, platformAppsKind, PLATFORM_REGISTRY_ANCHOR);
  const entry = { prefix, appAdminPub: appAdminPub ? QuCrypto.toBase64(appAdminPub) : null, name, realm };
  if (realm === 'global' && mode) entry.mode = mode;
  if (sharedLists?.length) entry.sharedLists = sharedLists;
  if (realm === 'global' && globalViewNames?.length) entry.globalViewNames = globalViewNames;
  if (realm === 'global' && personalBundle) entry.personalBundle = personalBundle;
  await node.field('apps').push(entry);
  return node;
}

/**
 * Changes an ALREADY-REGISTERED `realm: 'global'` app's `mode` (kinds.js's
 * own doc comment on the three administrable states: `'off'`/`'global'`/
 * `'multiuser'`) - reads the CURRENT entry for `prefix` (the last one in
 * the log - `platform.js`'s `resolveApps()` own "last write wins"
 * dedup) and re-pushes it with only `mode` changed, `name`/`appAdminPub`
 * carried over unchanged. `qu-platform-apps`'s own `ListField` has no
 * update/removal primitive (kinds.js's own "ONLY ADDITIVE" doc comment) -
 * "updating" state here always means "push a newer entry for the same
 * prefix," never mutating anything in place.
 * @param {import('@qu/space-core').Space} space - a relay-admin's own Space.
 * @param {{prefix: string, mode: 'off'|'global'|'multiuser'}} params
 */
export async function setAppMode(space, { prefix, mode }) {
  const node = await getOrSyncRegistryNode(space, platformAppsKind, PLATFORM_REGISTRY_ANCHOR); // see registerApp()'s own doc comment on why never a blind getNode() ?? createNode() here.
  const apps = (await node.field('apps').toArray()).filter(Boolean);
  const current = [...apps].reverse().find((a) => a.prefix === prefix);
  if (!current) throw new Error(`setAppMode: "${prefix}" is not a registered app - registerApp() it first.`);
  if ((current.realm ?? 'main') !== 'global') {
    throw new Error(`setAppMode: "${prefix}" is realm "${current.realm ?? 'main'}" - mode only applies to realm:'global' apps.`);
  }
  await node.field('apps').push({ ...current, mode });
  return node;
}

/**
 * GLOBAL APP DEV API — the exact same shape as `createApp()`/
 * `createTemplate()`/`createStyle()`/`createPage()`/`installAppBundle()`
 * above, writing the `qu-admin-*` Kinds (kinds.js) at ids anchored on
 * `globalAppAnchor(prefix)` instead of a real app-admin's pubkey - `prefix`
 * is the SAME string this app is (or will be) `registerApp()`ed under with
 * `realm: 'global'`, disambiguating one global app's content from another's
 * (see kinds.js's own "GLOBAL APP CONTENT" doc comment - these functions
 * are NOT specific to the one built-in admin console any more; that console
 * is simply whichever caller passes `prefix: 'admin'`, same as
 * `bin/install-admin-console.mjs` does). `acl.write: 'relay-admins'` on
 * every `qu-admin-*` Kind means these calls succeed for ANY identity
 * listed in the relay's own `QU_RELAY_ADMINS` (checked independently by
 * both `space` itself and the relay - never just this file's say-so) -
 * `space` is the SAME ordinary main Space any visitor connects to, no
 * separate confidential realm/transport to bootstrap first, and no
 * separate identity to generate/import either: whichever identity `space`
 * already uses (an operator's own already-existing browser/CLI identity,
 * the moment its pubkey is a configured relay-admin) can call these
 * directly, for ANY global app, not just one it happened to create itself.
 */
export async function createGlobalApp(space, prefix, { name, version = '1.0', rootTemplate = null, defaultRoute = '/', theme = null, metadata = '' }) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveOwnerNodeId(anchor, adminAppManifestKind.kind);
  return space.createNode(adminAppManifestKind, { name, version, rootTemplate, defaultRoute, theme, metadata }, { id });
}

/**
 * Global-app counterpart to `createTemplate()` - see `createGlobalApp()`'s
 * own doc comment on `prefix`. UNLIKE `createGlobalPage()`, this has no
 * registry `@qu/app-shell`'s `live-app-resolver.js` watches yet (kinds.js's
 * own "GLOBAL APP CONTENT" doc comment - "TEMPLATES/STYLES stay a smaller,
 * more static set... a deliberate, separate scope boundary"), so a relay
 * only classifies THIS write correctly if `name` is in the STATIC
 * `templateNames` list `createAppResolveKindSchema()` was configured with
 * for `prefix` - true for the built-in admin console (`['main']`, its
 * OWN default) but NOT for any other, dynamically-registered global app
 * unless a deployment wires its own static list. Calling this for a
 * dynamically-registered global app's non-default template name will
 * silently fail (the relay misclassifies it against the ordinary
 * `'content'`-ACL fallback and rejects the write) until that gap is
 * closed - real, separate future work, not attempted in this pass.
 */
export async function createGlobalTemplate(space, prefix, { name, html }) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminTemplateKind.kind, name);
  return space.createNode(adminTemplateKind, { html }, { id });
}

/** Global-app counterpart to `createStyle()` - see `createGlobalTemplate()`'s own doc comment (including its "not yet dynamically discoverable" caveat - identical here for `styleNames`). */
export async function createGlobalStyle(space, prefix, { name, css }) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminStyleKind.kind, name);
  return space.createNode(adminStyleKind, { css }, { id });
}

/** Global-app counterpart to `createPage()` - see `createGlobalApp()`'s own doc comment on `prefix`. */
export async function createGlobalPage(space, prefix, { route, title, template = null, content = '' }) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminPageKind.kind, route);
  return space.createNode(adminPageKind, { route, title, template, content }, { id });
}

/** Global-app counterpart to `installAppBundle()` - see that function's own doc comment; identical shape, writes the `qu-admin-*` Kinds via the four functions just above, all anchored on `prefix` (see `createGlobalApp()`'s own doc comment). No `routes`/route-registry counterpart yet - not needed for the built-in admin console's one page (see this package's own README on the reference bundle). */
export async function installGlobalAppBundle(space, prefix, bundle) {
  await createGlobalApp(space, prefix, bundle.manifest);
  for (const template of bundle.templates ?? []) await createGlobalTemplate(space, prefix, template);
  for (const style of bundle.styles ?? []) await createGlobalStyle(space, prefix, style);
  for (const page of bundle.pages ?? []) await createGlobalPage(space, prefix, page);
}

/**
 * UPDATES an existing global app's template - see `editTemplate()`'s own
 * doc comment for the full "why never re-`createNode()`" reasoning
 * (identical here, just against `adminTemplateKind` instead of
 * `templateKind`); `prefix` (not `ownerPub`) identifies WHICH global app's
 * content this targets - see `createGlobalApp()`'s own doc comment. Unlike
 * `editTemplate()`, there is no single "owner" to default to: ANY
 * currently-configured relay-admin may call this for ANY global app,
 * exactly the point of `acl.write: 'relay-admins'`.
 */
export async function editGlobalTemplate(space, prefix, { name, html, timeout } = {}) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminTemplateKind.kind, name);
  const { node, release } = await space.useNode(id, adminTemplateKind);
  const synced = await waitForSync(() => node.field('html').get() !== '', { timeout });
  if (!synced) {
    release();
    throw new Error(`editGlobalTemplate: template "${name}" (global app "${prefix}") does not exist (or has not synced within ${timeout ?? 3000}ms) - use createGlobalTemplate() for a genuinely new one`);
  }
  replaceText(node.field('html'), html);
  release();
  return node;
}

/** Global-app counterpart to `editStyle()` - see `editGlobalTemplate()`'s own doc comment. */
export async function editGlobalStyle(space, prefix, { name, css, timeout } = {}) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminStyleKind.kind, name);
  const { node, release } = await space.useNode(id, adminStyleKind);
  const synced = await waitForSync(() => node.field('css').get() !== '', { timeout });
  if (!synced) {
    release();
    throw new Error(`editGlobalStyle: style "${name}" (global app "${prefix}") does not exist (or has not synced within ${timeout ?? 3000}ms) - use createGlobalStyle() for a genuinely new one`);
  }
  replaceText(node.field('css'), css);
  release();
  return node;
}

/** Global-app counterpart to `editPage()` - see `editGlobalTemplate()`'s own doc comment, and `editPage()`'s own on the per-field update semantics (only fields actually passed are updated). */
export async function editGlobalPage(space, prefix, { route, title, template, content, data, timeout } = {}) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminPageKind.kind, route);
  const { node, release } = await space.useNode(id, adminPageKind);
  const synced = await waitForSync(async () => {
    const t = await node.field('title').get();
    return t !== '' && node.field('content').get() !== '';
  }, { timeout });
  if (!synced) {
    release();
    throw new Error(`editGlobalPage: page "${route}" (global app "${prefix}") does not exist (or has not synced within ${timeout ?? 3000}ms) - use createGlobalPage() for a genuinely new one`);
  }
  if (title !== undefined) await node.field('title').set(title);
  if (template !== undefined) await node.field('template').set(template);
  if (content !== undefined) replaceText(node.field('content'), content);
  if (data !== undefined) await node.field('data').set(data);
  release();
  return node;
}

/**
 * Global-app counterpart to `publishRoute()` - adds one entry to `prefix`'s
 * OWN route registry (`adminRouteRegistryKind`, `acl.write: 'relay-admins'`
 * - kinds.js's own doc comment on why this needs a DIFFERENT registry Kind
 * from `routeRegistryKind`, not just a different anchor: several
 * relay-admins share ONE registry here, with no single self-certifying
 * owner). Unlike `publishRoute()`, THIS registry is also what
 * `@qu/app-shell`'s `live-app-resolver.js` watches to reclassify a
 * brand-new global page's write correctly WITHOUT a relay restart (see
 * that file's own doc comment) - so for a global app, calling this is not
 * merely a sitemap/enumeration nicety, it is what makes a genuinely NEW
 * route reachable at all the first time any relay-admin creates it.
 * Deduplicates by `route`, unlike `publishRoute()`'s own unchanged
 * "never deduplicates" behavior - safe here since every caller for a given
 * route is functionally interchangeable (any relay-admin), so a second
 * call for the same route is always a harmless no-op, never a meaningful
 * "second announcement" the way it might be for an independently-owned app.
 */
export async function publishGlobalRoute(space, prefix, { route, title }) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const node = await getOrSyncRegistryNode(space, adminRouteRegistryKind, anchor);
  const existing = await node.field('routes').toArray();
  if (!existing.some((entry) => entry?.route === route)) await node.field('routes').push({ route, title });
  return node;
}

/**
 * Global-app counterpart to `createView()` - `kinds.js`'s own `adminViewKind`
 * doc comment on why this Kind exists at all (a `realm: 'global'` app's
 * View, anchored on `globalAppAnchor(prefix)` instead of a real owner
 * identity, so several independently-installed global apps' Views never
 * collide the way two `realm: 'main'` apps sharing ONE relay-admin's own
 * identity would - kinds.js's own doc comment has the full "real, observed
 * bug" story). Same `route`/`template` auto-wrapper-page behavior as
 * `createView()`, just through `createGlobalPage()`/`publishGlobalRoute()`
 * instead of their self-owned counterparts - INCLUDING `wirePages()`'s own
 * global-mode ORDERING requirement (`@qu/app-shell`'s `cms-actions.js`'s
 * own doc comment on it, in full): `publishGlobalRoute()` FIRST, a short
 * settle wait, THEN `createGlobalPage()` - `@qu/app-shell`'s
 * `live-app-resolver.js` only classifies a global app's page write
 * correctly once it has observed the route in `adminRouteRegistryKind`;
 * creating the page first races that reactive rebuild and is silently
 * rejected (no grant/classification for the id exists yet).
 * `createView()`'s own "page then route" order is safe ONLY for `realm:
 * 'main'` apps (self-owned `'content'`-ACL, classified by OWNER alone, no
 * per-route registration needed) - never copy that order here.
 */
export async function createGlobalView(space, prefix, { name, route = null, template = null, sources, sortBy = null, sortOrder = 'desc', limit = null, itemTemplate }) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminViewKind.kind, name);
  const node = await space.createNode(adminViewKind, { sources, sortBy, sortOrder, limit, itemTemplate, route, template }, { id });
  if (route) {
    await publishGlobalRoute(space, prefix, { route, title: name });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await createGlobalPage(space, prefix, { route, title: name, template, content: `<div data-qu-view="${name}"></div>` });
  }
  return node;
}

/** Global-app counterpart to `editView()` - see `editGlobalTemplate()`'s own doc comment (including the "no rename support"/"never touches the wrapper page" caveats `editView()`'s own doc comment already explains, identical here). */
export async function editGlobalView(space, prefix, { name, timeout, ...fields } = {}) {
  const anchor = await cachedGlobalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminViewKind.kind, name);
  const { node, release } = await space.useNode(id, adminViewKind);
  const synced = await waitForSync(() => node.field('itemTemplate').get() !== '', { timeout });
  if (!synced) {
    release();
    throw new Error(`editGlobalView: view "${name}" (global app "${prefix}") does not exist (or has not synced within ${timeout ?? 3000}ms) - use createGlobalView() for a genuinely new one`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'itemTemplate') replaceText(node.field('itemTemplate'), value);
    else await node.field(key).set(value);
  }
  release();
  return node;
}
