/**
 * RICH TEXT ACTIONS — the framework-provided interactivity a
 * `<textarea data-qu-richtext>` renders THROUGH: `wireRichText()` finds
 * every such textarea in the just-rendered page and hands it to
 * `@qu/space-ui`'s `bindRichText()` - the SAME "framework code wires an
 * inert, content-authored element by attribute convention" posture
 * `[data-qu-view]`/`[data-qu-search-for]` already use (`view-actions.js`'s
 * own doc comment). `boot.js` calls `wireRichText()` unconditionally after
 * EVERY `renderPage()` - a correct no-op on any page with no
 * `[data-qu-richtext]` textarea.
 *
 * NO EXPLICIT TEARDOWN NEEDED (unlike `wireViews()`'s own
 * `openViewsByMountEl`): a rich-text binding holds no live Space
 * subscription, only DOM listeners on the textarea/editor/toolbar
 * elements THIS render created - when the next render replaces
 * `mountEl`'s content, those elements (and their listeners) are simply
 * discarded with the rest of the old DOM subtree, no leak.
 *
 * `refreshRichText()` is the other half: `bindRichText()`'s own doc
 * comment on "ONE-WAY MIRRORING" - a caller that sets a bound textarea's
 * `.value` PROGRAMMATICALLY (an editor loading an existing post back into
 * the form, `blog-actions.js`'s `loadForEdit()`) must call this right
 * after, or the visible rich-text surface goes stale (still showing
 * whatever it had before, not the newly-loaded content).
 */
import { bindRichText } from '@qu/space-ui';

/** @type {WeakMap<HTMLTextAreaElement, {refresh: () => void, stop: () => void}>} */
const boundByTextarea = new WeakMap();

/** @param {{mountEl: Element}} params */
export function wireRichText({ mountEl }) {
  for (const textarea of mountEl.querySelectorAll('textarea[data-qu-richtext]')) {
    if (boundByTextarea.has(textarea)) continue; // already bound - a render normally creates fresh elements, but never re-bind the SAME node twice either way.
    boundByTextarea.set(textarea, bindRichText(textarea));
  }
}

/** @param {HTMLTextAreaElement} textarea - a correct no-op if `textarea` was never bound by `wireRichText()` (a plain textarea, or bound on a DIFFERENT, already-discarded render). */
export function refreshRichText(textarea) {
  boundByTextarea.get(textarea)?.refresh();
}
