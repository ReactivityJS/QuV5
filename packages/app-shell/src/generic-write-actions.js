/**
 * GENERIC WRITE ACTIONS — the fully declarative counterpart to
 * `guestbook-actions.js`/`blog-actions.js`'s own hand-written, app-specific
 * wiring: ONE `data-qu-action="qu-write"` convention any Template/Page
 * content can use to push a shared-list entry or publish a page, purely
 * through ATTRIBUTES, no per-app JS file needed at all. This is the piece
 * `docs/example-apps.md`'s own §5 ("Building an app entirely through the
 * admin console") used to call out as the one remaining gap: a page built
 * purely through the CMS editor had a live feed, but no generic way to
 * WRITE into it - `data-qu-action="guestbook-form"` only ever existed for
 * Guestbook specifically. This form closes that gap for the two write
 * shapes every reference app in this package already reduces to
 * (`sharedListKind`/`pageKind` - `view-sources.js`'s own top doc comment on
 * why those two cover Guestbook/Blog/Forum/Chat already).
 *
 * DECLARED ON THE `<form>` ITSELF, all via `data-qu-*` attributes (every
 * value may use `{name}` placeholders - `qu-placeholders.js`'s own doc
 * comment on the full mechanism, e.g. `{yyyy}`/`{mm}`/`{dd}` for a
 * date-segmented route, `{pub}` for "tag this as me", or `{slug}`/any other
 * of the form's OWN named fields):
 *   - `data-qu-target="shared-list"` - pushes one entry (every NAMED
 *     `<input>`/`<textarea>`/`<select>` in the form, plus an automatic
 *     `ts: Date.now()`) into `data-qu-list="<name>"` (`pushToSharedList()`).
 *     `data-qu-owner="{pub}"` (optional) additionally tags the entry with
 *     `ownerPub` - the same per-owner-filterable convention
 *     `guestbook-actions.js`'s own `data-qu-owner` already uses for a
 *     personal instance's shared list, just spelled as a placeholder
 *     instead of a value baked in by an installer.
 *   - `data-qu-target="page"` - publishes a NEW page at `data-qu-route=
 *     "<template>"` (`title`/`content` read off the form's own `name=
 *     "title"`/`name="content"` fields, or `data-qu-title` as a static
 *     fallback when the form has no title field of its own) - `data-qu-scope
 *     ="global"` (default `"self"`) plus `data-qu-prefix="<prefix>"` routes
 *     the write through the `qu-admin-page`/`'relay-admins'`-ACL pair
 *     instead of the self-owned one, the SAME "who may write" distinction
 *     `blog-actions.js`'s own `data-qu-mode="personal"` already makes for
 *     ITS two write paths.
 *
 * ALWAYS A CREATE, NEVER AN EDIT (unlike `cms-actions.js`'s own editor
 * forms) - every submission is a NEW shared-list entry or a NEW page at
 * whatever route this submission's own placeholders resolve to (a fresh
 * `{slug}`, or a fresh `{yyyy}/{mm}/{dd}` when the same day repeats); a
 * generic "edit the thing I made earlier" form is real, separate future
 * work this file does not attempt.
 *
 * MULTIPLE SUCH FORMS MAY COEXIST on one page (unlike `guestbook-actions.js`/
 * `blog-actions.js`, which each assume exactly one of their OWN form) -
 * `wireGenericWrite()` wires every one it finds. The listener is attached
 * SYNCHRONOUSLY per form (no top-level `await` before `addEventListener()`),
 * the SAME race `guestbook-actions.js`'s own top doc comment explains in
 * full (a fast visitor's `submit` firing before this wiring ran at all).
 */
import { pushToSharedList, sharedListAnchor, sharedListKind, createPage, publishRoute, pageKind, deriveContentNodeId, createGlobalPage, publishGlobalRoute, adminPageKind, globalAppAnchor } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { verifyWritesAcked } from './verify-writes.js';
import { resolvePlaceholders } from './qu-placeholders.js';

/** Every NAMED, non-button form control's own current value, keyed by `name` - the raw material both `resolvePlaceholders()`'s own `fields` and a shared-list entry's own stored shape are built from. */
function collectFields(form) {
  const fields = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button') continue;
    fields[el.name] = el.value;
  }
  return fields;
}

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export function wireGenericWrite({ mountEl, doc, space }) {
  for (const form of mountEl.querySelectorAll('form[data-qu-action="qu-write"]')) {
    const target = form.getAttribute('data-qu-target');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
      status.setAttribute('data-qu-status', '');
      status.textContent = '';
      try {
        const fields = collectFields(form);
        if (target === 'shared-list') {
          const listName = resolvePlaceholders(form.getAttribute('data-qu-list'), { space, fields });
          const entry = { ...fields, ts: Date.now() };
          const ownerTemplate = form.getAttribute('data-qu-owner');
          if (ownerTemplate) entry.ownerPub = resolvePlaceholders(ownerTemplate, { space, fields });
          const id = await deriveOwnerNodeId(await sharedListAnchor(listName), sharedListKind.kind);
          await verifyWritesAcked(space, id, () => pushToSharedList(space, listName, entry));
        } else if (target === 'page') {
          const route = resolvePlaceholders(form.getAttribute('data-qu-route'), { space, fields });
          const title = fields.title ?? form.getAttribute('data-qu-title') ?? '';
          const content = fields.content ?? '';
          if (form.getAttribute('data-qu-scope') === 'global') {
            const prefix = form.getAttribute('data-qu-prefix');
            const anchor = await globalAppAnchor(prefix);
            const id = await deriveContentNodeId(anchor, adminPageKind.kind, route);
            await verifyWritesAcked(space, id, async () => {
              await publishGlobalRoute(space, prefix, { route, title });
              await new Promise((resolve) => setTimeout(resolve, 400));
              await createGlobalPage(space, prefix, { route, title, content });
            });
          } else {
            const id = await deriveContentNodeId(space.identity.signingPub, pageKind.kind, route);
            await verifyWritesAcked(space, id, async () => {
              await createPage(space, { route, title, content });
              await publishRoute(space, { route, title });
            });
          }
        } else {
          throw new Error(`data-qu-target="${target}" unbekannt - erwartet "shared-list" oder "page"`);
        }
        form.reset();
        status.textContent = 'Gespeichert und vom Relay bestätigt.';
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }
}
