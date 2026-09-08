/**
 * CMS ACTIONS — the framework-provided interactivity `cms-bundle.js`'s own
 * inert markup attaches to by CONVENTION, mirroring `admin-actions.js`'s
 * `wireAdminConsole()` exactly (same "content stays inert markup, framework
 * code wires ordinary DOM elements a content author declared by attribute"
 * posture, itself mirroring `@qu/space-ui`'s `bindField()`/`bindCheckbox()`).
 * `boot.js` calls `wireCms()` unconditionally after every `renderPage()` -
 * cheap (a handful of `querySelector` calls) and a correct no-op whenever
 * the rendered page isn't one of the CMS's OWN sections (no matching
 * elements found).
 *
 * THREE REGISTERED SECTIONS - Templates, Styles, Content - each now its OWN
 * PAGE at its own route (`/cms/templates`, `/cms/styles`, `/cms/content`),
 * not one shared page with everything crammed into it (the user's own
 * explicit ask: separate admin areas, reachable by real, bookmarkable
 * routes). "Registered, not hardcoded" (also the user's own framing):
 * `admin-sections.js`'s `registerAdminSection()` calls at the bottom of
 * this file are the ONLY place that lists these three - `cms-bundle.js`'s
 * `installCms()`/`installGlobalCms()` and this file's own `wireCms()` both
 * iterate `listAdminSections()` instead of naming any section by hand, so
 * a FOURTH section (a `/apps/*` app's own admin panel, say) needs no edit
 * to either of THOSE functions, only its own `registerAdminSection()` call.
 *
 * "Content" REPLACES the old separate "Seiten"/"Views" sections with ONE
 * unified editor - the user's own explicit ask: name/path, template-or-
 * HTML, an optional style, and a content-SOURCE picker (Text/HTML | Geteilte
 * Liste | Seiten-Filter) that dispatches to `createPage()`/`editPage()` vs
 * `createView()`/`editView()` under the hood depending on which is picked -
 * `wireContent()`'s own doc comment has the full mapping. The underlying
 * Kinds stay genuinely separate (`pageKind` vs `viewKind`) - only the
 * AUTHORING UI unifies, so no data migration of any already-published page
 * or View is needed for this change.
 *
 * Three independent sections, each the same overall SHAPE: a
 * `[data-qu-bind="cms-<kind>-list"]` list (populated once, at wiring time -
 * not live-reactive, matching `wireAdminConsole()`'s own posture), where
 * clicking an entry loads its CURRENT content into the matching
 * `[data-qu-action="cms-<kind>-form"]` form and switches it into "edit"
 * mode (the item's own name/route becomes read-only - `editTemplate()`/
 * `editStyle()`/`editPage()` all require the EXACT existing key, changing
 * it would target a different, likely-nonexistent Node rather than
 * "rename" anything, see dev.js's own doc comments); a `[data-qu-cms-reset]`
 * button clears the form back to "create" mode. WRITE-ACL, not this file,
 * is what actually gates a save - see `cms-bundle.js`'s own doc comment.
 *
 * `wireCms()` starts every registered section's own `wire()` TOGETHER
 * (`Promise.all`), never one `await`ed after another: each section's own
 * `wire()` attaches its own form's submit listener SYNCHRONOUSLY, before
 * its first `await` - but its OWN list refresh right after can take up to
 * that list's `resolveTemplateNames()`/`resolveStyleNames()`/`resolveRoutes()`
 * call's full `timeout` (500ms) when the registry doesn't exist yet (a
 * brand new app, nothing created through the CMS at all so far - `waitFor()`
 * in resolver.js has no "it's empty" shortcut, it only gives up once the
 * clock runs out). A section sequencing its OWN internal awaits before
 * attaching its listener would leave that form's submit listener unattached
 * for that entire stretch - a visitor filling in the form within roughly
 * the first 500ms of the page existing would submit into dead air, no
 * listener yet to catch it, and nothing would appear to happen at all. This
 * ONCE genuinely broke `wirePages()` (this file's own predecessor to
 * `wireContent()`) for ITSELF (its own `refreshTemplateSelect()`/
 * `globalAppAnchor()` awaits used to run BEFORE its listener attachment,
 * not after) - a real, deployment-observed bug, not hypothetical: a
 * self-provisioned first-time visitor (`boot.js`'s `renderMultiUserRoute()`)
 * with a genuinely-empty template registry could submit into that same
 * "no listener yet" dead air for the ENTIRE 500ms `resolveTemplateNames()`
 * wait. `wireContent()` below keeps the fix - every `await` that isn't
 * needed to attach a listener runs strictly AFTER every listener already is.
 *
 * CROSS-SECTION NAVIGATION LINKS ("Zurück zur Übersicht" on each section
 * page, each entry on the `/cms` index page) are NEVER a literal `href`
 * baked into the stored content - see `wireCmsNav()`'s own doc comment
 * below for the real, previously-shipped "leads nowhere" bug this fixes
 * (the user's own report): the same `/cms*` pages are reachable under many
 * different URL bases depending on context (a self-owned space, a
 * `mode:'multiuser'` app's bare prefix, an additive `/u/<ref>/`, a global
 * app's `/admin/<prefix>/` delegation or its own bare prefix) - a link
 * fixed at install time can only ever be right for ONE of those.
 * `data-qu-cms-nav="index"`/`"<sectionId>"` (this file's own convention,
 * same "content stays inert markup" posture as everything else here) is
 * how the markup declares INTENT without committing to a base path -
 * `wireCmsNav()` fills in the real `href` from the CURRENT URL every time
 * `wireCms()` runs.
 *
 * KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE BETWEEN "load into form" AND
 * "save" - a real, observed bug this fixes: `Space.useNode()` is
 * ref-counted, and `ContentResolver`'s own `resolveTemplate()`/
 * `resolveStyle()`/`resolvePage()`/`resolveView()`, called BARE (no `hold`),
 * each call `useNode()` THEN `release()` internally, dropping the refcount
 * straight back to zero - which `Space.unsubscribeNode()` treats as "nobody
 * needs this Node locally any more" and DISCARDS the local Y.Doc entirely
 * (`space.js`'s own `_nodes.delete(id)`), not merely stops live-pushing to
 * it. Submitting the form moments later calls `editTemplate()`/`editStyle()`/
 * `editPage()`/`editView()` (dev.js), which does its OWN fresh `useNode()` -
 * if the previous one was fully torn down, this has to re-subscribe and
 * wait for the relay to replay the Node's entire history again, a real
 * network round-trip a fixed ~2s timeout can genuinely lose to over a real
 * (non-localhost) connection, throwing "does not exist (or has not synced)"
 * for content that plainly DOES exist - the user just viewed it.
 *
 * UPDATE - fixed at the framework level now, not per-app: each section's
 * click handler below resolves with `{hold: true}` the moment an item is
 * loaded into the form (`resolver.resolveTemplate(name, {..., hold: true})`
 * etc., `resolver.js`'s own doc comment on the option) instead of this file
 * calling `useNode()` a second, separate time itself (the former
 * `holdEdit()`, removed - this WAS its exact replacement, moved into
 * `@qu/app-core` so no other app has to reinvent it). The returned
 * `release` is kept on `activeEdit` until a DIFFERENT item is loaded or the
 * form is reset - long enough to keep the refcount above zero (so nothing
 * gets discarded) for the entire "loaded into the form, being edited"
 * window - a plain BARE resolve (no `hold`) elsewhere in this codebase
 * keeps releasing immediately, exactly as before (ordinary rendering,
 * where holding every resolved Node open would leak subscriptions across a
 * visitor's whole session).
 *
 * KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE FOR THE WHOLE CMS
 * SESSION - the SAME class of bug as above, just for `routeRegistryKind`/
 * `templateRegistryKind`/`styleRegistryKind` instead of one content Node:
 * `refreshList()`'s own `resolver.resolveTemplateNames()`/
 * `resolveStyleNames()`/`resolveRoutes()` calls ALSO release-to-zero after
 * every read, so the registry gets discarded and re-fetched from scratch
 * on every single list refresh (i.e. after every save) - and worse,
 * `dev.js`'s `registerContentName()`/`publishRoute()` used to treat
 * "not currently attached" as "doesn't exist yet" and fork a brand-new,
 * competing Y.Doc for an id that already had entries (fixed in `dev.js`
 * itself, see its own `getOrSyncRegistryNode()` doc comment - the framework
 * -level fix any caller benefits from). Holding the registry open here on
 * TOP of that fix (`holdRegistry()`, opened once per section at wiring
 * time, never released during normal operation) is what actually makes
 * repeated saves in one CMS visit fast, not just eventually-correct: every
 * `refreshList()`/`registerContentName()`/`publishRoute()` call after the
 * first one finds the registry already attached and skips the network
 * round-trip entirely, instead of a route/template/style transiently (or,
 * pre-`dev.js`-fix, non-transiently) vanishing from the list right after
 * the NEXT unrelated save.
 */
import {
  ContentResolver,
  createTemplate,
  createStyle,
  createPage,
  editTemplate,
  editStyle,
  editPage,
  deleteTemplate,
  deleteStyle,
  deletePage,
  deleteView,
  publishRoute,
  createGlobalPage,
  editGlobalPage,
  publishGlobalRoute,
  deriveContentNodeId,
  templateKind,
  styleKind,
  pageKind,
  adminPageKind,
  routeRegistryKind,
  templateRegistryKind,
  styleRegistryKind,
  adminRouteRegistryKind,
  globalAppAnchor,
  viewKind,
  adminViewKind,
  createView,
  editView,
  createGlobalView,
  editGlobalView,
  addGlobalViewNames,
} from '@qu/app-core';
import { verifyWritesAcked } from './verify-writes.js';
import { deriveOwnerNodeId } from '@qu/space-core';
import { registerAdminSection, listAdminSections } from './admin-sections.js';
import { extensionPoints } from './extension-points.js';

/** See this file's own top doc comment, "KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE...". Opens (and never releases - see that comment on why) a subscription to `ownerPub`'s `registryKind` Node (defaults to `space.identity` - a GLOBAL app's registry passes `globalAppAnchor(prefix)` instead), so every later `refreshList()`/`registerContentName()`/`publishRoute()`/`publishGlobalRoute()` call in the same CMS session finds it already attached. */
async function holdRegistry(space, registryKind, ownerPub = space.identity.signingPub) {
  const id = await deriveOwnerNodeId(ownerPub, registryKind.kind);
  return space.useNode(id, registryKind);
}

/**
 * Rewrites every `[data-qu-cms-nav]` link's own `href` to point at THIS
 * render's actual `/cms` base path, derived from the CURRENT URL
 * (`doc.defaultView.location.hash`) rather than a path baked into the
 * stored content at install time - a REAL, previously-shipped bug this
 * fixes ("führt ins Leere," the user's own report): the exact same `/cms`
 * section pages are reachable under many different bases depending on
 * WHERE this render came from (`boot.js`'s own doc comments have the full
 * list) - a self-owned space's own bare `/cms`, a `mode: 'multiuser'` app's
 * bare `/<prefix>/cms`, an ADDITIVE `/u/<ref>/cms`, or a global app's own
 * `/admin/<prefix>/cms` (reached via admin delegation) OR bare `/<prefix>/cms`
 * (reached directly, `mode: 'global'`) - a link hardcoded at install time
 * (formerly a literal `href="#/admin/cms"` on "Zurück zur Übersicht" and
 * `href="#/cms/<id>"` on the index page's own section links, this file's
 * own git history) can only ever be correct for ONE of those, and 404s
 * ("leads nowhere") for every other app/context - it only ever LOOKED
 * correct during manual testing because the reference "cms" demo app
 * happens to be reachable at exactly that literal path.
 *
 * Same "content stays inert markup, framework code wires by attribute"
 * posture as everywhere else in this file: `data-qu-cms-nav="index"` means
 * THIS render's own `/cms` page; any other value `"<id>"` (one of
 * `listAdminSections()`'s own ids) means `/cms/<id>` - same computed base
 * either way. A no-op (correct, cheap) on any page with no such link.
 */
function wireCmsNav(mountEl, doc) {
  const links = mountEl.querySelectorAll('[data-qu-cms-nav]');
  if (links.length === 0) return;
  const hash = (doc.defaultView.location.hash || '#/').slice(1) || '/';
  const match = /^(.*\/cms)(?:\/.*)?$/.exec(hash);
  const base = match ? match[1] : '/cms';
  for (const link of links) {
    const target = link.getAttribute('data-qu-cms-nav');
    link.setAttribute('href', `#${target === 'index' ? base : `${base}/${target}`}`);
  }
}

function setStatus(form, text) {
  const status = form.querySelector('[data-qu-status]') ?? form.appendChild(form.ownerDocument.createElement('p'));
  status.setAttribute('data-qu-status', '');
  status.textContent = text;
}

/** Switches `form` into "edit" mode: locks `keyFieldName` to `keyValue` (the Node this save must target) and fills every other field in `fields`. */
function enterEditMode(form, { keyFieldName, keyValue, fields }) {
  form.querySelector('input[name="mode"]').value = 'edit';
  const keyInput = form.querySelector(`[name="${keyFieldName}"]`);
  keyInput.value = keyValue;
  keyInput.readOnly = true;
  for (const [name, value] of Object.entries(fields)) {
    const el = form.querySelector(`[name="${name}"]`);
    if (el) el.value = value ?? '';
  }
}

/** Back to "create" mode - a fresh, empty form. */
function resetForm(form, keyFieldName) {
  form.reset();
  form.querySelector('input[name="mode"]').value = 'create';
  for (const key of Array.isArray(keyFieldName) ? keyFieldName : [keyFieldName]) {
    const keyInput = form.querySelector(`[name="${key}"]`);
    if (keyInput) keyInput.readOnly = false;
  }
  setStatus(form, '');
}

const TEMPLATES_PAGE_CONTENT = `<h1>Templates</h1>
<p><a data-qu-cms-nav="index">&larr; Zurück zur Übersicht</a></p>
<ul data-qu-bind="cms-template-list"></ul>
<form data-qu-action="cms-template-form">
  <input type="hidden" name="mode" value="create">
  <label>Name: <input name="name" required></label><br>
  <label>HTML:<br><textarea name="html" rows="6" cols="60"></textarea></label><br>
  <button type="submit">Speichern</button>
  <button type="button" data-qu-cms-reset="template">Neues Template</button>
  <p data-qu-status></p>
</form>`;

/**
 * Shared shape behind `wireTemplates()`/`wireStyles()` right below - the one
 * genuinely redundant piece of code the user's own "können wir noch
 * redundanten Code entfernen" ask actually found, once Page+View had
 * already been unified into `wireContent()` above: both sections turned out
 * to be the EXACT same list/form/reset dance (list every name, click one to
 * load its single value into the form, save, reset) over a different
 * single-value Kind (`templateKind`'s `html` vs `styleKind`'s `css`) -
 * genuinely identical control flow, not just superficially similar markup.
 * `wireContent()` is deliberately NOT built on this: it keys by a different
 * field depending on `sourceType`, dispatches to TWO different Dev API
 * pairs (`createPage`/`createView`), and toggles multiple form
 * sub-sections - a real, different shape, not more of this same one.
 *
 * Global apps have no template/style REGISTRY yet (kinds.js's own "GLOBAL
 * APP CONTENT" doc comment) - a new one's NAME still needs declaring
 * upfront via `registerApp()`'s own `globalTemplateNames`/`globalStyleNames`
 * (kinds.js's own `platformAppsKind` doc comment) - both sections stay
 * self-owned-only for now, same scope cut as before this redesign.
 */
async function wireSimpleContentSection({
  mountEl,
  doc,
  space,
  global,
  ownerPub,
  sectionId,
  emptyLabel,
  kind,
  registryKind,
  valueField,
  resolveNames,
  resolveValue,
  createFn,
  editFn,
  deleteFn,
}) {
  if (global) return;
  const list = mountEl.querySelector(`[data-qu-bind="cms-${sectionId}-list"]`);
  const form = mountEl.querySelector(`form[data-qu-action="cms-${sectionId}-form"]`);
  const resetBtn = mountEl.querySelector(`[data-qu-cms-reset="${sectionId}"]`);
  if (!list && !form) return;

  // Fire-and-forget, started BEFORE the submit listener below attaches (same synchronous-first-tick
  // reasoning as _sendSubscribeRequest()'s own posture elsewhere) - see this file's own top doc
  // comment, "KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE...".
  holdRegistry(space, registryKind, ownerPub).catch(() => {});
  let activeEdit = null; // see this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...".

  async function refreshList() {
    if (!list) return;
    const items = await resolveNames({ timeout: 500 });
    list.replaceChildren();
    if (items.length === 0) {
      const li = doc.createElement('li');
      li.textContent = emptyLabel;
      list.appendChild(li);
      return;
    }
    for (const { name } of items) {
      const li = doc.createElement('li');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', async () => {
        activeEdit?.release();
        const { value, release } = await resolveValue(name, { timeout: 2000, hold: true });
        activeEdit = { release };
        enterEditMode(form, { keyFieldName: 'name', keyValue: name, fields: { [valueField]: value ?? '' } });
      });
      li.appendChild(btn);

      // DELETE - self-owned content only (no `ownerPub` passed to `deleteFn`, unlike `createFn`/
      // `editFn` above): a granted co-editor can fully edit someone else's content through this same
      // form already, but cannot delete it here - `deleteTemplate()`/`deleteStyle()` (`dev.js`) only
      // ever unregister from the CALLING identity's own registry, so a co-editor's attempt fails with
      // a clear "is not registered" error rather than silently doing nothing or touching the wrong
      // registry. Same "no native confirm()" posture as `admin-actions.js`'s own "Deinstallieren" -
      // fires immediately, no dialog, framework-provided interactivity stays a plain DOM element.
      const deleteBtn = doc.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.dataset.quCmsDelete = sectionId;
      deleteBtn.textContent = 'Löschen';
      deleteBtn.addEventListener('click', async () => {
        setStatus(form, '');
        try {
          await deleteFn(space, { name, timeout: 2000 });
          if (form.querySelector('[name="name"]')?.value.trim() === name) {
            activeEdit?.release();
            activeEdit = null;
            resetForm(form, 'name');
          }
          await refreshList();
        } catch (err) {
          setStatus(form, `Fehler: ${err.message}`);
        }
      });
      li.appendChild(deleteBtn);

      list.appendChild(li);
    }
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus(form, '');
      try {
        const mode = form.querySelector('input[name="mode"]').value;
        const name = form.querySelector('[name="name"]').value.trim();
        const value = form.querySelector(`[name="${valueField}"]`).value;
        if (mode === 'edit') {
          const id = await deriveContentNodeId(ownerPub ?? space.identity.signingPub, kind.kind, name);
          await verifyWritesAcked(space, id, () => editFn(space, { name, [valueField]: value, ownerPub, timeout: 2000 }));
        } else {
          const id = await deriveContentNodeId(space.identity.signingPub, kind.kind, name);
          await verifyWritesAcked(space, id, () => createFn(space, { name, [valueField]: value }));
        }
        setStatus(form, 'Gespeichert und vom Relay bestätigt.');
        await refreshList();
      } catch (err) {
        setStatus(form, `Fehler: ${err.message}`);
      }
    });
  }
  if (resetBtn && form) {
    resetBtn.addEventListener('click', () => {
      activeEdit?.release();
      activeEdit = null;
      resetForm(form, 'name');
    });
  }

  await refreshList();
}

async function wireTemplates({ mountEl, doc, space, resolver, global, ownerPub }) {
  await wireSimpleContentSection({
    mountEl,
    doc,
    space,
    global,
    ownerPub,
    sectionId: 'template',
    emptyLabel: '(noch kein Template)',
    kind: templateKind,
    registryKind: templateRegistryKind,
    valueField: 'html',
    resolveNames: (opts) => resolver.resolveTemplateNames(opts),
    resolveValue: (name, opts) => resolver.resolveTemplate(name, opts),
    createFn: createTemplate,
    editFn: editTemplate,
    deleteFn: deleteTemplate,
  });
}

const STYLES_PAGE_CONTENT = `<h1>Styles</h1>
<p><a data-qu-cms-nav="index">&larr; Zurück zur Übersicht</a></p>
<ul data-qu-bind="cms-style-list"></ul>
<form data-qu-action="cms-style-form">
  <input type="hidden" name="mode" value="create">
  <label>Name: <input name="name" required></label><br>
  <label>CSS:<br><textarea name="css" rows="6" cols="60"></textarea></label><br>
  <button type="submit">Speichern</button>
  <button type="button" data-qu-cms-reset="style">Neuer Style</button>
  <p data-qu-status></p>
</form>`;

/** See `wireSimpleContentSection()`'s own doc comment, right above `wireTemplates()` - identical reasoning here, just `styleKind`'s `css` instead of `templateKind`'s `html`. */
async function wireStyles({ mountEl, doc, space, resolver, global, ownerPub }) {
  await wireSimpleContentSection({
    mountEl,
    doc,
    space,
    global,
    ownerPub,
    sectionId: 'style',
    emptyLabel: '(noch kein Style)',
    kind: styleKind,
    registryKind: styleRegistryKind,
    valueField: 'css',
    resolveNames: (opts) => resolver.resolveStyleNames(opts),
    resolveValue: (name, opts) => resolver.resolveStyle(name, opts),
    createFn: createStyle,
    editFn: editStyle,
    deleteFn: deleteStyle,
  });
}

const CONTENT_PAGE_CONTENT = `<h1>Inhalt</h1>
<p><a data-qu-cms-nav="index">&larr; Zurück zur Übersicht</a></p>
<p>Ein Eintrag ist entweder eine reine Text/HTML-Seite, oder eine live aktualisierte VIEW über eine
  geteilte Liste (z.B. Gästebuch) oder einen Seiten-Filter (z.B. Blog-Index) - "Ziel-App-Präfix" bei
  "Seiten-Filter" erlaubt es, Inhalte einer ANDEREN App einzubinden (App-übergreifende Views).</p>
<ul data-qu-bind="cms-content-list"></ul>
<details>
  <summary>View aus JSON übernehmen</summary>
  <p>Eine vollständige View-Definition einfügen (<code>{"name","route","sources","sortBy","sortOrder","limit","itemTemplate","template","style"}</code>,
    alle Felder optional außer <code>name</code> oder <code>route</code>) - übernimmt sie in das Formular unten,
    OHNE sofort zu speichern (erst "Speichern" klicken).</p>
  <textarea data-qu-view-import rows="4" cols="60" placeholder='{"name":"feed","sources":[{"type":"pages","prefix":"/blog/"},{"type":"shared-list","name":"guestbook"}],"sortBy":"timestamp","itemTemplate":"..."}'></textarea><br>
  <button type="button" data-qu-action="cms-content-import-view">Übernehmen</button>
  <p data-qu-view-import-status></p>
</details>
<form data-qu-action="cms-content-form">
  <input type="hidden" name="mode" value="create">
  <label>Pfad (Route, z.B. "/" oder "/blog" - bei "Geteilte Liste"/"Seiten-Filter" optional, leer =
    nur einbettbar via <code>&lt;div data-qu-view="NAME"&gt;&lt;/div&gt;</code> auf einer anderen
    Seite): <input name="route"></label><br>
  <label>Inhaltsquelle:
    <select name="sourceType">
      <option value="html">Text/HTML</option>
      <option value="shared-list">Geteilte Liste (viele Autoren)</option>
      <option value="pages">Seiten-Filter</option>
    </select>
  </label><br>

  <div data-qu-content-section="html">
    <label>Titel: <input name="title"></label><br>
    <label>Template: <select name="template"><option value="">(keins)</option></select></label><br>
    <label>Inhalt (HTML):<br><textarea name="content" rows="8" cols="60"></textarea></label><br>
    <label>Strukturierte Daten (optional, JSON-Objekt - jeder Schlüssel füllt einen gleichnamigen
      Slot im Template, z.B. <code>&lt;qu-slot name="author"&gt;</code>):<br>
      <textarea name="data" rows="4" cols="60" placeholder='{"author": "Alice"}'></textarea></label><br>
  </div>

  <div data-qu-content-section="shared-list pages" hidden>
    <label>Name (optional - nur nötig, um eine bestehende View ohne eigene Route erneut zu laden,
      siehe "View laden" unten; wird sonst aus dem Pfad abgeleitet): <input name="name">
      <button type="button" data-qu-action="cms-content-load-view">View laden</button></label><br>
  </div>

  <div data-qu-content-section="shared-list" hidden>
    <label>Listen-Name: <input name="listName"></label><br>
    <label>Filter (optional, JSON-Objekt, z.B. <code>{"topicId":"abc"}</code>): <input name="filter"></label><br>
  </div>

  <div data-qu-content-section="pages" hidden>
    <label>Ziel-App-Präfix (leer = diese App; ein ANDERER Präfix bindet dessen Seiten ein -
      App-übergreifend): <input name="sourcePrefix"></label><br>
    <label>Pfad-Präfix-Filter (z.B. "/blog/"): <input name="pagesPrefix"></label><br>
  </div>

  <div data-qu-content-section="shared-list pages" hidden>
    <label>Erweitert - mehrere Quellen zugleich kombinieren (optional, JSON-Array, überschreibt die
      Auswahl oben, z.B. <code>[{"type":"pages","prefix":"/blog/"},{"type":"shared-list","name":"guestbook"}]</code>
      für einen gemeinsamen Blog+Gästebuch-Feed):<br>
      <textarea name="sourcesOverride" rows="2" cols="60"></textarea></label><br>
    <label>Template für die Route (optional, Name eines vorhandenen Templates): <input name="viewTemplate"></label><br>
    <label>Sortieren nach: <select name="sortBy"><option value="">(Reihenfolge der Quellen)</option><option value="title">Titel</option><option value="timestamp">Zeitstempel</option></select></label><br>
    <label>Reihenfolge: <select name="sortOrder"><option value="asc">aufsteigend</option><option value="desc" selected>absteigend</option></select></label><br>
    <label>Limit (optional): <input name="limit" type="number" min="1"></label><br>
    <label>Item-Template (HTML, <code>&lt;qu-slot name="title"&gt;</code>/<code>"excerpt"</code>, Link via <code>&lt;a data-qu-view-link&gt;</code>):<br>
      <textarea name="itemTemplate" rows="4" cols="60"></textarea></label><br>
  </div>

  <label>Style (optional, Name eines vorhandenen Styles - ersetzt das Theme der App nur für diesen
    Eintrag): <input name="style"></label><br>
  <button type="submit">Speichern</button>
  <button type="button" data-qu-cms-reset="content">Neuer Inhalt</button>
  <p data-qu-status></p>
</form>`;

/**
 * THE UNIFIED CONTENT EDITOR — replaces the old separate "Seiten"/"Views"
 * sections with ONE form, dispatching to `createPage()`/`editPage()`
 * (`sourceType: "html"`) or `createView()`/`editView()`
 * (`sourceType: "shared-list"`/`"pages"`) depending on which content-SOURCE
 * is picked (`data-qu-content-section` attribute values on this file's own
 * `CONTENT_PAGE_CONTENT` markup, toggled visible/hidden by `updateVisibility()`
 * below on the `sourceType` `<select>`'s own `change` event - the ONE bit of
 * genuine client-side interactivity this editor needs beyond ordinary form
 * submission, still framework-provided code attaching to inert markup by
 * convention, never a content-authored `<script>`).
 *
 * KEYED DIFFERENTLY PER SOURCE TYPE: a Page is keyed by its own `route`
 * (`pageKind`'s own doc comment); a View is keyed by `name`, with `route`
 * only OPTIONALLY connecting it to a path (`createView()`'s own doc
 * comment on `route`). For `sourceType: "html"` this form's own `route`
 * field IS the key, same as the old "Seiten" section. For `"shared-list"`/
 * `"pages"`, `name` is the real key - left blank on CREATE, it is DERIVED
 * from `route` (`route` slashes replaced with `-`, or `"index"` for `"/"`)
 * so a routed View built through this form never needs its own separate
 * name typed in by hand; editing an EXISTING view (no route, or a route
 * you don't remember the derived name for) uses the "View laden" button
 * (`data-qu-action="cms-content-load-view"`) - the SAME "no registry to
 * pick from, type the name and load it" affordance the old "Views" section
 * already had (`createView()`'s own doc comment: "no 'list every View this
 * owner has' registry yet" - unchanged, real, still-open future work, not
 * attempted in this redesign either).
 *
 * THE CONTENT LIST (`[data-qu-bind="cms-content-list"]`) shows every
 * PUBLISHED ROUTE (`resolver.resolveRoutes()` - the SAME registry the old
 * "Seiten" section's own list used), which already includes a routed
 * View's own auto-created wrapper page (`createView({route})`'s own doc
 * comment) - clicking ANY entry loads it as a PLAIN PAGE, in
 * `sourceType: "html"` mode, showing that wrapper's raw
 * `<div data-qu-view="...">` markup - exactly the affordance
 * `docs/example-apps.md`'s own §5 step 4 already documents for wrapping a
 * feed in a header/footer. Editing the underlying VIEW's own `sources`/
 * `sortBy`/etc. instead of its wrapper page's surrounding markup needs the
 * "View laden" button above, by name - a real, disclosed asymmetry (not a
 * regression: the OLD "Views" section had the exact same "no unified list"
 * limitation, just in its own separate section).
 *
 * MULTIPLE, MIXED-TYPE SOURCES IN ONE VIEW (architecture.md's own flagship
 * "a Blog + Guestbook combined feed" example) - the simple picker above
 * only ever builds ONE `sources` entry at a time (either `'shared-list'` OR
 * `'pages'`), so `sourcesOverride` (a raw JSON `sources` array, shown
 * alongside both picker variants) is the deliberate escape hatch: when
 * non-empty, it REPLACES whatever the picker would have built, exactly the
 * old View editor's own "sources is edited as raw JSON text" posture, kept
 * around for the case the simple picker genuinely can't express. "View
 * laden" round-trips an existing multi-source (or otherwise non-simple)
 * View straight back into this field rather than forcing it into the
 * picker's own single-source shape.
 *
 * CROSS-APP ("app-übergreifende") Views - the user's own explicit ask:
 * `sourceType: "pages"`'s own `sourcePrefix` field (optional) becomes
 * `sources: [{type: 'pages', ownerPrefix: sourcePrefix, ...}]` -
 * `view-sources.js`'s own `'pages'` adapter doc comment on how that reads
 * a DIFFERENT `realm: 'global'` app's own route registry instead of this
 * View's own owner. `sourceType: "shared-list"` already works cross-app
 * with NO extra field at all - a shared list's id is a hash of its own
 * NAME, never scoped to any one app (same doc comment). There is no
 * separate "cross-app Views area" bolted on anywhere: ANY registered
 * `realm: 'global'` app's own `/cms/content` section can build a View
 * sourcing from ANY other app this way - a relay-admin who wants a
 * DEDICATED cross-app views workspace simply registers a bare app (e.g.
 * prefix `"views"`) and uses ITS `/cms/content` for exactly that, the same
 * one-click "Views/Seiten (CMS)" workflow `docs/example-apps.md`'s own §5
 * already documents for any other bundle-less app - no new framework code
 * needed for that shape at all.
 *
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, resolver: ContentResolver, global?: boolean, prefix?: string, ownerPub?: Uint8Array}} params
 *   `ownerPub` - the app's REAL owner pubkey (`wireCms()`'s own `appAdminPub`,
 *   see its doc comment) - REQUIRED for editing to ever work for anyone
 *   other than whichever identity happens to be `space.identity` right now
 *   (a real, previously-fixed bug: every `resolve-with-hold`/`holdRegistry()`/
 *   `edit*()` call used to silently default to `space.identity.signingPub`,
 *   the browsing VISITOR's own identity, not the app's actual owner or a
 *   granted co-editor - see `grantContentWriter()`'s own doc comment).
 *   `global`/`prefix` - in global mode, every write goes through
 *   `createGlobalPage()`/`editGlobalPage()`/`createGlobalView()`/
 *   `editGlobalView()`/`publishGlobalRoute()` instead of the ordinary
 *   per-owner Dev API - ANY configured relay-admin may then create/edit
 *   ANY content under this app, not just whoever happened to create it
 *   first (kinds.js's own "GLOBAL APP CONTENT" doc comment).
 */
async function wireContent({ mountEl, doc, space, resolver, global = false, prefix, ownerPub }) {
  const list = mountEl.querySelector('[data-qu-bind="cms-content-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-content-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="content"]');
  const loadViewBtn = mountEl.querySelector('[data-qu-action="cms-content-load-view"]');
  const importViewBtn = mountEl.querySelector('[data-qu-action="cms-content-import-view"]');
  if (!list && !form) return;

  const pageKindHere = global ? adminPageKind : pageKind;
  const viewKindHere = global ? adminViewKind : viewKind;
  let activeEdit = null; // see this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...".
  let anchor; // assigned below, after every listener is attached - see this file's own top doc comment on why (the `wirePages()` regression).

  function updateVisibility() {
    if (!form) return;
    const type = form.querySelector('[name="sourceType"]').value;
    for (const el of mountEl.querySelectorAll('[data-qu-content-section]')) {
      el.hidden = !el.getAttribute('data-qu-content-section').split(' ').includes(type);
    }
  }
  form?.querySelector('[name="sourceType"]')?.addEventListener('change', updateVisibility);

  async function refreshList() {
    if (!list) return;
    const routes = await resolver.resolveRoutes({ timeout: 500 });
    list.replaceChildren();
    if (routes.length === 0) {
      const li = doc.createElement('li');
      li.textContent = '(noch kein Inhalt)';
      list.appendChild(li);
      return;
    }
    for (const { route } of routes) {
      const li = doc.createElement('li');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = route;
      btn.addEventListener('click', async () => {
        activeEdit?.release();
        const { page, release } = await resolver.resolvePage(route, { timeout: 2000, hold: true });
        activeEdit = { release };
        if (!page) return;
        resetForm(form, ['route', 'name']);
        form.querySelector('[name="sourceType"]').value = 'html';
        enterEditMode(form, {
          keyFieldName: 'route',
          keyValue: route,
          fields: { template: page.template ?? '', content: page.content, data: page.data ? JSON.stringify(page.data, null, 2) : '', style: page.style ?? '', title: page.title },
        });
        updateVisibility();
      });
      li.appendChild(btn);

      // DELETE - self-owned, non-global only (`deleteGlobalPage()` doesn't exist yet - real,
      // deliberate follow-up work, see `dev.js`'s `deletePage()` doc comment for the scope this
      // shares with `deleteTemplate()`/`deleteStyle()`). Every listed route has a REAL wrapper page
      // underneath it regardless of whether it was authored via the "Text/HTML" or "Seiten-Filter/
      // Geteilte Liste" (View) picker above (`createView({route})`'s own "auto-creates a wrapper
      // page" behavior) - `deletePage()` is therefore the correct, sufficient delete for ANY row
      // here, the same uniform treatment the click-to-edit handler above already gives every route.
      // A View's own separate Node (its `sources`/`sortBy`/...) is untouched by this - deleting THAT
      // specifically (`deleteView()`, `dev.js`) is real, separate follow-up UI, not built here yet.
      if (!global) {
        const deleteBtn = doc.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.dataset.quCmsDelete = 'content';
        deleteBtn.textContent = 'Löschen';
        deleteBtn.addEventListener('click', async () => {
          setStatus(form, '');
          try {
            await deletePage(space, { route, timeout: 2000 });
            if (form.querySelector('[name="route"]')?.value.trim() === route) {
              activeEdit?.release();
              activeEdit = null;
              resetForm(form, ['route', 'name']);
            }
            await refreshList();
          } catch (err) {
            setStatus(form, `Fehler: ${err.message}`);
          }
        });
        li.appendChild(deleteBtn);
      }

      // EXTENSION POINT - a plugin (Blog "Duplizieren", a future Forum "Verschieben", ...) offers
      // extra per-row actions here, via `extensionPoints.collect('cms.pageActions', ...)`, WITHOUT
      // this file importing that plugin or knowing it exists (`extension-points.js`'s own top doc
      // comment). Each collected `{id, label, onClick}` becomes one more button in the SAME `<li>` -
      // a correct no-op (no extra buttons) when nothing has contributed to this point.
      const extraActions = await extensionPoints.collect('cms.pageActions', { route, page: pageKindHere, space, resolver, anchor, global });
      for (const action of extraActions) {
        const actionBtn = doc.createElement('button');
        actionBtn.type = 'button';
        actionBtn.dataset.quPageAction = action.id;
        actionBtn.textContent = action.label;
        actionBtn.addEventListener('click', () => action.onClick());
        li.appendChild(actionBtn);
      }

      list.appendChild(li);
    }
  }

  // JSON IMPORT (Phase 4's own "Import-Schema als String" ask) - a complete View definition,
  // pasted as one JSON object, populates the form's own fields WITHOUT saving anything - "Speichern"
  // still has to be clicked afterward, same as loading an existing item into the form does. `sources`
  // (if given) always round-trips through `sourcesOverride` (the raw-JSON escape hatch just below in
  // this same form, see its own doc comment on "takes full precedence when present") rather than
  // trying to reverse-engineer which of the simple picker fields (`listName`/`sourcePrefix`/
  // `pagesPrefix`) a multi-source or unusual single-source array should map onto - genuinely correct
  // for ANY `sources` shape the picker can express AND every shape it can't, with no special-casing.
  const importViewStatus = mountEl.querySelector('[data-qu-view-import-status]');
  if (importViewBtn && form) {
    importViewBtn.addEventListener('click', () => {
      const raw = mountEl.querySelector('[data-qu-view-import]')?.value.trim();
      if (importViewStatus) importViewStatus.textContent = '';
      if (!raw) return;
      let imported;
      try {
        imported = JSON.parse(raw);
      } catch (err) {
        if (importViewStatus) importViewStatus.textContent = `Kein gültiges JSON: ${err.message}`;
        return;
      }
      if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
        if (importViewStatus) importViewStatus.textContent = 'Erwartet ein JSON-OBJEKT (kein Array/Wert).';
        return;
      }
      if (!imported.name && !imported.route) {
        if (importViewStatus) importViewStatus.textContent = 'Mindestens "name" oder "route" wird benötigt.';
        return;
      }
      activeEdit?.release();
      activeEdit = null;
      resetForm(form, ['route', 'name']);
      form.querySelector('[name="sourceType"]').value = 'pages'; // reveals the shared shared-list/pages block - which picker value doesn't matter, sourcesOverride below takes precedence either way.
      form.querySelector('[name="route"]').value = imported.route ?? '';
      form.querySelector('[name="name"]').value = imported.name ?? '';
      form.querySelector('[name="sourcesOverride"]').value = imported.sources ? JSON.stringify(imported.sources) : '';
      form.querySelector('[name="viewTemplate"]').value = imported.template ?? '';
      if (imported.sortBy) form.querySelector('[name="sortBy"]').value = imported.sortBy;
      if (imported.sortOrder) form.querySelector('[name="sortOrder"]').value = imported.sortOrder;
      form.querySelector('[name="limit"]').value = imported.limit ?? '';
      form.querySelector('[name="itemTemplate"]').value = imported.itemTemplate ?? '';
      form.querySelector('[name="style"]').value = imported.style ?? '';
      updateVisibility();
      if (importViewStatus) importViewStatus.textContent = 'Übernommen - bitte prüfen und "Speichern" klicken.';
    });
  }

  if (loadViewBtn && form) {
    loadViewBtn.addEventListener('click', async () => {
      setStatus(form, '');
      const name = form.querySelector('[name="name"]').value.trim();
      if (!name) {
        setStatus(form, 'Bitte zuerst einen Namen eingeben.');
        return;
      }
      const { view, release } = await resolver.resolveView(name, { ownerPub: global ? undefined : anchor, timeout: 1500, hold: true });
      if (!view) {
        release();
        setStatus(form, `Keine View namens "${name}" gefunden.`);
        return;
      }
      activeEdit?.release();
      activeEdit = { release };
      // MORE than one source (or a source type the simple picker doesn't cover) round-trips through
      // the "Erweitert" JSON override instead of trying to force it back into the single-source
      // picker fields - see this file's own doc comment on `sourcesOverride` above.
      const isSimple = view.sources?.length === 1 && ['pages', 'shared-list'].includes(view.sources[0]?.type);
      const pagesSource = isSimple ? view.sources.find((s) => s.type === 'pages') : null;
      const listSource = isSimple ? view.sources.find((s) => s.type === 'shared-list') : null;
      resetForm(form, ['route', 'name']);
      form.querySelector('[name="sourceType"]').value = pagesSource ? 'pages' : 'shared-list';
      enterEditMode(form, {
        keyFieldName: 'name',
        keyValue: name,
        fields: {
          route: view.route ?? '',
          sourcePrefix: pagesSource?.ownerPrefix ?? '',
          pagesPrefix: pagesSource?.prefix ?? '',
          listName: listSource?.name ?? '',
          filter: listSource?.filter ? JSON.stringify(listSource.filter) : '',
          sourcesOverride: isSimple ? '' : JSON.stringify(view.sources),
          viewTemplate: view.template ?? '',
          sortBy: view.sortBy ?? '',
          sortOrder: view.sortOrder,
          limit: view.limit ?? '',
          itemTemplate: view.itemTemplate,
        },
      });
      // A View is keyed by NAME (locked above via keyFieldName), not route - but editView()/
      // editGlobalView() also never touch/move the wrapper page (their own "no rename support" doc
      // comment) - locking route TOO, defensively, so a save can never silently create a SECOND,
      // differently-routed wrapper page for the same View by accident.
      form.querySelector('[name="route"]').readOnly = true;
      updateVisibility();
    });
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus(form, '');
      try {
        const mode = form.querySelector('input[name="mode"]').value;
        const route = form.querySelector('[name="route"]').value.trim();
        const sourceType = form.querySelector('[name="sourceType"]').value;
        const style = form.querySelector('[name="style"]').value.trim() || null;

        if (sourceType === 'html') {
          if (!route) throw new Error('Pfad (Route) ist bei "Text/HTML" erforderlich - nur eine View kann ohne eigene Route (rein einbettbar) angelegt werden.');
          const title = form.querySelector('[name="title"]').value;
          const template = form.querySelector('[name="template"]').value.trim() || null;
          const content = form.querySelector('[name="content"]').value;
          const dataRaw = form.querySelector('[name="data"]').value.trim();
          let data = null;
          if (dataRaw) {
            try {
              data = JSON.parse(dataRaw);
            } catch (err) {
              throw new Error(`"Strukturierte Daten" ist kein gültiges JSON: ${err.message}`);
            }
          }
          if (global) {
            if (mode === 'edit') {
              const id = await deriveContentNodeId(anchor, pageKindHere.kind, route);
              await verifyWritesAcked(space, id, () => editGlobalPage(space, prefix, { route, title, template, content, data, style, timeout: 2000 }));
            } else {
              // PUBLISH THE ROUTE FIRST, THEN CREATE THE PAGE - see `wirePages()`'s own predecessor
              // doc comment (kept here verbatim in spirit): the relay's live resolver only classifies
              // a global page write correctly once it has observed the route in `adminRouteRegistryKind`.
              await publishGlobalRoute(space, prefix, { route, title });
              await new Promise((resolve) => setTimeout(resolve, 400));
              const id = await deriveContentNodeId(anchor, pageKindHere.kind, route);
              await verifyWritesAcked(space, id, () => createGlobalPage(space, prefix, { route, title, template, content, data, style }));
            }
          } else if (mode === 'edit') {
            const id = await deriveContentNodeId(anchor, pageKindHere.kind, route);
            await verifyWritesAcked(space, id, () => editPage(space, { route, title, template, content, data, style, ownerPub: anchor, timeout: 2000 }));
          } else {
            const id = await deriveContentNodeId(space.identity.signingPub, pageKindHere.kind, route);
            await verifyWritesAcked(space, id, () => createPage(space, { route, title, template, content, data, style }));
            await publishRoute(space, { route, title });
          }
        } else {
          // "shared-list" / "pages" -> View semantics, keyed by NAME (derived from `route` when blank
          // - this file's own top doc comment on why). An EMBED-ONLY View (no route at all) has
          // nothing to derive a name FROM - a typed name is required in that case specifically, or
          // every unnamed embed-only View created this way would collide on the same "index" default.
          const typedName = form.querySelector('[name="name"]').value.trim();
          if (!route && !typedName) throw new Error('Ohne Pfad (Route) ist ein Name erforderlich, um Kollisionen zwischen mehreren einbettbaren Views zu vermeiden.');
          const name = typedName || route.replace(/^\/+/, '').replace(/\//g, '-') || 'index';
          const viewTemplate = form.querySelector('[name="viewTemplate"]').value.trim() || null;
          const sortBy = form.querySelector('[name="sortBy"]').value.trim() || null;
          const sortOrder = form.querySelector('[name="sortOrder"]').value;
          const limitRaw = form.querySelector('[name="limit"]').value.trim();
          const limit = limitRaw ? Number(limitRaw) : null;
          const itemTemplate = form.querySelector('[name="itemTemplate"]').value;

          let sources;
          const overrideRaw = form.querySelector('[name="sourcesOverride"]').value.trim();
          if (overrideRaw) {
            // ADVANCED ESCAPE HATCH - combining MULTIPLE, possibly mixed-type sources in one View
            // (the framework's own flagship "a Blog + Guestbook combined feed" example,
            // architecture.md's own "Shared lists ... and Views" section) needs more than the single
            // shared-list-OR-pages picker above can express at once - this raw JSON array is that
            // "no, really, give me the full sources array" override, taking full precedence when
            // present. The picker above stays the primary, common-case UX for the far more frequent
            // single-source View.
            try {
              sources = JSON.parse(overrideRaw);
            } catch (err) {
              throw new Error(`"Erweitert - mehrere Quellen" ist kein gültiges JSON: ${err.message}`);
            }
          } else if (sourceType === 'shared-list') {
            const listName = form.querySelector('[name="listName"]').value.trim();
            const filterRaw = form.querySelector('[name="filter"]').value.trim();
            let filter;
            if (filterRaw) {
              try {
                filter = JSON.parse(filterRaw);
              } catch (err) {
                throw new Error(`"Filter" ist kein gültiges JSON: ${err.message}`);
              }
            }
            sources = [{ type: 'shared-list', name: listName, ...(filter ? { filter } : {}) }];
          } else {
            const sourcePrefix = form.querySelector('[name="sourcePrefix"]').value.trim();
            const pagesPrefix = form.querySelector('[name="pagesPrefix"]').value.trim();
            sources = [{ type: 'pages', ...(pagesPrefix ? { prefix: pagesPrefix } : {}), ...(sourcePrefix ? { ownerPrefix: sourcePrefix } : {}) }];
          }

          const id = await deriveContentNodeId(anchor, viewKindHere.kind, name);
          if (global) {
            if (mode === 'edit') {
              await verifyWritesAcked(space, id, () => editGlobalView(space, prefix, { name, route: route || null, template: viewTemplate, sources, sortBy, sortOrder, limit, itemTemplate, timeout: 2000 }));
            } else {
              // A NEW View's name has to be told to the relay BEFORE writing it - `dev.js`'s
              // `addGlobalViewNames()` own doc comment on why.
              await addGlobalViewNames(space, { prefix, globalViewNames: [name] });
              await new Promise((resolve) => setTimeout(resolve, 400));
              await verifyWritesAcked(space, id, () => createGlobalView(space, prefix, { name, route: route || null, template: viewTemplate, sources, sortBy, sortOrder, limit, itemTemplate, style }));
            }
          } else if (mode === 'edit') {
            await verifyWritesAcked(space, id, () => editView(space, { name, ownerPub: anchor, route: route || null, template: viewTemplate, sources, sortBy, sortOrder, limit, itemTemplate, timeout: 2000 }));
          } else {
            await verifyWritesAcked(space, id, () => createView(space, { name, route: route || null, template: viewTemplate, sources, sortBy, sortOrder, limit, itemTemplate, style }));
          }
        }
        setStatus(form, route ? `Gespeichert und vom Relay bestätigt. Erreichbar unter "${route}".` : 'Gespeichert und vom Relay bestätigt.');
        await refreshList();
      } catch (err) {
        setStatus(form, `Fehler: ${err.message}`);
      }
    });
  }
  if (resetBtn && form) {
    resetBtn.addEventListener('click', () => {
      activeEdit?.release();
      activeEdit = null;
      resetForm(form, ['route', 'name']);
      updateVisibility();
    });
  }

  // Everything below has its own AWAIT, on purpose placed AFTER every listener above is already
  // attached (this file's own top doc comment on why) - `anchor` is assigned here but not actually
  // read until a later user interaction, long after this line runs.
  anchor = global ? await globalAppAnchor(prefix) : ownerPub;
  holdRegistry(space, global ? adminRouteRegistryKind : routeRegistryKind, anchor).catch(() => {}); // see wireTemplates()'s own identical comment.
  if (!global) await refreshTemplateSelect({ mountEl, doc, resolver });
  await refreshList();
}

/** Re-reads every template name into the Content form's own `<select name="template">` - called once at wiring time (this editor no longer lives on the SAME page as the Templates section, so a template saved elsewhere only appears here after the NEXT page load - an accepted consequence of splitting sections into separate routes, not a regression: `wireTemplates()`'s own list is one `router.navigate()` away). */
async function refreshTemplateSelect({ mountEl, doc, resolver }) {
  const select = mountEl.querySelector('form[data-qu-action="cms-content-form"] select[name="template"]');
  if (!select) return;
  const templates = await resolver.resolveTemplateNames({ timeout: 500 });
  const none = doc.createElement('option');
  none.value = '';
  none.textContent = '(keins)';
  select.replaceChildren(none);
  for (const { name } of templates) {
    const option = doc.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
}

registerAdminSection({ id: 'templates', label: 'Templates', order: 10, buildPageContent: () => TEMPLATES_PAGE_CONTENT, wire: wireTemplates });
registerAdminSection({ id: 'styles', label: 'Styles', order: 20, buildPageContent: () => STYLES_PAGE_CONTENT, wire: wireStyles });
registerAdminSection({ id: 'content', label: 'Inhalt (Seiten & Views)', order: 30, buildPageContent: () => CONTENT_PAGE_CONTENT, wire: wireContent });

/**
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, appAdminPub: Uint8Array, global?: boolean, prefix?: string}} params
 *   `space`/`appAdminPub` - the app whose content is being managed: the
 *   VISITING identity is `space.identity` (may or may not be `appAdminPub`
 *   itself or a granted co-editor - see `cms-bundle.js`'s own doc comment
 *   on why this file never tries to tell the difference client-side).
 *   `global`/`prefix` - `boot.js`'s `startPlatform()` passes these for any
 *   `realm: 'global'` app OTHER than the built-in admin console itself
 *   (which gets `wireAdminConsole()` instead, see that file's own doc
 *   comment) - `appAdminPub` is then `globalAppAnchor(prefix)`, not a real
 *   identity, and pages resolve/write through the `qu-admin-*` Kinds
 *   (`adminPageKind`/`adminRouteRegistryKind`) any configured relay-admin
 *   may use, not just whoever created a given page.
 */
export async function wireCms({ mountEl, doc, space, appAdminPub, global = false, prefix }) {
  wireCmsNav(mountEl, doc);
  const resolver = new ContentResolver(space, { appAdminPub, kinds: global ? { pageKind: adminPageKind, routeRegistryKind: adminRouteRegistryKind, viewKind: adminViewKind } : undefined });
  // Non-global only - a global app's writes already target the right id through `prefix`/
  // `globalAppAnchor()` (createGlobalPage()/etc. take no ownerPub at all), so passing appAdminPub
  // (there, `globalAppAnchor(prefix)` - not a real identity) down as `ownerPub` too would be
  // redundant, not wrong, but wireTemplates()/wireStyles() already return early for global regardless.
  const ownerPub = global ? undefined : appAdminPub;
  await Promise.all(listAdminSections().map((section) => section.wire({ mountEl, doc, space, resolver, global, prefix, ownerPub })));
}
