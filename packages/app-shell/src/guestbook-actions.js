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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      const name = form.querySelector('[name="name"]').value.trim();
      const message = form.querySelector('[name="message"]').value.trim();
      const id = await deriveOwnerNodeId(await sharedListAnchor(listName), sharedListKind.kind);
      await verifyWritesAcked(space, id, () => pushToSharedList(space, listName, { name, message, ts: Date.now() }));
      form.reset();
      status.textContent = 'Eingetragen und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });
}
