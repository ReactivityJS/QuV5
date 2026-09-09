/**
 * RICH TEXT — see rich-text.js's own doc comment. Every command is a
 * direct `Range`/`Selection` manipulation (no `document.execCommand()` -
 * jsdom, this project's own test runtime, doesn't implement it at all),
 * so these tests exercise the ACTUAL DOM mutation each toolbar button
 * performs, not a mocked/assumed result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bindRichText } from '../src/rich-text.js';

function setup(initialHtml = '') {
  const { window } = new JSDOM(`<!doctype html><body><textarea id="content"></textarea></body>`);
  const { document } = window;
  const textarea = document.getElementById('content');
  textarea.value = initialHtml;
  return { window, document, textarea };
}

function selectText(window, document, editor, start, end) {
  const textNode = editor.firstChild;
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

test('bindRichText() hides the textarea and seeds a contenteditable editor from its current value', () => {
  const { document, textarea } = setup('<p>Hallo</p>');
  bindRichText(textarea);
  assert.equal(textarea.hidden, true);
  const editor = document.querySelector('.qu-richtext-editor');
  assert.ok(editor);
  assert.equal(editor.getAttribute('contenteditable'), 'true');
  assert.equal(editor.innerHTML, '<p>Hallo</p>');
});

test('typing into the editor (an "input" event) mirrors its innerHTML back into the textarea value', () => {
  const { document, textarea } = setup('');
  bindRichText(textarea);
  const editor = document.querySelector('.qu-richtext-editor');
  editor.innerHTML = 'getippter Text';
  editor.dispatchEvent(new editor.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.equal(textarea.value, 'getippter Text');
});

test('Bold/Italic buttons wrap the current selection in <strong>/<em>, and mirror the result into the textarea', () => {
  const { window, document, textarea } = setup('hello world');
  bindRichText(textarea);
  const editor = document.querySelector('.qu-richtext-editor');
  selectText(window, document, editor, 0, 5); // "hello"
  click(document.querySelector('.qu-richtext-btn-b'));
  assert.equal(editor.innerHTML, '<strong>hello</strong> world');
  assert.equal(textarea.value, '<strong>hello</strong> world');

  // Italic on the (still selected, now inside <strong>) text - proves selection is re-established
  // after wrapping, not lost.
  click(document.querySelector('.qu-richtext-btn-i'));
  assert.equal(editor.innerHTML, '<strong><em>hello</em></strong> world');
});

test('a collapsed (empty) selection is a no-op for Bold - nothing to wrap', () => {
  const { window, document, textarea } = setup('hello');
  bindRichText(textarea);
  const editor = document.querySelector('.qu-richtext-editor');
  selectText(window, document, editor, 2, 2); // collapsed, no range.
  click(document.querySelector('.qu-richtext-btn-b'));
  assert.equal(editor.innerHTML, 'hello');
});

test('the Link button wraps the selection in <a href="..."> using the injected prompt() for the URL', () => {
  const { window, document, textarea } = setup('click here');
  const urls = [];
  bindRichText(textarea, {
    prompt: (msg) => {
      urls.push(msg);
      return 'https://example.test';
    },
  });
  const editor = document.querySelector('.qu-richtext-editor');
  selectText(window, document, editor, 0, 10); // "click here"
  click(document.querySelector('.qu-richtext-btn-link'));
  assert.equal(editor.innerHTML, '<a href="https://example.test">click here</a>');
  assert.equal(urls.length, 1);
});

test('the Link button is a no-op when prompt() returns nothing (cancelled)', () => {
  const { window, document, textarea } = setup('click here');
  bindRichText(textarea, { prompt: () => null });
  const editor = document.querySelector('.qu-richtext-editor');
  selectText(window, document, editor, 0, 10);
  click(document.querySelector('.qu-richtext-btn-link'));
  assert.equal(editor.innerHTML, 'click here');
});

test('the H2 button toggles the closest block between <h2> and <p>', () => {
  const { window, document, textarea } = setup('<p>Titel</p>');
  bindRichText(textarea);
  const editor = document.querySelector('.qu-richtext-editor');
  const p = editor.querySelector('p');
  selectText(window, document, p, 0, 5);
  click(document.querySelector('.qu-richtext-btn-h2'));
  assert.equal(editor.innerHTML, '<h2>Titel</h2>');

  const h2 = editor.querySelector('h2');
  selectText(window, document, h2, 0, 5);
  click(document.querySelector('.qu-richtext-btn-h2'));
  assert.equal(editor.innerHTML, '<p>Titel</p>', 'clicking H2 again on an existing h2 toggles it back to a plain paragraph');
});

test('the bullet-list button wraps the closest block in <ul><li>...</li></ul>', () => {
  const { window, document, textarea } = setup('<p>Milch</p>');
  bindRichText(textarea);
  const editor = document.querySelector('.qu-richtext-editor');
  const p = editor.querySelector('p');
  selectText(window, document, p, 0, 5);
  click(document.querySelector('.qu-richtext-btn-•'));
  assert.equal(editor.innerHTML, '<ul><li>Milch</li></ul>');
});

test('refresh() re-seeds the visible editor after the textarea\'s own value was set programmatically (not through the editor)', () => {
  const { document, textarea } = setup('<p>Alt</p>');
  const { refresh } = bindRichText(textarea);
  const editor = document.querySelector('.qu-richtext-editor');
  assert.equal(editor.innerHTML, '<p>Alt</p>');

  textarea.value = '<p>Neu geladen</p>'; // simulates an editor loading different content into the form.
  assert.equal(editor.innerHTML, '<p>Alt</p>', 'setting .value alone does NOT reach the editor - see this file\'s own "ONE-WAY MIRRORING" doc comment');
  refresh();
  assert.equal(editor.innerHTML, '<p>Neu geladen</p>');
});

test('stop() removes the toolbar/editor and un-hides the original textarea', () => {
  const { document, textarea } = setup('<p>x</p>');
  const { stop } = bindRichText(textarea);
  assert.equal(textarea.hidden, true);
  stop();
  assert.equal(textarea.hidden, false);
  assert.equal(document.querySelector('.qu-richtext-editor'), null);
  assert.equal(document.querySelector('.qu-richtext-toolbar'), null);
});
