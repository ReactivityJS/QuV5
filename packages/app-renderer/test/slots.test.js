import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resolveSlots } from '../src/slots.js';

function dom() {
  return new JSDOM('<!doctype html><body></body>').window.document;
}

test('resolveSlots() replaces a named slot with the matching content', () => {
  const doc = dom();
  const template = '<main><header>H</header><qu-slot name="content"></qu-slot></main>';
  const out = resolveSlots(template, { content: '<p>body</p>' }, doc);
  assert.equal(out, '<main><header>H</header><p>body</p></main>');
});

test('resolveSlots() falls back to the slot\'s own children when no content is supplied for that name', () => {
  const doc = dom();
  const template = '<main><qu-slot name="footer">© Default</qu-slot></main>';
  const out = resolveSlots(template, {}, doc);
  assert.equal(out, '<main>© Default</main>');
});

test('resolveSlots() resolves multiple distinct named slots independently', () => {
  const doc = dom();
  const template = '<div><qu-slot name="a"></qu-slot>-<qu-slot name="b"></qu-slot></div>';
  const out = resolveSlots(template, { a: '1', b: '2' }, doc);
  assert.equal(out, '<div>1-2</div>');
});

test('resolveSlots() with no <qu-slot> tags returns the template unchanged', () => {
  const doc = dom();
  const out = resolveSlots('<p>plain</p>', { content: 'unused' }, doc);
  assert.equal(out, '<p>plain</p>');
});
