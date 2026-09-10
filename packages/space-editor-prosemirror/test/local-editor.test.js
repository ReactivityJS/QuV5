/**
 * LOCAL EDITOR — see local-editor.js's own doc comment. Proves the SAME
 * external behavior `@qu/space-ui`'s old `bindRichText()` had (hides the
 * textarea, mirrors into `.value`, `{refresh, stop}`), now backed by a
 * REAL `ProseMirror` `EditorView` (mounts fine under jsdom - `EditorView`,
 * `Range`/`Selection`, and DOM parsing/serialization are all real DOM
 * APIs jsdom implements, unlike layout/measurement, which this package
 * never needs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TextSelection } from 'prosemirror-state';
import { bindLocalRichText } from '../src/local-editor.js';

// `prosemirror-view` references the bare GLOBAL `document`/`window` internally in places (it was
// written assuming one real browser tab, not per-test jsdom realms) - without this, constructing an
// `EditorView` throws `document is not defined` even though a perfectly good `window`/`document`
// were passed in through `options.doc`. Node's test runner runs this file's tests sequentially, so
// pointing the globals at whichever jsdom instance THIS test just created is safe - no cross-test race.
function setup(initialHtml = '') {
  const { window } = new JSDOM('<!doctype html><body><textarea id="content"></textarea></body>');
  const { document } = window;
  global.window = window;
  global.document = document;
  global.DOMParser = window.DOMParser;
  global.Node = window.Node;
  const textarea = document.getElementById('content');
  textarea.value = initialHtml;
  return { window, document, textarea };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

/**
 * Selects the editor's ENTIRE document via ProseMirror's own selection
 * model - NOT a DOM `Range`/`Selection`, which never reaches ProseMirror
 * here: jsdom (this project's test runtime) fires no `selectionchange`
 * event at all, so a DOM-level selection would silently never update
 * `view.state.selection`. `1`/`size - 1`, not `0`/`size` - those outer
 * positions sit OUTSIDE the single top-level block's own inline content
 * (a real bug this test file itself hit first: `TextSelection.create(doc,
 * 0, size)` resolves `$from.parent` to the `doc` node itself, not the
 * paragraph/heading, silently breaking any command that inspects
 * `$from.parent` - `setBlockType()`'s own toggle logic, specifically).
 */
function selectAllPM(view) {
  const { doc } = view.state;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)));
}

test('bindLocalRichText() hides the textarea and mounts a real ProseMirror EditorView seeded from its current value', () => {
  const { document, textarea } = setup('<p>Hallo</p>');
  bindLocalRichText(textarea);
  assert.equal(textarea.hidden, true);
  const editorEl = document.querySelector('.qu-richtext-editor');
  assert.ok(editorEl);
  assert.ok(editorEl.querySelector('.ProseMirror'), 'a real ProseMirror EditorView mounted, not a bare contenteditable div');
  assert.ok(editorEl.textContent.includes('Hallo'));
});

test('the Bold toolbar button wraps the current selection in <strong>, and mirrors the result into the textarea', () => {
  const { document, textarea } = setup('<p>hello world</p>');
  const { view } = bindLocalRichText(textarea);
  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-b'));
  assert.match(textarea.value, /<strong>hello world<\/strong>/);
});

test('the Italic toolbar button wraps the current selection in <em>', () => {
  const { document, textarea } = setup('<p>hello world</p>');
  const { view } = bindLocalRichText(textarea);
  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-i'));
  assert.match(textarea.value, /<em>hello world<\/em>/);
});

test('a collapsed (empty) selection is a no-op for Bold - nothing to wrap', () => {
  const { document, textarea } = setup('<p>hello</p>');
  bindLocalRichText(textarea); // default selection at doc start, collapsed - never touched.
  click(document.querySelector('.qu-richtext-btn-b'));
  assert.equal(textarea.value, '<p>hello</p>');
});

test('the Link button wraps the selection in <a href="..."> using the injected prompt() for the URL', () => {
  const { document, textarea } = setup('<p>click here</p>');
  const urls = [];
  const { view } = bindLocalRichText(textarea, {
    prompt: (msg) => {
      urls.push(msg);
      return 'https://example.test';
    },
  });
  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-link'));
  assert.match(textarea.value, /<a href="https:\/\/example\.test">click here<\/a>/);
  assert.equal(urls.length, 1);
});

test('the Link button is a no-op when prompt() returns nothing (cancelled)', () => {
  const { document, textarea } = setup('<p>click here</p>');
  const { view } = bindLocalRichText(textarea, { prompt: () => null });
  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-link'));
  assert.equal(textarea.value, '<p>click here</p>');
});

test('the H2 button toggles the current block between <h2> and <p>', () => {
  const { document, textarea } = setup('<p>Titel</p>');
  const { view } = bindLocalRichText(textarea);
  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-h2'));
  assert.equal(textarea.value, '<h2>Titel</h2>');

  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-h2'));
  assert.equal(textarea.value, '<p>Titel</p>', 'clicking H2 again toggles back to a plain paragraph');
});

test('the bullet-list button wraps the current block in <ul><li>...</li></ul>', () => {
  const { document, textarea } = setup('<p>Milch</p>');
  bindLocalRichText(textarea);
  click(document.querySelector('.qu-richtext-btn-•'));
  assert.equal(textarea.value, '<ul><li><p>Milch</p></li></ul>');
});

test('refresh() re-seeds the editor after the textarea\'s own value was set programmatically', () => {
  const { document, textarea } = setup('<p>Alt</p>');
  const { refresh } = bindLocalRichText(textarea);
  const editorEl = document.querySelector('.qu-richtext-editor');
  assert.ok(editorEl.textContent.includes('Alt'));

  textarea.value = '<p>Neu geladen</p>';
  assert.ok(!editorEl.textContent.includes('Neu geladen'), 'not synced yet - setting .value alone doesn\'t reach the editor');
  refresh();
  assert.ok(editorEl.textContent.includes('Neu geladen'));
  assert.ok(!editorEl.textContent.includes('Alt'));
});

test('stop() destroys the EditorView, removes the toolbar/editor, and un-hides the original textarea', () => {
  const { document, textarea } = setup('<p>x</p>');
  const { stop } = bindLocalRichText(textarea);
  assert.equal(textarea.hidden, true);
  stop();
  assert.equal(textarea.hidden, false);
  assert.equal(document.querySelector('.qu-richtext-editor'), null);
  assert.equal(document.querySelector('.qu-richtext-toolbar'), null);
});
