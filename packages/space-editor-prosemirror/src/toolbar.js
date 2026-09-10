/**
 * TOOLBAR — Bold/Italic/Link/H2/bullet-list, feature parity with the OLD
 * `@qu/space-ui` `bindRichText()` this package replaces - built on
 * `prosemirror-commands`'s own command functions instead of hand-rolled
 * `Range`/`Selection` manipulation, so formatting always produces a
 * SCHEMA-VALID document (no more "wrap whatever happens to be selected in
 * a raw tag" edge cases the old editor had). Shared by both
 * `local-editor.js` and `collab-editor.js` - `getView()` is a closure so
 * the toolbar element can be created BEFORE the `EditorView` it controls
 * exists yet (both editors construct their toolbar first, `EditorView`
 * second, and hand back a `() => view` accessor).
 */
import { toggleMark, setBlockType } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';

function isInsideList(state, schema) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.list_item) return true;
  }
  return false;
}

/**
 * @param {() => import('prosemirror-view').EditorView} getView
 * @param {import('prosemirror-model').Schema} schema
 * @param {{doc: Document, prompt: (message: string) => string|null}} options - `prompt` supplies the Link button's URL, same injectable-for-testability shape `@qu/space-ui`'s old `bindRichText()` already established.
 * @returns {Element}
 */
export function createToolbar(getView, schema, { doc, prompt }) {
  const toolbar = doc.createElement('div');
  toolbar.className = 'qu-richtext-toolbar';

  function addButton(label, title, command) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `qu-richtext-btn qu-richtext-btn-${label.toLowerCase()}`;
    btn.textContent = label;
    btn.title = title;
    // `mousedown` -> preventDefault(), NOT `click` - see `@qu/space-ui`'s old `bindRichText()` own
    // doc comment on why (a real browser moves focus/collapses the editor's own selection on
    // mousedown before 'click' ever runs, unless prevented here) - identical reasoning, still not
    // reproduced by jsdom (this project's test runtime), verified by hand against a real browser.
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => {
      const view = getView();
      command(view.state, view.dispatch, view);
      view.focus();
    });
    toolbar.appendChild(btn);
    return btn;
  }

  addButton('B', 'Fett', toggleMark(schema.marks.strong));
  addButton('I', 'Kursiv', toggleMark(schema.marks.em));
  addButton('Link', 'Link einfügen', (state, dispatch) => {
    if (state.selection.empty) return false;
    const url = prompt('URL:');
    if (!url) return false;
    dispatch?.(state.tr.addMark(state.selection.from, state.selection.to, schema.marks.link.create({ href: url })));
    return true;
  });
  addButton('H2', 'Überschrift', (state, dispatch, view) => {
    const { $from } = state.selection;
    const isH2 = $from.parent.type === schema.nodes.heading && $from.parent.attrs.level === 2;
    return setBlockType(isH2 ? schema.nodes.paragraph : schema.nodes.heading, isH2 ? undefined : { level: 2 })(state, dispatch, view);
  });
  addButton('•', 'Aufzählung', (state, dispatch, view) => {
    // Toggle-ish: already inside a list -> lift back out to a plain paragraph; otherwise wrap.
    if (isInsideList(state, schema)) return liftListItem(schema.nodes.list_item)(state, dispatch, view);
    return wrapInList(schema.nodes.bullet_list)(state, dispatch, view);
  });

  return toolbar;
}
