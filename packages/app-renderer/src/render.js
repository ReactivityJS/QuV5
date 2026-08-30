/**
 * RENDER — the one function that turns an `@qu/app-core` `AppRuntime.
 * resolveRoute()` plan into DOM: sanitize the Template and the Page's own
 * content independently (see sanitizer.js), resolve `<qu-slot>` (see
 * slots.js) with the Page's content in the `"content"` slot, mount the
 * result, set `document.title`, and inject the theme stylesheet (see
 * styles.js).
 *
 * `page: null` (an unresolved route - see @qu/app-core's `ContentResolver`/
 * `AppRuntime` own doc comments) is the "not found" signal, handled as TWO
 * independent fallbacks (docs §16's "Framework Default"), because an app
 * missing ONE page still has its OWN template/chrome most of the time:
 *   - `templateHtml` present (the common case - the app has a working root
 *     template, just no page for THIS route): that template still renders,
 *     with the FRAMEWORK's default "not found" content in its `"content"`
 *     slot - a 404 that still looks like the app, not a blank framework page.
 *   - `templateHtml` ALSO `null` (nothing at all came from the Space -
 *     Phase-1's genuinely empty shell): the framework's own default
 *     TEMPLATE renders instead, so booting against an empty Space never
 *     just fails silently.
 */
import { sanitizeHtml } from './sanitizer.js';
import { resolveSlots } from './slots.js';
import { injectStyle } from './styles.js';

const NOT_FOUND_CONTENT = '<h1>404</h1><p>Diese Seite wurde im Space nicht gefunden.</p>';
const NOT_FOUND_TEMPLATE = `<main><qu-slot name="content">${NOT_FOUND_CONTENT}</qu-slot></main>`;

/**
 * @param {{mountEl: Element, doc?: Document, templateHtml: string|null, page: {title: string, content: string}|null, css?: string, styleId?: string}} params
 * @returns {Element} `mountEl`, for chaining.
 */
export function renderPage({ mountEl, doc = mountEl.ownerDocument, templateHtml, page, css = '', styleId = 'qu-app-theme' }) {
  const template = sanitizeHtml(templateHtml ?? NOT_FOUND_TEMPLATE, doc);
  const slotContents = { content: page ? sanitizeHtml(page.content ?? '', doc) : NOT_FOUND_CONTENT };
  mountEl.innerHTML = resolveSlots(template, slotContents, doc);

  if (page?.title) doc.title = page.title;
  injectStyle(doc, styleId, css);

  return mountEl;
}
