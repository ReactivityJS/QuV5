/**
 * BIND — see bind.js's own doc comment. Uses a minimal fake Field
 * (`{get, set, observe}`, exactly the shape `bindField()`/`bindCheckbox()`
 * consume) rather than a real `@qu/space-core` Field, isolating this
 * package's own DOM-wiring logic from Yjs/crypto entirely - a real
 * end-to-end Field is covered by upload-status.test.js instead, which
 * genuinely needs `Space`/`UploadOutbox` underneath it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bindField, bindCheckbox } from '../src/bind.js';

function fakeField(initial = null) {
  let value = initial;
  const observers = new Set();
  return {
    async get() {
      return value;
    },
    async set(v) {
      value = v;
      for (const cb of observers) cb();
    },
    observe(cb) {
      observers.add(cb);
      return () => observers.delete(cb);
    },
    // test-only helper to simulate a REMOTE write (bypasses set()'s own notify-to-self, same as a real Field would when another peer writes).
    async _remoteSet(v) {
      value = v;
      for (const cb of observers) cb();
    },
  };
}

function dom() {
  const { window } = new JSDOM('<!doctype html><body></body>');
  return window;
}

test('one-way bindField() renders the field into textContent and updates on change', async () => {
  const { document } = dom();
  const el = document.createElement('span');
  const field = fakeField('hello');

  bindField(el, field);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, 'hello');

  await field._remoteSet('world');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, 'world');
});

test('one-way bindField() on an <input> targets .value by default, never writes back', async () => {
  const { document } = dom();
  const el = document.createElement('input');
  const field = fakeField('initial');

  bindField(el, field);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.value, 'initial');

  el.value = 'user typed this';
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await field.get(), 'initial'); // never written back - one-way.
});

test('two-way bindField() writes back to the field on "input", and does not fight its own echo', async () => {
  const { document, Event } = dom();
  const el = document.createElement('input');
  const field = fakeField('');

  const stop = bindField(el, field, { twoWay: true });
  el.value = 'typed';
  el.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(await field.get(), 'typed');
  assert.equal(el.value, 'typed'); // the field's own re-render (triggered by set()) didn't clobber what's already correctly there.
  stop();
});

test('bindField()\'s returned stop() unobserves - a later field change no longer touches the element', async () => {
  const { document } = dom();
  const el = document.createElement('span');
  const field = fakeField('a');
  const stop = bindField(el, field);
  await new Promise((r) => setTimeout(r, 0));
  stop();

  await field._remoteSet('b');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, 'a'); // unchanged after stop().
});

test('bindCheckbox() is two-way via .checked/"change"', async () => {
  const { document, Event } = dom();
  const el = document.createElement('input');
  el.type = 'checkbox';
  const field = fakeField(false);

  bindCheckbox(el, field);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.checked, false);

  el.checked = true;
  el.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await field.get(), true);

  await field._remoteSet(false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.checked, false);
});
