/**
 * ADMIN SECTION REGISTRY — the CMS editor's own set of areas (Templates,
 * Styles, Content) is REGISTERED here, at module load time, instead of
 * hardcoded as a fixed tuple anywhere in `cms-bundle.js`/`cms-actions.js` -
 * the user's own explicit requirement: "nicht alles hardcoden, sondern
 * registrieren." Each section becomes its OWN Page, at its own route
 * (`/cms/<id>`), reachable through the EXACT SAME generic `AppRuntime`/
 * `PlatformRuntime` routing every other Page already uses - no router
 * change anywhere needed to add a section (see `boot.js`'s own admin
 * delegation, which never special-cases a route string). A `/apps/*` app
 * (`apps/README.md`'s own descriptor shape) wanting its OWN admin section
 * (e.g. a future Forum "Moderation" panel) calls `registerAdminSection()`
 * from its own `index.js` - the exact same mechanism, no central file to
 * edit.
 *
 * SITS ON `@qu/extensions`' `ExtensionPointHost` (a private instance,
 * separate from `extension-points.js`'s app-shell-wide one - a registered
 * SECTION and a registered CMS `cms.pageActions` contribution are different
 * shapes with different lifecycles, no reason to share a namespace) -
 * this file is now the FIRST thing that generalized onto it: it was
 * already exactly this registry (ordered, id-keyed, "last registration for
 * a given id wins") before `@qu/extensions` existed, so this is a pure
 * internal refactor - every export below keeps its exact original
 * signature and behavior.
 *
 * A section is `{id, label, order, buildPageContent(ctx), wire(ctx)}`:
 *   - `id` - the URL segment (`/cms/<id>`) and this section's own stable
 *     key - must be unique across every registered section.
 *   - `label` - shown in the `/cms` index page's own nav list.
 *   - `order` (optional, default `0`) - lower sorts first in the nav list;
 *     ties break by registration order (`Array.prototype.sort()`'s own
 *     stability guarantee).
 *   - `buildPageContent({prefix, global})` - returns this section's own
 *     Page `content` HTML (inert markup, wired by `wire()` below) - a pure
 *     function, no space access, called once per `installCms()`/
 *     `installGlobalCms()`/update.
 *   - `wire(ctx)` - `ctx` is the SAME `{mountEl, doc, space, resolver,
 *     global, prefix, ownerPub}` shape `cms-actions.js`'s own `wireCms()`
 *     already assembles - attaches this section's own interactivity,
 *     already a correct, cheap no-op when the rendered page isn't this
 *     section's own (its own markup simply isn't found), the same
 *     "wireX() is always safe to call unconditionally" contract every
 *     other framework-provided wiring in this package already promises.
 *
 * `installCms()`/`installGlobalCms()` (`cms-bundle.js`) iterate
 * `listAdminSections()` to create one Page per section PLUS a `/cms` index
 * page linking to each - genuinely data-driven: registering a fourth
 * section changes what gets installed with zero edits to either function.
 */
import { ExtensionPointHost } from '@qu/extensions';

const ADMIN_SECTION_POINT = 'app-shell.adminSection';
const host = new ExtensionPointHost();

/** @param {{id: string, label: string, order?: number, buildPageContent: (ctx: {prefix: string, global: boolean}) => string, wire: (ctx: object) => Promise<void>|void}} section */
export function registerAdminSection(section) {
  if (!section?.id) throw new Error('registerAdminSection: "id" is required');
  const { id, order = 0, ...rest } = section;
  host.contribute(ADMIN_SECTION_POINT, { id, order, ...rest });
}

/** Every registered section, sorted by `order` (registration order breaks ties) - `ExtensionPointHost`'s own bookkeeping fields (`key`/`point`/`seq`/`appId`/`handler`, none of them ever set by `registerAdminSection()` above) are stripped back off so callers keep seeing the exact original `{id, label, order, buildPageContent, wire}` shape. */
export function listAdminSections() {
  return host.listContributions(ADMIN_SECTION_POINT).map(({ key, point, seq, appId, handler, ...section }) => section);
}

/** Test-only escape hatch - a fresh `node --test` process loads every section module exactly once anyway (registration is a module-load side effect, not per-test state), but a test that deliberately registers its OWN throwaway section needs a way to undo that without leaking into later tests in the SAME process. */
export function _clearAdminSectionsForTest() {
  host._clearPointForTest(ADMIN_SECTION_POINT);
}
