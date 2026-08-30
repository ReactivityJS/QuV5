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
import { deriveContentNodeId } from './content-id.js';
import { appManifestKind, routeRegistryKind, pageKind, templateKind, styleKind } from './kinds.js';

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
