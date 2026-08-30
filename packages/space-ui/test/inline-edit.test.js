/**
 * INLINE EDIT — see inline-edit.js's own doc comment. Same fake-Field
 * isolation strategy as bind.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeInlineEditable } from '../src/inline-edit.js';

function fakeField(initial = '') {
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

test('renders the field\'s current value, and stays live while not editing', async () => {
  const { document } = dom();
  const el = document.createElement('div');
  const field = fakeField('hello');
  makeInlineEditable(el, field);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, 'hello');

  await field._remoteSet('updated remotely');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, 'updated remotely');
});

test('a remote change while editing does NOT clobber the in-progress edit', async () => {
  const { document, FocusEvent } = dom();
  const el = document.createElement('div');
  const field = fakeField('hello');
  makeInlineEditable(el, field);
  await new Promise((r) => setTimeout(r, 0));

  el.dispatchEvent(new FocusEvent('focus'));
  el.textContent = 'mid edit...';
  await field._remoteSet('someone else changed it');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(el.textContent, 'mid edit...'); // untouched by the remote change while focused.
});

test('blur saves the current textContent to the field', async () => {
  const { document, FocusEvent } = dom();
  const el = document.createElement('div');
  const field = fakeField('hello');
  const saved = [];
  makeInlineEditable(el, field, { onSave: (v) => saved.push(v) });
  await new Promise((r) => setTimeout(r, 0));

  el.dispatchEvent(new FocusEvent('focus'));
  el.textContent = 'new value';
  el.dispatchEvent(new FocusEvent('blur'));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(await field.get(), 'new value');
  assert.deepEqual(saved, ['new value']);
});

test('Escape reverts to the last-known field value and does NOT save', async () => {
  const { document, FocusEvent, KeyboardEvent } = dom();
  const el = document.createElement('div');
  const field = fakeField('original');
  const saved = [];
  const cancelled = [];
  makeInlineEditable(el, field, { onSave: (v) => saved.push(v), onCancel: (v) => cancelled.push(v) });
  await new Promise((r) => setTimeout(r, 0));

  el.dispatchEvent(new FocusEvent('focus'));
  el.textContent = 'changed my mind';
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(el.textContent, 'original');
  assert.equal(await field.get(), 'original'); // never written.
  assert.deepEqual(saved, []);
  assert.deepEqual(cancelled, ['original']);
});

test('Enter (without Shift) saves, same as blur', async () => {
  const { document, FocusEvent, KeyboardEvent } = dom();
  const el = document.createElement('div');
  const field = fakeField('x');
  const saved = [];
  makeInlineEditable(el, field, { onSave: (v) => saved.push(v) });
  await new Promise((r) => setTimeout(r, 0));

  el.dispatchEvent(new FocusEvent('focus'));
  el.textContent = 'via enter';
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(await field.get(), 'via enter');
  assert.deepEqual(saved, ['via enter']);
});
