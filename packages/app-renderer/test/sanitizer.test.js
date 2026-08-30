import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { sanitizeHtml } from '../src/sanitizer.js';

function dom() {
  return new JSDOM('<!doctype html><body></body>').window.document;
}

test('sanitizeHtml() removes <script> elements entirely', () => {
  const doc = dom();
  const out = sanitizeHtml('<p>hi</p><script>alert(1)</script><p>bye</p>', doc);
  assert.ok(!out.includes('<script'));
  assert.ok(out.includes('<p>hi</p>'));
  assert.ok(out.includes('<p>bye</p>'));
});

test('sanitizeHtml() strips on* event-handler attributes', () => {
  const doc = dom();
  const out = sanitizeHtml('<button onclick="doEvil()">click</button>', doc);
  assert.ok(!out.includes('onclick'));
  assert.ok(out.includes('<button>click</button>'));
});

test('sanitizeHtml() strips javascript: URLs from href/src', () => {
  const doc = dom();
  const out = sanitizeHtml('<a href="javascript:alert(1)">link</a>', doc);
  assert.ok(!out.includes('javascript:'));
});

test('sanitizeHtml() leaves ordinary markup, attributes, and qu-* tags untouched', () => {
  const doc = dom();
  const html = '<div class="card"><qu-slot name="content"></qu-slot><a href="https://example.test">ok</a></div>';
  assert.equal(sanitizeHtml(html, doc), html);
});
