/**
 * THE BUILT-IN CMS EDITOR, AS A PLAIN BUNDLE — same "reference Package"
 * posture `admin-console-bundle.js` already documents for the platform
 * console, applied to an ORDINARY app's own content instead of the admin
 * realm: no hardcoded DOM-building JS, just a template + one page (the
 * SAME `{name, html}` / `{route, title, template, content, data}` shapes
 * `@qu/app-core`'s `createTemplate()`/`createPage()` already take), written
 * into an app's own Space by `installCms()` below. From then on the editor
 * is itself ordinary, editable Qu content - not framework code - literally
 * the same content the app's visitors already resolve through
 * `AppRuntime`/`renderPage()`; nothing in this route is special-cased on
 * the route string (architecture.md's "kein Sonderfall" posture), which is
 * also why `/cms` isn't reserved anywhere - it 404s like any other
 * unpublished route until `installCms()` actually writes it.
 *
 * The interactivity (list templates/styles/pages, load one into a form,
 * save it) is inert markup here too - `data-qu-action="cms-*-form"` /
 * `data-qu-bind="cms-*-list"` are CONVENTIONS `@qu/app-shell`'s own
 * `cms-actions.js` wires up after render, never a `<script>` (stripped by
 * `@qu/app-renderer`'s `sanitizeHtml()` regardless - see that file's own
 * doc comment on Stufe 1 of the security model). Real write-ACL, not this
 * markup, is what actually gates every save - a visiting identity that is
 * neither the app-admin nor a `grantContentWriter()`ed co-editor sees the
 * exact same form and gets the exact same "Gespeichert." courtesy message,
 * but the relay silently drops the write (kind-schema.js's own "THE
 * 'content' ACL mode" doc comment) - there is no client-side way to tell
 * the two cases apart, by design.
 *
 * NOT YET COVERED: editing the ADMIN REALM's own console content through
 * this same UI - that realm's Kinds (`qu-admin-*`) have no registries/
 * `edit*()` counterparts yet (see `dev.js`'s own admin-realm section doc
 * comment), so `bin/install-admin-console.mjs` remains the only way to
 * update it, unchanged. A reasonable future extension, not attempted here.
 */
import { createTemplate, createPage } from '@qu/app-core';

export const cmsBundle = {
  template: {
    name: '__cms__',
    html: '<div style="font-family: sans-serif; max-width: 44rem; margin: 2rem auto; line-height: 1.5; padding: 0 1rem;"><qu-slot name="content"></qu-slot></div>',
  },
  page: {
    route: '/cms',
    title: 'CMS',
    template: '__cms__',
    content: `<h1>CMS</h1>
<p>Verwaltet Templates, Styles und Seiten dieser App direkt im Space - Änderungen sind sofort für jeden Besucher sichtbar.</p>

<section>
  <h2>Templates</h2>
  <ul data-qu-bind="cms-template-list"></ul>
  <form data-qu-action="cms-template-form">
    <input type="hidden" name="mode" value="create">
    <label>Name: <input name="name" required></label><br>
    <label>HTML:<br><textarea name="html" rows="6" cols="60"></textarea></label><br>
    <button type="submit">Speichern</button>
    <button type="button" data-qu-cms-reset="template">Neues Template</button>
    <p data-qu-status></p>
  </form>
</section>

<section>
  <h2>Styles</h2>
  <ul data-qu-bind="cms-style-list"></ul>
  <form data-qu-action="cms-style-form">
    <input type="hidden" name="mode" value="create">
    <label>Name: <input name="name" required></label><br>
    <label>CSS:<br><textarea name="css" rows="6" cols="60"></textarea></label><br>
    <button type="submit">Speichern</button>
    <button type="button" data-qu-cms-reset="style">Neuer Style</button>
    <p data-qu-status></p>
  </form>
</section>

<section>
  <h2>Seiten</h2>
  <ul data-qu-bind="cms-page-list"></ul>
  <form data-qu-action="cms-page-form">
    <input type="hidden" name="mode" value="create">
    <label>Route (z.B. "/" oder "/blog/hallo"): <input name="route" required></label><br>
    <label>Titel: <input name="title" required></label><br>
    <label>Template: <select name="template"><option value="">(keins)</option></select></label><br>
    <label>Inhalt (HTML):<br><textarea name="content" rows="8" cols="60"></textarea></label><br>
    <label>Strukturierte Daten (optional, JSON-Objekt - jeder Schlüssel füllt einen gleichnamigen
      Slot im Template, z.B. <code>&lt;qu-slot name="author"&gt;</code>):<br>
      <textarea name="data" rows="4" cols="60" placeholder='{"author": "Alice"}'></textarea></label><br>
    <button type="submit">Speichern</button>
    <button type="button" data-qu-cms-reset="page">Neue Seite</button>
    <p data-qu-status></p>
  </form>
</section>`,
  },
};

/**
 * Writes the CMS editor's own template+page into `space` (an app-admin's
 * own Space, ordinary `'content'`-ACL writes - see `createTemplate()`/
 * `createPage()`) - re-running is harmless (both are idempotent/overwriting,
 * same posture `installAppBundle()` already documents). Deliberately not a
 * `routes`-registry entry via `publishRoute()`: `/cms` is a maintenance
 * route, not app navigation - leaving it out keeps it off a visitor-facing
 * sitemap built from `resolveRoutes()`, exactly like `#/admin` is reachable
 * without ever appearing in ordinary app navigation.
 * @param {import('@qu/space-core').Space} space
 * @param {typeof cmsBundle} [bundle]
 */
export async function installCms(space, bundle = cmsBundle) {
  await createTemplate(space, bundle.template);
  await createPage(space, bundle.page);
}
