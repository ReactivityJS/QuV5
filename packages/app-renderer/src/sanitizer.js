/**
 * SANITIZER — the structural enforcement of "beliebiges JavaScript wird
 * nicht automatisch ausgeführt" (docs/app-shell-arbeitsauftrag.md §17,
 * Stufe 1 "Content"): every HTML string sourced from Qu content (a
 * `qu-template`'s `html`, a `qu-page`'s `content`) passes through here
 * BEFORE it ever reaches `mountEl.innerHTML` (see render.js) - unlike
 * relying only on "innerHTML-parsed `<script>` elements don't execute" (a
 * real browser behavior, but incidental, not a policy this codebase
 * states anywhere), this REMOVES `<script>` elements and `on*`
 * event-handler attributes outright, so the sanitized string stays inert
 * even if something else later re-inserts it a different way.
 *
 * Deliberately DOM-based (parse via a real `Document`, walk the resulting
 * tree), not regex-based - regex HTML "sanitizing" is a well-known way to
 * miss malformed/obfuscated markup; a real parser normalizes it first.
 * `doc` is an explicit parameter (defaulting to `globalThis.document`),
 * same "inject the DOM, don't assume a global" posture `@qu/app-core`'s
 * `router.js` already uses - lets this run under a real browser Document
 * OR a jsdom one in tests with no special-casing.
 */
const EVENT_ATTR_PATTERN = /^on/i;
const JS_URL_PATTERN = /^\s*javascript:/i;
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);

/**
 * @param {string} html
 * @param {Document} [doc] - defaults to `globalThis.document`.
 * @returns {string} `html`, with every `<script>` element removed, every
 *   `on*` attribute stripped, and every `javascript:` URL attribute
 *   stripped.
 */
export function sanitizeHtml(html, doc = globalThis.document) {
  const container = doc.createElement('div');
  container.innerHTML = html ?? '';

  for (const scriptEl of [...container.querySelectorAll('script')]) scriptEl.remove();

  for (const el of container.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const isEventAttr = EVENT_ATTR_PATTERN.test(attr.name);
      const isJsUrl = URL_ATTRS.has(attr.name.toLowerCase()) && JS_URL_PATTERN.test(attr.value);
      if (isEventAttr || isJsUrl) el.removeAttribute(attr.name);
    }
  }

  return container.innerHTML;
}
