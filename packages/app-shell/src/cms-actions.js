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
 * to catch it, and nothing would appear to happen at all.
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
  deriveContentNodeId,
  templateKind,
  styleKind,
  pageKind,
  routeRegistryKind,
  templateRegistryKind,
  styleRegistryKind,
} from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';

/** See this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...". Releases `previous` (if any) THEN opens+holds a fresh subscription for `(kind, name)`, owned by `space.identity` (the same default `ownerPub` `editTemplate()`/`editStyle()`/`editPage()` themselves use). @returns {Promise<{node: object, release: () => void}>} */
async function holdEdit(space, kind, name, previous) {
  previous?.release();
  const id = await deriveContentNodeId(space.identity.signingPub, kind.kind, name);
  return space.useNode(id, kind);
}

/** See this file's own top doc comment, "KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE...". Opens (and never releases - see that comment on why) a subscription to this identity's OWN `registryKind` Node, so every later `refreshList()`/`registerContentName()`/`publishRoute()` call in the same CMS session finds it already attached. */
async function holdRegistry(space, registryKind) {
  const id = await deriveOwnerNodeId(space.identity.signingPub, registryKind.kind);
  return space.useNode(id, registryKind);
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

async function wireTemplates({ mountEl, doc, space, resolver }) {
  const list = mountEl.querySelector('[data-qu-bind="cms-template-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-template-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="template"]');
  if (!list && !form) return;

  // Fire-and-forget, started BEFORE the submit listener below attaches (same synchronous-first-tick
  // reasoning as _sendSubscribeRequest()'s own posture elsewhere) - see this file's own top doc
  // comment, "KEEPING EACH SECTION'S OWN REGISTRY SUBSCRIPTION ALIVE...".
  holdRegistry(space, templateRegistryKind).catch(() => {});
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
        activeEdit = await holdEdit(space, templateKind, name, activeEdit);
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
        if (mode === 'edit') await editTemplate(space, { name, html, timeout: 2000 });
        else await createTemplate(space, { name, html });
        setStatus(form, 'Gespeichert. Falls du berechtigt bist, ist die Änderung jetzt im Space.');
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

async function wireStyles({ mountEl, doc, space, resolver }) {
  const list = mountEl.querySelector('[data-qu-bind="cms-style-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-style-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="style"]');
  if (!list && !form) return;

  holdRegistry(space, styleRegistryKind).catch(() => {}); // see wireTemplates()'s own identical comment.
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
        activeEdit = await holdEdit(space, styleKind, name, activeEdit);
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
        if (mode === 'edit') await editStyle(space, { name, css, timeout: 2000 });
        else await createStyle(space, { name, css });
        setStatus(form, 'Gespeichert. Falls du berechtigt bist, ist die Änderung jetzt im Space.');
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

async function wirePages({ mountEl, doc, space, resolver }) {
  const list = mountEl.querySelector('[data-qu-bind="cms-page-list"]');
  const form = mountEl.querySelector('form[data-qu-action="cms-page-form"]');
  const resetBtn = mountEl.querySelector('[data-qu-cms-reset="page"]');
  if (!list && !form) return;

  holdRegistry(space, routeRegistryKind).catch(() => {}); // see wireTemplates()'s own identical comment.
  await refreshTemplateSelect({ mountEl, doc, resolver });

  let activeEdit = null; // see this file's own top doc comment, "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE...".

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
        activeEdit = await holdEdit(space, pageKind, route, activeEdit);
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
        if (mode === 'edit') {
          await editPage(space, { route, title, template, content, data, timeout: 2000 });
        } else {
          await createPage(space, { route, title, template, content, data });
          await publishRoute(space, { route, title });
        }
        setStatus(form, 'Gespeichert. Falls du berechtigt bist, ist die Änderung jetzt im Space.');
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

  await refreshList();
}

/**
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, appAdminPub: Uint8Array}} params
 *   `space`/`appAdminPub` - the app whose content is being managed: the
 *   VISITING identity is `space.identity` (may or may not be `appAdminPub`
 *   itself or a granted co-editor - see `cms-bundle.js`'s own doc comment
 *   on why this file never tries to tell the difference client-side).
 */
export async function wireCms({ mountEl, doc, space, appAdminPub }) {
  const resolver = new ContentResolver(space, { appAdminPub });
  await Promise.all([
    wireTemplates({ mountEl, doc, space, resolver }),
    wireStyles({ mountEl, doc, space, resolver }),
    wirePages({ mountEl, doc, space, resolver }),
  ]);
}
