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
import { appManifestKind, routeRegistryKind, pageKind, templateKind, styleKind } from './kinds.js';

const DEFAULT_KINDS = { appManifestKind, routeRegistryKind, pageKind, templateKind, styleKind };

/** Polls `checkFn` until it returns a non-null/non-undefined value, or `timeout` elapses (then returns `null`). Local-first: usually resolves on the very first check when content is already in local storage. */
async function waitFor(checkFn, { timeout = 4000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await checkFn();
    if (value !== null && value !== undefined) return value;
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
   *   `platform.js`'s admin-realm resolution passes the `qu-admin-*`
   *   variants (`kinds.js`'s own "THE ADMIN REALM" doc comment) instead,
   *   together with the fixed `ADMIN_REALM_ANCHOR` as `appAdminPub` - every
   *   id-derivation call below is unchanged either way, only WHICH Kind
   *   (and therefore which envelope visibility/ACL) it resolves against.
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
    const manifest = await waitFor(async () => {
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
    await waitFor(() => (node.field('routes').length > 0 ? true : null), { timeout: timeout ?? 500 });
    const routes = await node.field('routes').toArray();
    release();
    return routes.filter(Boolean);
  }

  /** @param {string} route @returns {Promise<{route, title, template, content}|null>} `null` if this route has no published page (or it hasn't synced within `timeout`) - the Router's signal to render a 404. */
  async resolvePage(route, { timeout } = {}) {
    const pageKind = this._kinds.pageKind;
    const id = await deriveContentNodeId(this._appAdminPub, pageKind.kind, route);
    const { node, release } = await this._space.useNode(id, pageKind);
    const page = await waitFor(async () => {
      const title = await node.field('title').get();
      const content = node.field('content').get();
      // Wait for BOTH: `title`/`content` are written as SEPARATE envelopes (see kinds.js/node.js's
      // own doc comments) - a Node id's very existence (title synced) does not mean every OTHER
      // field synced too, especially over a real network. Same "empty string reads as not-yet-
      // synced" tradeoff resolveTemplate()/resolveStyle() below already accept for their own single
      // field - a genuinely empty page body is a rare enough edge case not worth resolving here.
      if (!title || !content) return null;
      const template = await node.field('template').get();
      return { route, title, template, content };
    }, { timeout });
    release();
    return page;
  }

  /** @param {string} name @returns {Promise<string|null>} A template's HTML, or `null` if unpublished/unsynced within `timeout`. */
  async resolveTemplate(name, { timeout } = {}) {
    const templateKind = this._kinds.templateKind;
    const id = await deriveContentNodeId(this._appAdminPub, templateKind.kind, name);
    const { node, release } = await this._space.useNode(id, templateKind);
    const html = await waitFor(() => {
      const value = node.field('html').get();
      return value ? value : null;
    }, { timeout });
    release();
    return html;
  }

  /** @param {string} name @returns {Promise<string|null>} A stylesheet's CSS, or `null` if unpublished/unsynced within `timeout`. */
  async resolveStyle(name, { timeout } = {}) {
    if (!name) return null;
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
    const css = await waitFor(() => {
      const value = node.field('css').get();
      return value !== '' ? value : null;
    }, { timeout: timeout ?? 2000 });
    release();
    return css ?? '';
  }
}
