/**
 * APP BUNDLE SCAFFOLD — `defineAppBundle(descriptor)` is the one place a
 * reference app's `install`/`update` pair (GLOBAL and, optionally,
 * PERSONAL) gets built FROM a single content declaration, so the two can
 * never drift apart again - a real, shipped bug: `forum-bundle.js` had
 * `installForum()` but no `updateForum()`/`FORUM_VERSION` at all, so an
 * already-installed Forum had no "Update verfügbar" path whatsoever (see
 * `architecture.md`'s own "UPDATE - FORUM'S MISSING UPDATE PATH" note).
 * Writing a NEW reference app through this file makes that specific
 * omission structurally impossible - `defineAppBundle()` always returns
 * `update` (and `install`, when `route` is given) TOGETHER, from the exact
 * same `content()` declaration, never two hand-written functions that can
 * silently diverge.
 *
 * GLOBAL install vs. update differ in exactly ONE thing: a GLOBAL app's
 * very FIRST install must `publishGlobalRoute()` and then WAIT
 * (`live-app-resolver.js` only classifies a page write correctly once it
 * has observed the route) before writing the page - an already-registered
 * route (every `update()` call, by definition) never needs that wait. Both
 * ALWAYS write via `bundle-upsert.js`'s edit-first, create-as-fallback
 * helpers (never a raw `create*()`) - a real, previously-shipped bug
 * (`installX()` calling `create*()` directly used to 404 after
 * "Deinstallieren" + reinstalling the SAME prefix, since the underlying
 * page/View ids were never actually freed - `nullGlobalAppContent()`'s own
 * "not a genuine deletion" doc comment) is what upsert-everywhere on the
 * GLOBAL side fixes for good.
 *
 * PERSONAL install vs. update differ the OPPOSITE way: a personal instance
 * is self-provisioned (`installed-apps-actions.js`'s `provisionPersonalInstance()`)
 * ONLY when no page exists yet there at all - genuinely, unconditionally
 * fresh every time `install` runs (there is no "Deinstallieren" for a
 * personal instance to ever need re-creating over), so `install` writes
 * via plain `create*()` (fast, no doomed edit-first attempt), while
 * `update` (a visitor's own explicit "Update verfügbar" click on their
 * ALREADY-existing instance) goes through the SAME safe upsert helpers the
 * global side always uses. No route-registration wait either way - a
 * personal page is SELF-CERTIFYING `'content'`-ACL (`deriveContentNodeId
 * (ownerPub, kind, path)`), with no relay-side "route must be seen first"
 * classification step the way `adminPageKind`'s `'relay-admins'`-ACL has.
 *
 * `bareRouteModes` — WHICH non-`'off'` `qu-platform-apps.mode` values this
 * app's bare `#/<prefix>/` route actually supports, DECLARED here instead
 * of INFERRED reactively at the admin console's own render time. This
 * replaces a real gap the previous inference-based `unsupportedModes()`
 * had: an app with no `viewNames` entry at all (the built-in admin console
 * itself, before this) silently skipped the "does this app build an
 * aggregate feed" check entirely (`viewNames && !viewNames.some(...)`
 * short-circuits to `false` when `viewNames` is `undefined`) rather than
 * correctly concluding "no views declared, so no aggregate feed possible" -
 * `'personal'` mode was reachable for it, showing a permanently-empty
 * aggregate feed once selected. A bundle that simply declares
 * `bareRouteModes: ['global', 'multiuser']` (no `'personal'`) cannot have
 * this gap - there is no inference step left to have a blind spot in.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER: `wireX()` interactivity
 * (`guestbook-actions.js`/`blog-actions.js`/`forum-actions.js`) - a form's
 * submit handling, live re-render wiring, and similar per-app DOM behavior
 * stay genuinely app-specific hand-written code, registered once into
 * `installed-apps-actions.js`'s own `wireInstalledApps()` - a generic
 * content scaffold has no business swallowing that. `boot.js`'s own
 * routing dispatch (what each `mode` value actually RENDERS) is likewise
 * untouched - `bareRouteModes` only narrows which values the admin console
 * ever lets a relay-admin SELECT, never what a selected mode does.
 */
import { publishGlobalRoute, publishRoute, createPage, createView } from '@qu/app-core';
import { QuCrypto } from '@qu/core';
import { upsertGlobalPage, upsertGlobalView, upsertGlobalTemplate, upsertPage, upsertView } from './bundle-upsert.js';

const GLOBAL_UPSERTERS = { page: upsertGlobalPage, view: upsertGlobalView, template: upsertGlobalTemplate };
const PERSONAL_WRITERS = {
  fresh: { page: createPage, view: createView },
  safe: { page: upsertPage, view: upsertView },
};

/**
 * Applies a `{kind, fields}` content-item array against a GLOBAL prefix, via the matching
 * `bundle-upsert.js` helper - the one loop `defineAppBundle()`'s own `install()`/`update()` share,
 * also usable directly for content shaped OUTSIDE this file's own descriptor convention (see
 * `admin-console-bundle.js`'s `updateAdminConsole()`, which maps its own pre-existing
 * `{templates, pages}` object into this same item shape rather than duplicating this loop by hand).
 * @param {import('@qu/space-core').Space} space @param {string} prefix
 * @param {Array<{kind: 'page'|'view'|'template', fields: object}>} items
 */
export async function applyGlobalContent(space, prefix, items) {
  for (const item of items) {
    const upsert = GLOBAL_UPSERTERS[item.kind];
    if (!upsert) throw new Error(`applyGlobalContent: unknown content kind "${item.kind}" (expected 'page'/'view'/'template')`);
    await upsert(space, prefix, item.fields);
  }
}

/**
 * The personal-instance counterpart of `applyGlobalContent()` - self-owned Kinds only, so no
 * `'template'` (a Template is a global-app-only concept, no personal instance has ever needed its
 * own). @param {import('@qu/space-core').Space} space @param {Array<{kind: 'page'|'view', fields: object}>} items
 * @param {{fresh?: boolean}} [options] `fresh` (default `false`, i.e. safe/upsert) - `true` writes via plain `create*()` instead - see this file's own top doc comment on why `install` alone wants this.
 */
export async function applyPersonalContent(space, items, { fresh = false } = {}) {
  const writers = fresh ? PERSONAL_WRITERS.fresh : PERSONAL_WRITERS.safe;
  for (const item of items) {
    const write = writers[item.kind];
    if (!write) throw new Error(`applyPersonalContent: unknown content kind "${item.kind}" (personal content only ever supports 'page'/'view')`);
    await write(space, item.fields);
  }
}

/**
 * @param {{
 *   key: string,
 *   label: string,
 *   version: number,
 *   route?: {title: string},
 *   content: (prefix: string, opts: object) => Array<{kind: 'page'|'view'|'template', fields: object}>,
 *   personal?: {title: string, content: (prefix: string, opts: object, ctx: {ownerPub: string}) => Array<{kind: 'page'|'view', fields: object}>},
 *   sharedLists?: (prefix: string) => string[],
 *   viewNames?: (prefix: string) => string[],
 *   bareRouteModes?: Array<'global'|'multiuser'|'personal'>,
 * }} descriptor
 *   `key` - this app's `appType`/`personalBundle` tag (`admin-actions.js`'s own `APP_INSTALLERS` doc
 *     comment) - how the admin console finds this SAME entry again for an already-registered prefix.
 *   `route` - GLOBAL apps only (omit for a bundle like the built-in admin console that is never
 *     seeded through the generic "install-app" form, `admin-console-bundle.js`'s own doc comment) -
 *     `install` is only generated when this is given; `update` always is.
 *   `content`/`personal.content` - PLAIN content declarations, never called directly by anything
 *     outside this file - `install()`/`update()` (and their personal counterparts) call them.
 *   `personal` - omit for an app with no personal-instance story (Forum: "my own one-person forum"
 *     doesn't map onto anything a visitor would want, `installed-apps-actions.js`'s own doc comment).
 *   `bareRouteModes` - default `['global']` (the safe minimum every `realm: 'global'` app supports) -
 *     see this file's own top doc comment. `'off'` is always implicitly available for every app,
 *     never listed here.
 * @returns {{key: string, label: string, version: number, install?: Function, update: Function, sharedLists?: Function, viewNames?: Function, personalBundle?: string, personal?: {install: Function, update: Function}, bareRouteModes: string[]}}
 */
export function defineAppBundle({ key, label, version, route, content, personal, sharedLists, viewNames, bareRouteModes }) {
  async function applyGlobal(space, prefix, opts, { waitForRoute }) {
    if (route) {
      await publishGlobalRoute(space, prefix, { route: '/', title: route.title });
      if (waitForRoute) await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await applyGlobalContent(space, prefix, content(prefix, opts));
  }

  const bundle = { key, label, version, sharedLists, viewNames, bareRouteModes: bareRouteModes ?? ['global'] };
  bundle.update = (space, { prefix, ...opts }) => applyGlobal(space, prefix, opts, { waitForRoute: false });
  if (route) bundle.install = (space, { prefix, ...opts }) => applyGlobal(space, prefix, opts, { waitForRoute: true });

  if (personal) {
    bundle.personalBundle = key;
    async function applyPersonal(space, prefix, opts, { fresh }) {
      const ownerPub = QuCrypto.toBase64(space.identity.signingPub);
      await publishRoute(space, { route: `/${prefix}/`, title: personal.title });
      await applyPersonalContent(space, personal.content(prefix, opts, { ownerPub }), { fresh });
    }
    bundle.personal = {
      install: (space, { prefix, ...opts }) => applyPersonal(space, prefix, opts, { fresh: true }),
      update: (space, { prefix, ...opts }) => applyPersonal(space, prefix, opts, { fresh: false }),
    };
  }

  return bundle;
}
