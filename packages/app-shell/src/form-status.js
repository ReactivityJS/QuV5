/**
 * FORM STATUS — the "find or create this form's own `[data-qu-status]`
 * paragraph, then set its text" three-liner every form's own submit
 * handler in this package repeated verbatim (a cleared message at the
 * start of a submit, then a success or `Fehler: ...` message at the end) -
 * `cms-actions.js` already had a private copy of exactly this function;
 * this is that same function, shared, so every OTHER form-wiring file
 * (`blog-actions.js`, `guestbook-actions.js`, `forum-actions.js`,
 * `admin-actions.js`, `generic-write-actions.js`) calls ONE place instead
 * of re-deriving it. Deliberately a plain function, not a `<qu-form-status>`
 * Web Component - there is no reactive Space data involved here at all
 * (unlike `@qu/space-components`'s `<qu-view>`/`<qu-bind>`), just "set some
 * text on an element," so a Component's registration/shadow-DOM machinery
 * would be pure overhead for what a one-line call already does.
 */

/**
 * @param {HTMLFormElement} form
 * @param {string} text
 * @returns {Element} the `[data-qu-status]` element (created if it didn't already exist), in case a caller needs it directly (e.g. to also toggle a class).
 */
export function setFormStatus(form, text) {
  const status = form.querySelector('[data-qu-status]') ?? form.appendChild(form.ownerDocument.createElement('p'));
  status.setAttribute('data-qu-status', '');
  status.textContent = text;
  return status;
}
