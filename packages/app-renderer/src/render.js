/**
 * RENDER — the one function that turns an `@qu/app-core` `AppRuntime.
 * resolveRoute()` plan into DOM: sanitize the Template and the Page's own
 * content independently (see sanitizer.js), resolve `<qu-slot>` (see
 * slots.js) with the Page's content in the `"content"` slot PLUS one
 * extra named slot per top-level key of the Page's own structured `data`
 * (`@qu/app-core`'s `kinds.js` `pageKind` own doc comment - "Slots im
 * Template definieren zu einem Datenpfad und diesen dann auch füllen," the
 * user's own framing), mount the result, set `document.title`, and inject
 * the theme stylesheet (see styles.js).
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
 * Turns a Page's own structured `data` (an arbitrary JSON object, e.g.
 * `{author: 'Alice', tags: ['qu','cms']}`) into extra named-slot fillers -
 * one slot per top-level key, ALONGSIDE the dedicated `"content"` field
 * (never instead of it; a page missing `data` entirely, or with `data:
 * null`, contributes no extra slots at all - fully backward compatible).
 * String values are sanitized as HTML, the SAME Stufe-1 rule the
 * `"content"` slot already gets (see sanitizer.js); non-string values
 * (numbers, arrays, nested objects a template author chose to store) are
 * rendered via their plain `String()` form, since `sanitizeHtml()` only
 * ever operates on markup strings - a template wanting richer rendering
 * of a non-string value stores it pre-formatted as a string instead.
 */
function resolveDataSlots(data, doc) {
  if (!data || typeof data !== 'object') return {};
  const slots = {};
  for (const [key, value] of Object.entries(data)) {
    slots[key] = typeof value === 'string' ? sanitizeHtml(value, doc) : String(value ?? '');
  }
  return slots;
}

/**
 * @param {{mountEl: Element, doc?: Document, templateHtml: string|null, page: {title: string, content: string, data?: object|null}|null, css?: string, styleId?: string}} params
 * @returns {Element} `mountEl`, for chaining.
 */
export function renderPage({ mountEl, doc = mountEl.ownerDocument, templateHtml, page, css = '', styleId = 'qu-app-theme' }) {
  const template = sanitizeHtml(templateHtml ?? NOT_FOUND_TEMPLATE, doc);
  // `content` is assigned AFTER the data-slot spread so a page's dedicated content field always
  // wins over a same-named `data` key, should an author ever collide the two - "content" is the
  // one slot every page has always had, a `data.content` key is presumably accidental.
  const slotContents = page ? { ...resolveDataSlots(page.data, doc), content: sanitizeHtml(page.content ?? '', doc) } : { content: NOT_FOUND_CONTENT };
  mountEl.innerHTML = resolveSlots(template, slotContents, doc);

  if (page?.title) doc.title = page.title;
  injectStyle(doc, styleId, css);

  return mountEl;
}
