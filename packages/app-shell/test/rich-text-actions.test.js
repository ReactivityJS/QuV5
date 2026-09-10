/**
 * RICH TEXT ACTIONS — `rich-text-actions.js`'s own doc comment.
 * `wireRichText()`'s attribute-driven wiring, and `refreshRichText()`'s
 * "keep the visible surface in sync with a programmatic .value set" role,
 * both proven directly against a plain DOM tree - no relay/Space needed,
 * this is pure DOM wiring (see that file's own "no explicit teardown
 * needed" doc comment on why).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { wireRichText, refreshRichText } from '../src/rich-text-actions.js';

function mount(html) {
  const { window } = new JSDOM(`<!doctype html><body><qu-app-shell>${html}</qu-app-shell></body>`);
  const mountEl = window.document.querySelector('qu-app-shell');
  return { window, mountEl };
}

test('wireRichText() replaces every [data-qu-richtext] textarea with a rich-text surface; a plain textarea is untouched', () => {
  const { mountEl } = mount('<textarea data-qu-richtext>Hallo</textarea><textarea name="plain">unverändert</textarea>');
  wireRichText({ mountEl });
  const rich = mountEl.querySelector('textarea[data-qu-richtext]');
  const plain = mountEl.querySelector('textarea[name="plain"]');
  assert.equal(rich.hidden, true);
  assert.ok(mountEl.querySelector('.qu-richtext-editor'));
  assert.equal(plain.hidden, false, 'a textarea without the attribute is never touched');
});

test('refreshRichText() re-syncs a bound textarea\'s visible surface after its .value is set programmatically', () => {
  const { mountEl } = mount('<textarea data-qu-richtext><p>Alt</p></textarea>');
  wireRichText({ mountEl });
  const textarea = mountEl.querySelector('textarea[data-qu-richtext]');
  const editor = mountEl.querySelector('.qu-richtext-editor');
  assert.equal(editor.innerHTML, '<p>Alt</p>');

  textarea.value = '<p>Neu</p>';
  assert.equal(editor.innerHTML, '<p>Alt</p>', 'not synced yet - setting .value alone never reaches the editor');
  refreshRichText(textarea);
  assert.equal(editor.innerHTML, '<p>Neu</p>');
});

test('refreshRichText() on a never-bound textarea is a correct no-op (no throw)', () => {
  const { window } = new JSDOM('<!doctype html><body><textarea>x</textarea></body>');
  const textarea = window.document.querySelector('textarea');
  assert.doesNotThrow(() => refreshRichText(textarea));
});

test('wireRichText() called twice on the SAME textarea (a re-render reusing the same node) does not double-bind it', () => {
  const { mountEl } = mount('<textarea data-qu-richtext>x</textarea>');
  wireRichText({ mountEl });
  wireRichText({ mountEl });
  assert.equal(mountEl.querySelectorAll('.qu-richtext-toolbar').length, 1, 'a second wireRichText() call on the same element never adds a second toolbar');
});
