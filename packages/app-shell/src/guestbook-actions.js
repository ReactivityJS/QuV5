/**
 * GUESTBOOK ACTIONS — the framework-provided interactivity
 * `guestbook-bundle.js`'s own inert sign-form attaches to, by CONVENTION,
 * the SAME "content stays inert markup" posture `cms-actions.js`/
 * `admin-actions.js`/`view-actions.js` already use. `boot.js` calls
 * `wireGuestbook()` unconditionally after every `renderPage()`, for every
 * app/realm - cheap (one `querySelector`) and a correct no-op whenever the
 * rendered page isn't a Guestbook's own index (no matching form found).
 *
 * The target list's NAME comes off the form's own `data-qu-list`
 * attribute (baked in by `installGuestbook()` at install time) rather
 * than being hardcoded here - this file has no idea which prefix it's
 * running under, by design (the SAME "reusable by any app, no
 * CMS-specific assumption" posture `view-actions.js`'s own top doc
 * comment explains in full).
 *
 * `data-qu-owner` (optional) - present ONLY on a PERSONAL guestbook's own
 * form (`installPersonalGuestbook()`'s own doc comment on why: many
 * visitors' own personal guestbooks share ONE physical list, `<prefix>:
 * personal`, each entry tagged with whose it is) - when present, every
 * entry this form pushes carries that SAME `ownerPub` too, so the personal
 * guestbook's own filtered View picks it up. Absent on the GLOBAL
 * guestbook's own form - its entries stay the plain `{name, message, ts}`
 * shape unchanged.
 *
 * The listener is attached SYNCHRONOUSLY (this function itself does no
 * top-level `await`) - `deriveOwnerNodeId()` runs INSIDE the submit
 * handler instead of before `addEventListener()`, closing a real race a
 * naive `async function wireGuestbook()` would otherwise have: `boot.js`
 * calls this straight after `renderPage()` already put the form in the
 * DOM, so an `await` before attaching would leave a real (if narrow)
 * window where a fast visitor's `submit` fires on a form with no listener
 * yet - same posture `blog-actions.js`'s own `wireBlog()` already takes
 * (no top-level `await` there either, for the same reason).
 */
import { pushToSharedList, sharedListAnchor, sharedListKind } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { verifyWritesAcked } from './verify-writes.js';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export function wireGuestbook({ mountEl, doc, space }) {
  const form = mountEl.querySelector('form[data-qu-action="guestbook-form"]');
  if (!form) return;
  const listName = form.getAttribute('data-qu-list');
  const ownerPub = form.getAttribute('data-qu-owner');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      const name = form.querySelector('[name="name"]').value.trim();
      const message = form.querySelector('[name="message"]').value.trim();
      const id = await deriveOwnerNodeId(await sharedListAnchor(listName), sharedListKind.kind);
      const entry = { name, message, ts: Date.now() };
      if (ownerPub) entry.ownerPub = ownerPub;
      await verifyWritesAcked(space, id, () => pushToSharedList(space, listName, entry));
      form.reset();
      status.textContent = 'Eingetragen und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });
}
