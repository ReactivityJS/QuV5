/**
 * THE BUILT-IN CMS EDITOR, AS A PLAIN BUNDLE — same "reference Package"
 * posture `admin-console-bundle.js` already documents for the platform
 * console, applied to an ORDINARY app's own content instead of the admin
 * realm: no hardcoded DOM-building JS, just a template + one Page PER
 * REGISTERED SECTION (`src/admin-sections.js`'s own `listAdminSections()` -
 * Templates/Styles/Content today, whatever else calls `registerAdminSection()`
 * tomorrow) plus one small INDEX page linking to each - written into an
 * app-admin's own Space by `installCms()` below. From then on the editor
 * is itself ordinary, editable Qu content - not framework code - literally
 * the same content the app's visitors already resolve through
 * `AppRuntime`/`renderPage()`; nothing in any of these routes is
 * special-cased on the route string (architecture.md's "kein Sonderfall"
 * posture), which is also why none of `/cms`/`/cms/<id>` are reserved
 * anywhere - each 404s like any other unpublished route until `installCms()`
 * actually writes it.
 *
 * SEPARATE PAGES, ONE PER SECTION - the user's own explicit ask ("verschiedene
 * Admin-Bereiche für Templates, Styles und Content"): `/cms/templates`,
 * `/cms/styles`, `/cms/content` are each their OWN bookmarkable route,
 * reached through the exact same generic `AppRuntime`/`PlatformRuntime`
 * routing any other Page already uses - `boot.js`'s own admin delegation
 * needs ZERO changes to add a fourth section, since a Page at a new route
 * is nothing new to that layer at all. `/cms` itself is now just a small
 * NAV page (this file's own `indexPageContent()`) linking to each - GENERATED
 * from `listAdminSections()`, never a hardcoded list of links, so a new
 * section shows up there automatically the moment it registers itself.
 *
 * The interactivity (list templates/styles/content, load one into a form,
 * save it) is inert markup here too - `data-qu-action="cms-*-form"` /
 * `data-qu-bind="cms-*-list"` are CONVENTIONS `@qu/app-shell`'s own
 * `src/cms-actions.js` wires up after render, never a `<script>` (stripped
 * by `@qu/app-renderer`'s `sanitizeHtml()` regardless - see that file's own
 * doc comment on Stufe 1 of the security model). Real write-ACL, not this
 * markup, is what actually gates every save - a visiting identity that is
 * neither the app-admin nor a `grantContentWriter()`ed co-editor sees the
 * exact same form and gets the exact same "Gespeichert." courtesy message,
 * but the relay silently drops the write (kind-schema.js's own "THE
 * 'content' ACL mode" doc comment) - there is no client-side way to tell
 * the two cases apart, by design.
 *
 * NOT YET COVERED: editing the built-in admin app's own console content
 * through this same UI - its Kinds (`qu-admin-*`) have no registries/
 * `edit*()` counterparts yet (see `dev.js`'s own "ADMIN APP DEV API" doc
 * comment), so `bin/install-admin-console.mjs` remains the only way to
 * update it, unchanged. A reasonable future extension, not attempted here.
 */
import { createTemplate, createPage, createGlobalTemplate, createGlobalPage, publishGlobalRoute } from '@qu/app-core';
import { listAdminSections } from './src/admin-sections.js';
// Side-effect import - registers the built-in Templates/Styles/Content sections (this file's own
// top doc comment). `cms-actions.js` never imports THIS file, so there is no cycle here.
import './src/cms-actions.js';

function indexPageContent() {
  const items = listAdminSections()
    .map((section) => `  <li><a data-qu-cms-nav="${section.id}">${section.label}</a></li>`)
    .join('\n');
  return `<h1>CMS</h1>
<p>Verwaltet Templates, Styles und Inhalte dieser App direkt im Space - Änderungen sind sofort für jeden Besucher sichtbar.</p>
<ul>
${items}
</ul>`;
}

export const cmsBundle = {
  template: {
    name: '__cms__',
    html: '<div style="font-family: sans-serif; max-width: 44rem; margin: 2rem auto; line-height: 1.5; padding: 0 1rem;"><qu-slot name="content"></qu-slot></div>',
  },
  /** The INDEX page only (`/cms` itself, linking to every registered section) - kept as a stable `{route, title}` shape for existing callers that reference it directly (`bin/bootstrap-platform.mjs`'s own `publishGlobalRoute()` call before `installGlobalCms()`, some tests) - each SECTION's own page is generated separately, see `sectionPages()` below, never exposed as a single static object the way this whole bundle used to be. */
  get page() {
    return { route: '/cms', title: 'CMS', template: this.template.name, content: indexPageContent() };
  },
};

/** `{route, title, template, content}` for every registered section, plus the index page itself first - the SAME shape `createPage()`/`createGlobalPage()` already take, one call per entry. */
function allPages(bundle) {
  return [bundle.page, ...listAdminSections().map((section) => ({ route: `/cms/${section.id}`, title: section.label, template: bundle.template.name, content: section.buildPageContent({}) }))];
}

/**
 * Writes the CMS editor's own template + one page per registered section
 * (plus the `/cms` index) into `space` (an app-admin's own Space, ordinary
 * `'content'`-ACL writes - see `createTemplate()`/`createPage()`) -
 * re-running is harmless (both are idempotent/overwriting, same posture
 * `installAppBundle()` already documents). Deliberately does NOT
 * `publishRoute()` any of these: `/cms*` are maintenance routes, not app
 * navigation - leaving them out keeps them off a visitor-facing sitemap
 * built from `resolveRoutes()`, exactly like `#/admin` is reachable
 * without ever appearing in ordinary app navigation.
 * @param {import('@qu/space-core').Space} space
 * @param {typeof cmsBundle} [bundle]
 */
export async function installCms(space, bundle = cmsBundle) {
  await createTemplate(space, bundle.template);
  for (const page of allPages(bundle)) await createPage(space, page);
}

/**
 * GLOBAL-APP COUNTERPART TO `installCms()` - the SAME editor template + one
 * page per registered section, but written as the `qu-admin-*` Kinds
 * (`createGlobalTemplate()`/`createGlobalPage()`, `@qu/app-core`'s "GLOBAL
 * APP DEV API"), anchored on `prefix`'s own global anchor instead of an
 * app-admin's pubkey. Used for a `realm: 'global'` app's OWN global shell -
 * reachable by any relay-admin at `#/admin/<prefix>/cms(/<section>)`
 * (`boot.js`'s `parseAdminSubPath()`/`renderGlobalShell()`), completely
 * separate content from any visitor's own self-provisioned `installCms()`
 * call at `#/<prefix>/u/<ref>/cms` - the two never share a Node id
 * (different owner anchors entirely), so editing one never touches the
 * other.
 *
 * UNLIKE `installCms()`, EACH page here DOES need `publishGlobalRoute()`
 * called for it FIRST (with a settle wait before the page write follows) -
 * a `qu-admin-page` write is only classified correctly once the relay's own
 * live resolver has already observed a `publishGlobalRoute()` write for
 * that EXACT route (`dev.js`'s own `publishGlobalRoute()` doc comment) -
 * this function does that itself, for every section's own route AND the
 * `/cms` index, so a caller only ever needs `registerApp()`'s own
 * `globalTemplateNames: ['__cms__']` declared first (this file's own top
 * doc comment references who's responsible for what).
 * @param {import('@qu/space-core').Space} space - a relay-admin's own Space.
 * @param {string} prefix - the SAME prefix this app is `registerApp()`ed under.
 * @param {typeof cmsBundle} [bundle]
 */
export async function installGlobalCms(space, prefix, bundle = cmsBundle) {
  await createGlobalTemplate(space, prefix, bundle.template);
  for (const page of allPages(bundle)) {
    await publishGlobalRoute(space, prefix, { route: page.route, title: page.title });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await createGlobalPage(space, prefix, page);
  }
}
