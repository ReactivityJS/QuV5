/**
 * LOCAL EDITOR — a drop-in upgrade for `@qu/space-ui`'s own `bindRichText()`:
 * identical external contract (hides a `<textarea>`, inserts a toolbar +
 * editor surface right after it, mirrors edits back into `textareaEl.value`,
 * returns `{refresh, stop}`) - a caller (`@qu/app-shell`'s `rich-text-actions.js`)
 * can pass `bindLocalRichText` in wherever `bindRichText` used to go, no
 * other code needs to change. The actual editing surface is a REAL
 * `ProseMirror` `EditorView` instead of hand-rolled `Range`/`Selection`
 * manipulation - a schema-valid document model, not "whatever the last
 * `Range.extractContents()` call happened to produce."
 *
 * NO Yjs/networking here at all - `prosemirror-history`'s own local undo
 * stack is the only "collaborative editing" primitive touched, and even
 * that never leaves this browser tab. `textareaEl.value` is read/written
 * exactly like the old editor - a Blog post's "Als Entwurf speichern"/
 * "Veröffentlichen" submit flow (`blog-actions.js`) needs ZERO changes.
 * For REAL multi-peer live collaborative editing bound straight to a
 * `@qu/space-core` `'richtext'`-shape field, see this package's own
 * `bindCollabRichText()` instead - a deliberately different function, not
 * a mode flag on this one, since the two have genuinely different
 * contracts (this one talks to a `<textarea>`'s `.value`; that one talks
 * directly to a field's own `Y.XmlFragment`).
 */
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMDOMParser, DOMSerializer } from 'prosemirror-model';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { richTextSchema } from './schema.js';
import { createToolbar } from './toolbar.js';

/**
 * @param {HTMLTextAreaElement} textareaEl
 * @param {{doc?: Document, prompt?: (message: string) => string|null, schema?: import('prosemirror-model').Schema}} [options]
 * @returns {{refresh: () => void, stop: () => void, view: import('prosemirror-view').EditorView}} `refresh()` re-seeds the editor from `textareaEl.value` (needed after a caller sets it PROGRAMMATICALLY - same "one-way mirroring" reasoning `@qu/space-ui`'s old `bindRichText()` already documented). `stop()` destroys the `EditorView` and un-hides the original textarea. `view` - the raw `EditorView`, for a caller (or a test - jsdom fires no `selectionchange` event at all, so driving a DOM `Selection` doesn't reach ProseMirror's own; dispatch a `TextSelection` transaction directly instead) that needs it; ordinary usage never touches this.
 */
export function bindLocalRichText(textareaEl, { doc = textareaEl.ownerDocument, prompt = (msg) => doc.defaultView?.prompt?.(msg) ?? null, schema = richTextSchema } = {}) {
  textareaEl.hidden = true;

  const editorEl = doc.createElement('div');
  editorEl.className = 'qu-richtext-editor';

  function htmlToDoc(html) {
    const wrapper = doc.createElement('div');
    wrapper.innerHTML = html;
    return PMDOMParser.fromSchema(schema).parse(wrapper);
  }
  function docToHtml(pmDoc) {
    const wrapper = doc.createElement('div');
    wrapper.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(pmDoc.content));
    return wrapper.innerHTML;
  }

  const plugins = [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }), keymap(baseKeymap)];

  let view; // assigned right after construction below - the toolbar's own getView() closure only ever reads it from a LATER click, never during this synchronous setup.
  const toolbar = createToolbar(() => view, schema, { doc, prompt });

  view = new EditorView(editorEl, {
    state: EditorState.create({ doc: htmlToDoc(textareaEl.value), schema, plugins }),
    // `handleScrollToSelection: () => true` - tells `EditorView` "scrolling was handled," skipping
    // its OWN default (`coordsAtPos()` -> `Range.getClientRects()`, a real layout measurement jsdom
    // - this project's test runtime - does not implement, throwing on every selection-changing
    // command otherwise). A small, typically-already-visible content editor has little need for
    // auto-scroll-into-view anyway - a deliberate, minor UX trade-off for real headless testability.
    handleScrollToSelection: () => true,
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr);
      // Mirror FIRST, then updateState() - `updateState()`'s own DOM sync can throw independently of
      // the transaction/mirroring already having succeeded (see `handleScrollToSelection` above);
      // the textarea should reflect the new content regardless of whether the view's own redraw did.
      if (tr.docChanged) textareaEl.value = docToHtml(newState.doc);
      view.updateState(newState);
    },
  });

  textareaEl.insertAdjacentElement('afterend', editorEl);
  textareaEl.insertAdjacentElement('afterend', toolbar);

  return {
    refresh() {
      view.updateState(EditorState.create({ doc: htmlToDoc(textareaEl.value), schema, plugins }));
    },
    stop() {
      view.destroy();
      toolbar.remove();
      editorEl.remove();
      textareaEl.hidden = false;
    },
    get view() {
      return view;
    },
  };
}
