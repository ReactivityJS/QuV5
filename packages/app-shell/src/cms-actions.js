/**
 * CMS ACTIONS — the framework-provided interactivity `cms-bundle.js`'s own
 * inert markup attaches to by CONVENTION, mirroring `admin-actions.js`'s
 * `wireAdminConsole()` exactly (same "content stays inert markup, framework
 * code wires ordinary DOM elements a content author declared by attribute"
 * posture, itself mirroring `@qu/space-ui`'s `bindField()`/`bindCheckbox()`).
 * `boot.js` calls `wireCms()` unconditionally after every `renderPage()` -
 * cheap (a handful of `querySelector` calls) and a correct no-op whenever
 * the rendered page isn't the CMS editor (no matching elements found).
 *
 * Three independent sections (templates/styles/pages), each the same shape:
 * a `[data-qu-bind="cms-<kind>-list"]` list (populated once, at wiring
 * time - not live-reactive, matching `wireAdminConsole()`'s own posture),
 * where clicking an entry loads its CURRENT content into the matching
 * `[data-qu-action="cms-<kind>-form"]` form and switches it into "edit"
 * mode (the item's own name/route becomes read-only - `editTemplate()`/
 * `editStyle()`/`editPage()` all require the EXACT existing key, changing
 * it would target a different, likely-nonexistent Node rather than
 * "rename" anything, see dev.js's own doc comments); a `[data-qu-cms-reset]`
 * button clears the form back to "create" mode. WRITE-ACL, not this file,
 * is what actually gates a save - see `cms-bundle.js`'s own doc comment.
 *
 * `wireCms()` starts all three sections' `wire*()` calls TOGETHER
 * (`Promise.all`), never one `await`ed after another: each `wire*()`
 * attaches its own form's submit listener SYNCHRONOUSLY, before its first
 * `await` - but its OWN list refresh right after can take up to that
 * list's `resolveTemplateNames()`/`resolveStyleNames()`/`resolveRoutes()`
 * call's full `timeout` (500ms) when the registry doesn't exist yet (a
 * brand new app, nothing created through the CMS at all so far - `waitFor()`
 * in resolver.js has no "it's empty" shortcut, it only gives up once the
 * clock runs out). Sequencing `wireStyles()` to start only once
 * `wireTemplates()` fully finished (its own list-refresh included) would
 * leave the STYLE form's submit listener unattached for that entire
 * stretch - a visitor filling in the style form within roughly the first
 * 500ms of the page existing would submit into dead air, no listener yet
 * to catch it, and nothing would appear to happen at all. `wirePages()`
 * ONCE genuinely violated this same invariant for ITSELF (its own
 * `refreshTemplateSelect()`/`globalAppAnchor()` awaits used to run BEFORE
 * its listener attachment, not after) - a real, deployment-observed bug,
 * not hypothetical: a self-provisioned first-time visitor (`boot.js`'s
 * `renderMultiUserRoute()`) with a genuinely-empty template registry could
 * submit into that same "no listener yet" dead air for the ENTIRE 500ms
 * `resolveTemplateNames()` wait. Fixed - see that function's own doc
 * comment.
 *
 * KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE BETWEEN "load into form" AND
 * "save" - a real, observed bug this fixes: `Space.useNode()` is
 * ref-counted, and `ContentResolver`'s own `resolveTemplate()`/
 * `resolveStyle()`/`resolvePage()` (used by each section's click handler,
 * just below, purely to populate the form) each call `useNode()` THEN
 * `release()` internally, dropping the refcount straight back to zero -
 * which `Space.unsubscribeNode()` treats as "nobody needs this Node
 * locally any more" and DISCARDS the local Y.Doc entirely (`space.js`'s own
 * `_nodes.delete(id)`), not merely stops live-pushing to it. Submitting the
 * form moments later calls `editTemplate()`/`editStyle()`/`editPage()`
 * (dev.js), which does its OWN fresh `useNode()` - since the previous one
 * was fully torn down, this has to re-subscribe and wait for the relay to
 * replay the Node's entire history again, a real network round-trip a
 * fixed ~2s timeout can genuinely lose to over a real (non-localhost)
 * connection, throwing "does not exist (or has not synced)" for content
 * that plainly DOES exist - the user just viewed it. Each section below
 * calls `space.useNode()` itself, ONE EXTRA TIME, the moment an item is
 * loaded into the form (`holdEdit()`), and keeps that reference alive
 * (`activeEdit`) until a DIFFERENT item is loaded or the form is reset -
 * long enough to keep the refcount above zero (so nothing gets discarded)
 * for the entire "loaded into the form, being edited" window, without
 * changing `ContentResolver`'s own release-immediately posture (correct
 * for ordinary rendering, where holding every resolved Node open would
 * leak subscriptions across a visitor's whole session).
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
} from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';

/** See this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...". Releases `previous` (if any) THEN opens+holds a fresh subscription for `(kind, name)`, owned by `ownerPub` (defaults to `space.identity` - the same default `editTemplate()`/`editStyle()`/`editPage()` themselves use; a GLOBAL page passes `globalAppAnchor(prefix)` instead, see `wirePages()`'s own global-mode branch). @returns {Promise<{node: object, release: () => void}>} */
async function holdEdit(space, kind, name, previous, ownerPub = space.identity.signingPub) {
  previous?.release();
  const id = await deriveContentNodeId(ownerPub, kind.kind, name);
  return space.useNode(id, kind);
}

/** See this file's own top doc comment, "KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE...". Opens (and never releases - see that comment on why) a subscription to `ownerPub`'s `registryKind` Node (defaults to `space.identity` - a GLOBAL app's registry passes `globalAppAnchor(prefix)` instead), so every later `refreshList()`/`registerContentName()`/`publishRoute()`/`publishGlobalRoute()` call in the same CMS session finds it already attached. */
async function holdRegistry(space, registryKind, ownerPub = space.identity.signingPub) {
  const id = await deriveOwnerNodeId(ownerPub, registryKind.kind);
  return space.useNode(id, registryKind);
}

/**
 * A REAL, deployment-observed failure class this exists to catch: a save
 * that silently never reaches the relay at all - most commonly, a write
 * REJECTED because the signed-in identity is neither `nodeId`'s owner nor
 * an explicitly `grantContentWriter()`ed co-editor. `Space.editTemplate()`/
 * `editStyle()`/`editPage()`/`createTemplate()`/`createStyle()`/
 * `createPage()` all apply their own field mutations to the LOCAL Y.Doc
 * synchronously and return - `await`ing any of them only proves the LOCAL
 * mutation happened, never that the relay accepted it (relay.js's own
 * `acceptWrite()` sends a `write-ack` on success; a REJECTED write gets no
 * reply of any kind - see relay.js's own "WRITE-ACK" doc comment). Without
 * this, the CMS form showed "Gespeichert" (this file's own hardcoded
 * success message) the instant the local mutation applied, REGARDLESS of
 * whether the relay ever actually accepted it - the exact "stillschweigend...
 * die Seite ist anschließend nicht verfügbar" failure class this whole
 * effort started from, just one level deeper than the ones already fixed
 * elsewhere (`install-admin-console.mjs`'s own former silent-success bug).
 * The symptom this produces is genuinely confusing without this check:
 * the edited value stays visible in the form/rendered page until the next
 * reload (the local Y.Doc still holds the optimistic mutation), then
 * reverts, because the relay's own mirror - what a reload actually re-syncs
 * from - never had it.
 *
 * Watches `nodeId`'s own `debug.space.write.local`/`space.node.<id>.write-ack`
 * pair on `space`'s own `bus` (`Space`'s own `bus` getter) WHILE `fn()` runs,
 * then waits up to `timeout` for every local write it counted to be acked -
 * throws a clear, actionable error instead of resolving silently if even
 * one wasn't. No-ops (skips verification, same as before this existed) if
 * `space` has no `bus` configured at all (still true of some test setups) -
 * can't verify what it can't observe, and that must never make an
 * otherwise-working save start throwing.
 * @param {import('@qu/space-core').Space} space
 * @param {string} nodeId - the SAME id `fn()`'s own write(s) target.
 * @param {() => Promise<*>} fn
 */
async function verifyWritesAcked(space, nodeId, fn, { timeout = 3000 } = {}) {
  const bus = space.bus;
  if (!bus) return fn();
  let expected = 0;
  let acked = 0;
  const offLocal = bus.on('debug.space.write.local', (payload) => {
    if (payload?.nodeId === nodeId) expected++;
  });
  const offAck = bus.on(`space.node.${nodeId}.write-ack`, () => {
    acked++;
  });
  try {
    const result = await fn();
    // `fn()` resolving proves only that its OWN field.set()/replaceText() calls returned - Yjs's
    // `doc.on('update', ...)` (space.js's own `_handleLocalUpdate()`) fires SYNCHRONOUSLY but is
    // itself `async` (sealing an envelope is real crypto work) and is never awaited by the write
    // that triggered it, so `debug.space.write.local` for THIS save can still be several
    // microtasks/one real async hop away from having fired at all - `expected` itself needs a
    // moment to catch up before comparing it against `acked` means anything, the same "settle"
    // margin `bootstrap-platform.mjs`'s own `waitUntilAllWritesAcked()` already bakes in for the
    // identical reason, just applied before the FIRST check here instead of only before it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const deadline = Date.now() + timeout;
    while (acked < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (acked < expected) {
      throw new Error(
        'Speichern wurde vom Relay nicht bestätigt - die Änderung bleibt nur lokal sichtbar und geht bei einem Reload verloren. ' +
          'Meist bedeutet das: die aktuell angemeldete Identität ist weder der Owner dieses Inhalts noch wurde ihr per grantContentWriter() Schreibzugriff gewährt.'
      );
    }
    return result;
  } finally {
    offLocal();
    offAck();
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
  const keyInput = form.querySelector(`[name="${keyFieldName}"]`);
  if (keyInput) keyInput.readOnly = false;
  setStatus(form, '');
}

/**
 * Re-reads every template name into the PAGE form's own `<select
 * name="template">` - called both at initial wiring AND after every
 * successful template save (`wireTemplates()`'s own submit handler), never
 * only once: a template created (or renamed away, though this editor has
 * no rename) THROUGH THIS SAME PAGE, in the same visit, must be pickable
 * for a page without forcing a reload - the one live-refresh this editor
 * does, everywhere else deliberately staying the same one-shot-at-wiring-
 * time posture `wireAdminConsole()` already established. Preserves the
 * currently selected value where still valid (falls back to `''`/"(keins)"
 * otherwise) so mid-edit page-form state survives a template being saved
 * in another section.
 */
async function refreshTemplateSelect({ mountEl, doc, resolver }) {
  const select = mountEl.querySelector('form[data-qu-action="cms-page-form"] select[name="template"]');
  if (!select) return;
  const current = select.value;
  const templates = await resolver.resolveTemplateNames({ timeout: 500 });
  select.replaceChildren();
  const none = doc.createElement('option');
  none.value = '';
  none.textContent = '(keins)';
  select.appendChild(none);
  for (const { name } of templates) {
    const option = doc.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = current;
}

/**
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, resolver: ContentResolver, global?: boolean, ownerPub?: Uint8Array}} params
 *   `ownerPub` - the app's REAL owner pubkey (`wireCms()`'s own `appAdminPub`, see its doc comment) -
 *   REQUIRED for editing to ever work for anyone other than whichever identity happens to be
 *   `space.identity` right now. A real, deployment-observed bug this fixes: every `holdEdit()`/
 *   `holdRegistry()`/`edit*()` call below used to omit `ownerPub` entirely, silently defaulting to
 *   `space.identity.signingPub` (dev.js's own default) - the browsing VISITOR's own identity, not
 *   the app's actual owner. Listing/reading (`resolver.resolve*()`, constructed with the correct
 *   `appAdminPub` in `wireCms()`) was never affected - only writes were - so the list/form correctly
 *   SHOWED an app-admin's existing content while a save (`edit*()`) computed an entirely different,
 *   nonexistent Node id from the visitor's own pubkey instead, throwing "does not exist" for content
 *   that plainly does. This is the exact scenario `grantContentWriter()`/`editPage()`'s own `ownerPub`
 *   parameter exists for (dev.js's own doc comment) - it was simply never threaded through from this
 *   UI at all, making a granted co-editor's save fail identically to an unauthorized one's, with no
 *   way to tell the two apart. Still relies entirely on the RELAY's own write-ACL to reject an
 *   actually-unauthorized save (this file's own top doc comment, "WRITE-ACL, not this file, is what
 *   actually gates a save") - passing the correct `ownerPub` only fixes the intended CASE (the real
 *   owner, or a real grantee, signed in with THEIR OWN identity) from failing for the wrong reason.
 */
async function wireTemplates({ mountEl, doc, space, resolver, global, ownerPub }) {
  // Global apps have no template REGISTRY yet (kinds.js's own "GLOBAL APP CONTENT" doc comment -
  // "TEMPLATES/STYLES stay a smaller, more static set for global apps for now," matching the
  // priority the user themselves set: pages first, templates/styles optional) - a deliberate,
  // documented scope cut, not an oversight. Skip wiring this section entirely rather than half-wire
  // a list that can never enumerate anything.
  if (global) return;
  const list = mountEl.querySelector('[data-qu-bind="cms-template-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-template-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="template"]');
  if (!list && !form) return;

  // Fire-and-forget, started BEFORE the submit listener below attaches (same synchronous-first-tick
  // reasoning as _sendSubscribeRequest()'s own posture elsewhere) - see this file's own top doc
  // comment, "KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE...".
  holdRegistry(space, templateRegistryKind, ownerPub).catch(() => {});
  let activeEdit = null; // see this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...".

  async function refreshList() {
    if (!list) return;
    const templates = await resolver.resolveTemplateNames({ timeout: 500 });
    list.replaceChildren();
    if (templates.length === 0) {
      const li = doc.createElement('li');
      li.textContent = '(noch kein Template)';
      list.appendChild(li);
      return;
    }
    for (const { name } of templates) {
      const li = doc.createElement('li');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', async () => {
        activeEdit = await holdEdit(space, templateKind, name, activeEdit, ownerPub);
        const html = (await resolver.resolveTemplate(name, { timeout: 2000 })) ?? '';
        enterEditMode(form, { keyFieldName: 'name', keyValue: name, fields: { html } });
      });
      li.appendChild(btn);
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
        const html = form.querySelector('[name="html"]').value;
        if (mode === 'edit') {
          const id = await deriveContentNodeId(ownerPub ?? space.identity.signingPub, templateKind.kind, name);
          await verifyWritesAcked(space, id, () => editTemplate(space, { name, html, ownerPub, timeout: 2000 }));
        } else {
          const id = await deriveContentNodeId(space.identity.signingPub, templateKind.kind, name);
          await verifyWritesAcked(space, id, () => createTemplate(space, { name, html }));
        }
        setStatus(form, 'Gespeichert und vom Relay bestätigt.');
        await Promise.all([refreshList(), refreshTemplateSelect({ mountEl, doc, resolver })]);
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

/** See `wireTemplates()`'s own doc comment on `ownerPub` - identical reasoning here. */
async function wireStyles({ mountEl, doc, space, resolver, global, ownerPub }) {
  if (global) return; // see wireTemplates()'s own identical comment.
  const list = mountEl.querySelector('[data-qu-bind="cms-style-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-style-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="style"]');
  if (!list && !form) return;

  holdRegistry(space, styleRegistryKind, ownerPub).catch(() => {}); // see wireTemplates()'s own identical comment.
  let activeEdit = null; // see this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...".

  async function refreshList() {
    if (!list) return;
    const styles = await resolver.resolveStyleNames({ timeout: 500 });
    list.replaceChildren();
    if (styles.length === 0) {
      const li = doc.createElement('li');
      li.textContent = '(noch kein Style)';
      list.appendChild(li);
      return;
    }
    for (const { name } of styles) {
      const li = doc.createElement('li');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = name;
      btn.addEventListener('click', async () => {
        activeEdit = await holdEdit(space, styleKind, name, activeEdit, ownerPub);
        const css = (await resolver.resolveStyle(name, { timeout: 2000 })) ?? '';
        enterEditMode(form, { keyFieldName: 'name', keyValue: name, fields: { css } });
      });
      li.appendChild(btn);
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
        const css = form.querySelector('[name="css"]').value;
        if (mode === 'edit') {
          const id = await deriveContentNodeId(ownerPub ?? space.identity.signingPub, styleKind.kind, name);
          await verifyWritesAcked(space, id, () => editStyle(space, { name, css, ownerPub, timeout: 2000 }));
        } else {
          const id = await deriveContentNodeId(space.identity.signingPub, styleKind.kind, name);
          await verifyWritesAcked(space, id, () => createStyle(space, { name, css }));
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

/**
 * ORDERING WITHIN THIS FUNCTION MATTERS, a real bug this fixes: the submit/
 * reset listeners below are attached BEFORE `anchor` is computed
 * (`globalAppAnchor()`, an `await`) and before `holdRegistry()`/
 * `refreshTemplateSelect()` run - matching this file's own top doc comment
 * invariant ("each `wire*()` attaches its own form's submit listener
 * SYNCHRONOUSLY, before its first `await`"), which an earlier version of
 * THIS function specifically violated (those awaits used to run FIRST).
 * Safe to compute `anchor` afterward: the listeners that close over it
 * only ever READ it once a real submit/click event fires, unavoidably
 * long after this whole function has already finished running.
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, resolver: ContentResolver, global?: boolean, prefix?: string, ownerPub?: Uint8Array}} params
 *   `global`/`prefix` - see `wireCms()`'s own doc comment. In global mode,
 *   every write goes through `createGlobalPage()`/`editGlobalPage()`/
 *   `publishGlobalRoute()` (`@qu/app-core`'s Dev API) instead of the
 *   ordinary per-owner `createPage()`/`editPage()`/`publishRoute()` - ANY
 *   configured relay-admin may then create/edit ANY page under this app,
 *   not just whoever happened to create it first (kinds.js's own "GLOBAL
 *   APP CONTENT" doc comment) - `refreshTemplateSelect()` is skipped
 *   entirely here (no template registry for global apps yet, see
 *   `wireTemplates()`'s own doc comment on that scope cut). `ownerPub` (non-
 *   global only) - see `wireTemplates()`'s own doc comment on why editing
 *   needs it explicitly, not just `space.identity`'s default.
 */
async function wirePages({ mountEl, doc, space, resolver, global = false, prefix, ownerPub }) {
  const list = mountEl.querySelector('[data-qu-bind="cms-page-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-page-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="page"]');
  if (!list && !form) return;

  // `anchor` is only actually READ once a submit/click handler below RUNS (real user interaction,
  // always long after this whole function has finished) - safe to compute it AFTER attaching the
  // listeners that close over it (a `const` is only unusable before its OWN assignment runs, not
  // before every closure that later reads it does - see this function's own doc comment on why the
  // listener-attachment order below matters at all: a real, deployment-observed bug, not a style
  // preference).
  let activeEdit = null; // see this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...".
  let anchor; // assigned below, before any AWAIT that could let an event actually fire first.

  async function refreshList() {
    if (!list) return;
    const routes = await resolver.resolveRoutes({ timeout: 500 });
    list.replaceChildren();
    if (routes.length === 0) {
      const li = doc.createElement('li');
      li.textContent = '(noch keine Seite veröffentlicht)';
      list.appendChild(li);
      return;
    }
    for (const { route } of routes) {
      const li = doc.createElement('li');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = route;
      btn.addEventListener('click', async () => {
        activeEdit = await holdEdit(space, global ? adminPageKind : pageKind, route, activeEdit, anchor);
        const page = await resolver.resolvePage(route, { timeout: 2000 });
        if (!page) return;
        enterEditMode(form, {
          keyFieldName: 'route',
          keyValue: route,
          fields: { title: page.title, template: page.template ?? '', content: page.content, data: page.data ? JSON.stringify(page.data, null, 2) : '' },
        });
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setStatus(form, '');
      try {
        const mode = form.querySelector('input[name="mode"]').value;
        const route = form.querySelector('[name="route"]').value.trim();
        const title = form.querySelector('[name="title"]').value;
        const template = form.querySelector('[name="template"]').value || null;
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
        const pageKindHere = global ? adminPageKind : pageKind;
        if (global) {
          if (mode === 'edit') {
            const id = await deriveContentNodeId(anchor, pageKindHere.kind, route);
            await verifyWritesAcked(space, id, () => editGlobalPage(space, prefix, { route, title, template, content, data, timeout: 2000 }));
          } else {
            // PUBLISH THE ROUTE FIRST, THEN CREATE THE PAGE - order matters here, the same "register
            // before seeding" reasoning bootstrap-platform.mjs's own doc comment documents for a
            // brand-new app-admin: the relay's live resolver (live-app-resolver.js) only classifies
            // a page under this global app as `adminPageKind` ('relay-admins'-ACL) once it has
            // observed the route in `adminRouteRegistryKind` - creating the page FIRST would race
            // that write against a still-stale classification, silently rejected as the generic
            // 'content'-ACL fallback (no grant for this anchor-derived id exists, or ever will).
            // The settle delay gives the relay's own internal watcher time to actually rebuild
            // before the page write follows - the SAME margin bootstrap-platform.mjs's own explicit
            // wait-for-ack-plus-settle uses. `verifyWritesAcked()` (space.bus, now available) confirms
            // the page write itself actually landed, rather than just hoping the delay was enough.
            await publishGlobalRoute(space, prefix, { route, title });
            await new Promise((resolve) => setTimeout(resolve, 400));
            const id = await deriveContentNodeId(anchor, pageKindHere.kind, route);
            await verifyWritesAcked(space, id, () => createGlobalPage(space, prefix, { route, title, template, content, data }));
          }
        } else if (mode === 'edit') {
          const id = await deriveContentNodeId(anchor, pageKindHere.kind, route);
          await verifyWritesAcked(space, id, () => editPage(space, { route, title, template, content, data, ownerPub, timeout: 2000 }));
        } else {
          const id = await deriveContentNodeId(space.identity.signingPub, pageKindHere.kind, route);
          await verifyWritesAcked(space, id, () => createPage(space, { route, title, template, content, data }));
          await publishRoute(space, { route, title });
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
      resetForm(form, 'route');
    });
  }

  // Everything below has its own AWAIT, on purpose placed AFTER every listener above is already
  // attached (this function's own top doc comment on why) - `anchor` is assigned here but not
  // actually read until a later user interaction, long after this line runs.
  anchor = global ? await globalAppAnchor(prefix) : ownerPub;
  holdRegistry(space, global ? adminRouteRegistryKind : routeRegistryKind, anchor).catch(() => {}); // see wireTemplates()'s own identical comment.
  if (!global) await refreshTemplateSelect({ mountEl, doc, resolver });
  await refreshList();
}

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
 *   may use, not just whoever created a given page - see `wirePages()`'s
 *   own doc comment.
 */
export async function wireCms({ mountEl, doc, space, appAdminPub, global = false, prefix }) {
  const resolver = new ContentResolver(space, { appAdminPub, kinds: global ? { pageKind: adminPageKind, routeRegistryKind: adminRouteRegistryKind } : undefined });
  // Non-global only - a global app's writes already target the right id through `prefix`/
  // `globalAppAnchor()` (createGlobalPage()/etc. take no ownerPub at all), so passing appAdminPub
  // (there, `globalAppAnchor(prefix)` - not a real identity) down as `ownerPub` too would be
  // redundant, not wrong, but wireTemplates()/wireStyles() already return early for global regardless.
  const ownerPub = global ? undefined : appAdminPub;
  await Promise.all([
    wireTemplates({ mountEl, doc, space, resolver, global, ownerPub }),
    wireStyles({ mountEl, doc, space, resolver, global, ownerPub }),
    wirePages({ mountEl, doc, space, resolver, global, prefix, ownerPub }),
  ]);
}
