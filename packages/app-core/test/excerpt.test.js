/**
 * `excerptFromHtml()` — see dev.js's own doc comment: the plaintext
 * snippet `publishRoute()`/`publishGlobalRoute()` store as `excerpt` so
 * `view-sources.js`'s `openLiveView().setQuery()` can search page/post
 * CONTENT, not just titles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerptFromHtml } from '../src/dev.js';

test('excerptFromHtml() strips tags and collapses whitespace', () => {
  assert.equal(excerptFromHtml('<p>Hallo <b>Welt</b></p>'), 'Hallo Welt');
  assert.equal(excerptFromHtml('<p>Zeile 1</p>\n<p>Zeile 2</p>'), 'Zeile 1 Zeile 2');
});

test('excerptFromHtml() truncates past maxLen with a trailing ellipsis', () => {
  const long = `<p>${'x'.repeat(300)}</p>`;
  const result = excerptFromHtml(long, 50);
  assert.equal(result.length, 51); // 50 chars + '…'
  assert.ok(result.endsWith('…'));
});

test('excerptFromHtml() leaves short text untouched (no ellipsis)', () => {
  assert.equal(excerptFromHtml('<p>Kurz</p>', 50), 'Kurz');
});

test('excerptFromHtml() handles empty/undefined input', () => {
  assert.equal(excerptFromHtml(''), '');
  assert.equal(excerptFromHtml(undefined), '');
});
