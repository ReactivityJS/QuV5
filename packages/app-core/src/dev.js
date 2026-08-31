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
import { deriveOwnerNodeId } from '@qu/space-core';
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
  platformAppsKind,
  adminAppManifestKind,
  adminPageKind,
  adminTemplateKind,
  adminStyleKind,
  ADMIN_REALM_ANCHOR,
} from './kinds.js';

/** Polls `checkFn` (may itself be async - `'atomic'`-shape fields' own `.get()` is a Promise, `'text'`-shape's is not, see field.js) until it returns truthy or `timeout` elapses - local here (not imported from resolver.js) so this file stays independent of that one; same shape as its own `waitFor()`. Used only by the `edit*()` functions below, to make sure a Node this Space hasn't seen before has actually finished syncing (its founding grant included - see kind-schema.js's own "THE 'content' ACL mode" doc comment) before writing to it. */
async function waitForSync(checkFn, { timeout = 3000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await checkFn()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** A `'text'`-shape field (field.js's `TextField`) has no `set()` - only `get()`/`insert()`/`delete()` (real Y.Text, collaborative-editing-shaped) - so "replace the whole value" is delete-everything-then-insert, two ordinary local mutations, not one. Both are synchronous/fire-and-forget on the field itself (see field.js) - the resulting Yjs updates still seal/send exactly like any other write, just as two envelopes instead of one. */
function replaceText(field, value) {
  const current = field.get();
  if (current) field.delete(0, current.length);
  if (value) field.insert(0, value);
}

/** Creates (or overwrites) this Space identity's App Manifest - see kinds.js's `appManifestKind`. */
export async function createApp(space, { name, version = '1.0', rootTemplate = null, defaultRoute = '/', theme = null, metadata = '' }) {
  return space.createNode(appManifestKind, { name, version, rootTemplate, defaultRoute, theme, metadata });
}

/** One entry, deduplicated by `name` - shared by `createTemplate()`/`createStyle()` below so a caller never has to remember a separate "publish" call the way `qu-page`'s own `publishRoute()` historically needed (kept separate, unchanged, for backward compatibility). */
async function registerContentName(space, registryKind, fieldName, name) {
  const id = await deriveOwnerNodeId(space.identity.signingPub, registryKind.kind);
  const node = space.getNode(id) ?? (await space.createNode(registryKind, {}, { id }));
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

/** Creates a page at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-page', route)` - see `createTemplate()`'s own doc comment. `template` is a template NAME (resolved via content-id.js at render time), not a Node id. Does NOT auto-register into `routeRegistryKind` (unlike `createTemplate()`/`createStyle()`'s own registries) - call `publishRoute()` separately, unchanged pre-existing behavior. */
export async function createPage(space, { route, title, template = null, content = '' }) {
  return space.createNode(pageKind, { route, title, template, content }, { path: route });
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

/** Page counterpart to `editTemplate()` - see its own doc comment (including `ownerPub`). Only fields actually passed are updated; omit `title`/`template`/`content` to leave them unchanged. `title`/`template` are `'atomic'`-shape (`field.set()`); `content` is `'text'`-shape, see `replaceText()`'s own doc comment. */
export async function editPage(space, { route, title, template, content, ownerPub = space.identity.signingPub, timeout } = {}) {
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
 * first call - see kinds.js's `routeRegistryKind`) - purely for
 * ENUMERATION (nav/sitemap, `ContentResolver.resolveRoutes()`); a route's
 * Page still resolves independently of this, by direct id derivation (see
 * router.js/resolver.js), so an app remains navigable even if a particular
 * route was never registered here.
 */
export async function publishRoute(space, { route, title }) {
  const id = await deriveOwnerNodeId(space.identity.signingPub, routeRegistryKind.kind);
  const node = space.getNode(id) ?? (await space.createNode(routeRegistryKind, {}, { id }));
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
 * Mounts an already-installed app under a URL path prefix, on THIS
 * identity's own platform registry (see kinds.js's `platformAppsKind`) -
 * writes as the RELAY-ADMIN, a role separate from any app's own app-admin
 * (docs §19-20): registering an app here grants it a routing slot only,
 * never write access to anything - the app's own content stays governed
 * entirely by its own `acl.write`/`grantWriter()`. See `platform.js`'s
 * `PlatformRuntime` for how a route gets resolved back through this. This
 * is only ever a PRETTIER ALIAS, never a requirement for reachability: an
 * unregistered app is still reachable at its own owner id (see
 * `platform.js`'s own doc comment on the default, registration-free
 * routing fallback).
 * @param {import('@qu/space-core').Space} space - the relay-admin's own Space (the `qu-platform-apps` owner - the alias registry's writer, NOT necessarily an admin-realm member; see this file's own admin-realm functions below for that separate, confidential realm).
 * @param {{prefix: string, appAdminPub?: Uint8Array, name: string, realm?: 'main'|'admin'}} params
 *   `prefix` is matched against a route's FIRST path segment (no
 *   leading/trailing slash, e.g. `"forum"` for `#/forum/...`).
 *   `realm: 'admin'` (default `'main'`) routes this prefix into the
 *   confidential admin realm instead (`appAdminPub` is ignored/omitted for
 *   those entries - the admin realm has no single owner, see kinds.js's
 *   own "THE ADMIN REALM" doc comment).
 */
export async function registerApp(space, { prefix, appAdminPub, name, realm = 'main' }) {
  const id = await deriveOwnerNodeId(space.identity.signingPub, platformAppsKind.kind);
  const node = space.getNode(id) ?? (await space.createNode(platformAppsKind, {}, { id }));
  await node.field('apps').push({ prefix, appAdminPub: appAdminPub ? QuCrypto.toBase64(appAdminPub) : null, name, realm });
  return node;
}

/**
 * ADMIN-REALM DEV API — the exact same shape as `createApp()`/
 * `createTemplate()`/`createStyle()`/`createPage()`/`installAppBundle()`
 * above, writing the `qu-admin-*` Kinds (kinds.js) at ids anchored on the
 * fixed `ADMIN_REALM_ANCHOR` instead of a real app-admin's pubkey - there
 * is only ONE admin realm per relay, so no per-owner disambiguation is
 * needed (see kinds.js's own "THE ADMIN REALM" doc comment). `acl.write:
 * 'members'` on every `qu-admin-*` Kind means these calls succeed for ANY
 * identity that is a member of the admin-only Space `space` is connected
 * to - there is no separate "admin-realm-admin" role to bootstrap first.
 * Confidentiality comes entirely from WHICH Space `space` is connected to
 * (its `members` list), never from anything in this file - see
 * `packages/app-shell/relay-server.js`'s own "ADMIN REALM" doc comment.
 */
export async function createAdminApp(space, { name, version = '1.0', rootTemplate = null, defaultRoute = '/', theme = null, metadata = '' }) {
  const id = await deriveOwnerNodeId(ADMIN_REALM_ANCHOR, adminAppManifestKind.kind);
  return space.createNode(adminAppManifestKind, { name, version, rootTemplate, defaultRoute, theme, metadata }, { id });
}

/** Admin-realm counterpart to `createTemplate()`. */
export async function createAdminTemplate(space, { name, html }) {
  const id = await deriveContentNodeId(ADMIN_REALM_ANCHOR, adminTemplateKind.kind, name);
  return space.createNode(adminTemplateKind, { html }, { id });
}

/** Admin-realm counterpart to `createStyle()`. */
export async function createAdminStyle(space, { name, css }) {
  const id = await deriveContentNodeId(ADMIN_REALM_ANCHOR, adminStyleKind.kind, name);
  return space.createNode(adminStyleKind, { css }, { id });
}

/** Admin-realm counterpart to `createPage()`. */
export async function createAdminPage(space, { route, title, template = null, content = '' }) {
  const id = await deriveContentNodeId(ADMIN_REALM_ANCHOR, adminPageKind.kind, route);
  return space.createNode(adminPageKind, { route, title, template, content }, { id });
}

/** Admin-realm counterpart to `installAppBundle()` - see that function's own doc comment; identical shape, writes the `qu-admin-*` Kinds via the four functions just above. No `routes`/route-registry counterpart yet - not needed for the one built-in admin console page (see this package's own README on the reference bundle). */
export async function installAdminAppBundle(space, bundle) {
  await createAdminApp(space, bundle.manifest);
  for (const template of bundle.templates ?? []) await createAdminTemplate(space, template);
  for (const style of bundle.styles ?? []) await createAdminStyle(space, style);
  for (const page of bundle.pages ?? []) await createAdminPage(space, page);
}
