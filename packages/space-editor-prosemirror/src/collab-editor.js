/**
 * COLLAB EDITOR — real multi-peer LIVE collaborative editing, bound
 * DIRECTLY to a `@qu/space-core` `'richtext'`-shape field's own
 * `Y.XmlFragment` (`field.yxml` - `field.js`'s own doc comment: "bind
 * `y-prosemirror`'s `ySyncPlugin` straight to it"). Every keystroke is a
 * Yjs update, synced over the SAME Space/relay transport every other write
 * in this framework already uses - `y-prosemirror`'s `ySyncPlugin` is the
 * ENTIRE integration, no bespoke sync code here at all. A real,
 * DELIBERATE consequence: content exists on the relay the moment it's
 * typed, not only once some "Save"/"Veröffentlichen" action fires - the
 * opposite tradeoff from `local-editor.js`'s `bindLocalRichText()`, which
 * is why they're two separate functions with two separate contracts
 * rather than one function with a mode flag (see this package's own
 * top-level doc comments on each file).
 *
 * SCOPE CUT: no remote cursor/presence highlighting (`y-prosemirror`'s own
 * `yCursorPlugin` needs a Yjs `Awareness` instance, which needs its own
 * transport - this framework's OWN presence mechanism is `@qu/space-core`'s
 * `presence.js`, not Yjs Awareness, and wiring the two together is a
 * separate, real piece of work) - this binds content sync only. A REAL
 * collaborative editor could still add cursor presence later without
 * touching this function's own contract at all.
 */
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { ySyncPlugin, yUndoPlugin, undo as yUndo, redo as yRedo } from 'y-prosemirror';
import { richTextSchema } from './schema.js';
import { createToolbar } from './toolbar.js';

/**
 * @param {Element} container - the editor/toolbar are appended here (unlike `bindLocalRichText()`, there is no `<textarea>` to replace - a `'richtext'` field has no plain-string form at all, see `RichTextField`'s own doc comment).
 * @param {{yxml: import('yjs').XmlFragment}} field - a `@qu/space-core` `RichTextField` (or anything else exposing `.yxml`).
 * @param {{doc?: Document, prompt?: (message: string) => string|null, schema?: import('prosemirror-model').Schema}} [options]
 * @returns {{stop: () => void, view: import('prosemirror-view').EditorView}} No `refresh()` - unlike the local editor, there is nothing to go stale: the field's own `Y.XmlFragment` IS the live source of truth, always in sync by construction. `view` - see `bindLocalRichText()`'s own doc comment on the identical accessor.
 */
export function bindCollabRichText(container, field, { doc = container.ownerDocument, prompt = (msg) => doc.defaultView?.prompt?.(msg) ?? null, schema = richTextSchema } = {}) {
  const editorEl = doc.createElement('div');
  editorEl.className = 'qu-richtext-editor qu-richtext-editor-collab';

  let view;
  const toolbar = createToolbar(() => view, schema, { doc, prompt });

  view = new EditorView(editorEl, {
    state: EditorState.create({
      schema,
      plugins: [ySyncPlugin(field.yxml), yUndoPlugin(), keymap({ 'Mod-z': yUndo, 'Mod-y': yRedo, 'Mod-Shift-z': yRedo }), keymap(baseKeymap)],
    }),
    // See `local-editor.js`'s own doc comment on this prop - identical reasoning.
    handleScrollToSelection: () => true,
  });

  container.appendChild(toolbar);
  container.appendChild(editorEl);

  return {
    stop() {
      view.destroy();
      toolbar.remove();
      editorEl.remove();
    },
    get view() {
      return view;
    },
  };
}
