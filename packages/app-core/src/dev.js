/**
 * DEV / ADMIN API — bootstraps an empty Space into a working app (docs
 * §25): thin wrappers around `Space.createNode()`, nothing more. Every
 * function here writes AS `space`'s own identity - that identity IS the
 * app-admin for whatever it creates (see kinds.js's own doc comment on why
 * `qu-page`/`qu-template`/`qu-style` are `'members'`-ACL: this is what lets
 * `createNode()` honor the content-addressed `id` these functions compute).
 * A reader elsewhere (`ContentResolver`) must be told that SAME identity's
 * pubkey as `appAdminPub` to find anything these functions create.
 */
import { deriveOwnerNodeId } from '@qu/space-core';
import { QuCrypto } from '@qu/core';
import { deriveContentNodeId } from './content-id.js';
import { appManifestKind, routeRegistryKind, pageKind, templateKind, styleKind, platformAppsKind } from './kinds.js';

/** Creates (or overwrites) this Space identity's App Manifest - see kinds.js's `appManifestKind`. */
export async function createApp(space, { name, version = '1.0', rootTemplate = null, defaultRoute = '/', theme = null, metadata = '' }) {
  return space.createNode(appManifestKind, { name, version, rootTemplate, defaultRoute, theme, metadata });
}

/** Creates a template at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-template', name)`. */
export async function createTemplate(space, { name, html }) {
  const id = await deriveContentNodeId(space.identity.signingPub, templateKind.kind, name);
  return space.createNode(templateKind, { html }, { id });
}

/** Creates a stylesheet at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-style', name)`. */
export async function createStyle(space, { name, css }) {
  const id = await deriveContentNodeId(space.identity.signingPub, styleKind.kind, name);
  return space.createNode(styleKind, { css }, { id });
}

/** Creates a page at content-addressed id `deriveContentNodeId(space.identity.signingPub, 'qu-page', route)`. `template` is a template NAME (resolved via content-id.js at render time), not a Node id. */
export async function createPage(space, { route, title, template = null, content = '' }) {
  const id = await deriveContentNodeId(space.identity.signingPub, pageKind.kind, route);
  return space.createNode(pageKind, { route, title, template, content }, { id });
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
 * `PlatformRuntime` for how a route gets resolved back through this.
 * @param {import('@qu/space-core').Space} space - the relay-admin's own Space.
 * @param {{prefix: string, appAdminPub: Uint8Array, name: string}} params - `prefix` is matched against a route's FIRST path segment (no leading/trailing slash, e.g. `"forum"` for `#/forum/...`).
 */
export async function registerApp(space, { prefix, appAdminPub, name }) {
  const id = await deriveOwnerNodeId(space.identity.signingPub, platformAppsKind.kind);
  const node = space.getNode(id) ?? (await space.createNode(platformAppsKind, {}, { id }));
  await node.field('apps').push({ prefix, appAdminPub: QuCrypto.toBase64(appAdminPub), name });
  return node;
}
