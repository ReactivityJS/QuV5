/**
 * RICH TEXT ACTIONS — the framework-provided interactivity a
 * `<textarea data-qu-richtext>` renders THROUGH: `wireRichText()` finds
 * every such textarea in the just-rendered page and hands it to a `bind`
 * function - the SAME "framework code wires an inert, content-authored
 * element by attribute convention" posture `[data-qu-view]`/
 * `[data-qu-search-for]` already use (`view-actions.js`'s own doc
 * comment). `boot.js` calls `wireRichText()` unconditionally after EVERY
 * `renderPage()` - a correct no-op on any page with no
 * `[data-qu-richtext]` textarea.
 *
 * `bind` (optional, default `@qu/space-ui`'s own `bindRichText()`) is a
 * DELIBERATE injection point, not a hardcoded call: `@qu/space-editor-
 * prosemirror`'s `bindLocalRichText()` (a genuinely OPTIONAL, separate
 * package - never a dependency of THIS package, an app opts in by
 * installing it and passing its `bindLocalRichText` through here) is a
 * drop-in upgrade with the identical `{refresh, stop}` contract - see
 * that package's own doc comment on why it isn't simply the new default:
 * making it one would make `@qu/app-shell` itself depend on ProseMirror
 * for every deployment, not just the ones that want it. `startPlatform()`/
 * `startApp()` (`boot.js`) thread an optional `richTextBind` param down
 * to every one of THEIR OWN `wireRichText()` call sites for exactly this -
 * a caller (a custom `shell.js`, a test) passes its own `bind` there, the
 * built-in editor otherwise, completely unchanged for anyone who never
 * opts in.
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
 * whatever it had before, not the newly-loaded content). Works
 * regardless of which `bind` implementation is actually in use - both
 * the built-in editor and `bindLocalRichText()` expose the identical
 * `refresh()` method for exactly this reason.
 */
import { bindRichText } from '@qu/space-ui';

/** @type {WeakMap<HTMLTextAreaElement, {refresh: () => void, stop: () => void}>} */
const boundByTextarea = new WeakMap();

/** @param {{mountEl: Element, bind?: (textarea: HTMLTextAreaElement) => {refresh: () => void, stop: () => void}}} params - `bind` defaults to `@qu/space-ui`'s own `bindRichText()` - see this file's own top doc comment on passing `@qu/space-editor-prosemirror`'s `bindLocalRichText` instead. */
export function wireRichText({ mountEl, bind = bindRichText }) {
  for (const textarea of mountEl.querySelectorAll('textarea[data-qu-richtext]')) {
    if (boundByTextarea.has(textarea)) continue; // already bound - a render normally creates fresh elements, but never re-bind the SAME node twice either way.
    boundByTextarea.set(textarea, bind(textarea));
  }
}

/** @param {HTMLTextAreaElement} textarea - a correct no-op if `textarea` was never bound by `wireRichText()` (a plain textarea, or bound on a DIFFERENT, already-discarded render). */
export function refreshRichText(textarea) {
  boundByTextarea.get(textarea)?.refresh();
}
