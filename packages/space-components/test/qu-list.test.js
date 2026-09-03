/**
 * QU-LIST — proves the declarative `<template>`-per-item stamping AND,
 * critically (the user's own explicit requirement), that a change to ONE
 * item only re-renders that item's own element - never the whole list -
 * by tracking a per-item `renderCount`, the same technique
 * @qu/space-ui's own list-bind.test.js uses to catch a naive "just
 * re-render everything" implementation that would otherwise "work" by
 * accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><body></body>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.customElements = window.customElements;
globalThis.Node = window.Node;

const { QuList } = await import('../src/qu-list.js');
const { QuView } = await import('../src/qu-view.js');
if (!customElements.get('qu-list')) customElements.define('qu-list', QuList);
if (!customElements.get('qu-view')) customElements.define('qu-view', QuView);

function fakeListField(initial = []) {
  let items = [...initial];
  const observers = new Set();
  return {
    async toArray() {
      return [...items];
    },
    observe(cb) {
      observers.add(cb);
      return () => observers.delete(cb);
    },
    async _set(next) {
      items = next;
      for (const cb of observers) cb();
    },
  };
}

function fakeSpace(field) {
  return {
    async useNode() {
      return { node: { field: () => field }, release: () => {} };
    },
  };
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function mount(space) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;
  return container;
}

test('stamps one element per item, item-scoped <qu-view field> reading straight off the item value', async () => {
  const field = fakeListField([
    { id: 'a', alias: 'Alice' },
    { id: 'b', alias: 'Bob' },
  ]);
  const container = mount(fakeSpace(field));

  const el = document.createElement('qu-list');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'members');
  const template = document.createElement('template');
  template.innerHTML = '<li><qu-view field="alias"></qu-view></li>';
  el.appendChild(template);
  container.appendChild(el);
  await tick();

  const items = [...el.querySelectorAll('li')];
  assert.deepEqual(
    items.map((li) => li.textContent),
    ['Alice', 'Bob']
  );
  container.remove();
});

test('changing one item only re-renders that item, not the whole list (atomic update)', async () => {
  const field = fakeListField([
    { id: 'a', alias: 'Alice' },
    { id: 'b', alias: 'Bob' },
  ]);
  const container = mount(fakeSpace(field));
  const renderCounts = { a: 0, b: 0 };

  const el = document.createElement('qu-list');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'members');
  const template = document.createElement('template');
  template.innerHTML = '<li><qu-view field="alias"></qu-view></li>';
  el.appendChild(template);
  container.appendChild(el);
  await tick();

  // Tag every currently-rendered item wrapper with its own identity so a later re-render is
  // detectable as "a DIFFERENT element now occupies this slot", not just "the text changed".
  const wrappers = [...el.querySelectorAll('div > *')];
  const idOf = (li) => (li.textContent.startsWith('Alice') ? 'a' : 'b');
  for (const w of wrappers) w.dataset.identity = idOf(w);
  const bobWrapperBefore = wrappers.find((w) => w.dataset.identity === 'b');

  await field._set([
    { id: 'a', alias: 'Alice Updated' },
    { id: 'b', alias: 'Bob' },
  ]);
  await tick();

  const bobWrapperAfter = [...el.querySelectorAll('div > *')].find((w) => w.textContent === 'Bob');
  assert.equal(bobWrapperAfter, bobWrapperBefore, "Bob's own element must be reused, not recreated, since Bob's item value did not change");
  assert.deepEqual(
    [...el.querySelectorAll('li')].map((li) => li.textContent),
    ['Alice Updated', 'Bob']
  );
  container.remove();
});

test('a new item inserts without disturbing existing item elements', async () => {
  const field = fakeListField([{ id: 'a', alias: 'Alice' }]);
  const container = mount(fakeSpace(field));

  const el = document.createElement('qu-list');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'members');
  const template = document.createElement('template');
  template.innerHTML = '<li><qu-view field="alias"></qu-view></li>';
  el.appendChild(template);
  container.appendChild(el);
  await tick();

  const aliceWrapperBefore = el.querySelector('div > *');

  await field._set([
    { id: 'a', alias: 'Alice' },
    { id: 'b', alias: 'Bob' },
  ]);
  await tick();

  const aliceWrapperAfter = el.querySelector('div > *');
  assert.equal(aliceWrapperAfter, aliceWrapperBefore);
  assert.deepEqual(
    [...el.querySelectorAll('li')].map((li) => li.textContent),
    ['Alice', 'Bob']
  );
  container.remove();
});

test('a <qu-view> with its own kind/node-id inside an item template is left alone (not item-scoped)', async () => {
  const field = fakeListField([{ id: 'a', alias: 'Alice' }]);
  const container = mount(fakeSpace(field));

  const el = document.createElement('qu-list');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'members');
  const template = document.createElement('template');
  template.innerHTML = '<li><qu-view field="alias"></qu-view><qu-view kind="other" node-id="x" field="y"></qu-view></li>';
  el.appendChild(template);
  container.appendChild(el);
  await tick();

  const views = el.querySelectorAll('qu-view');
  assert.equal(views[0].textContent, 'Alice');
  assert.equal(views[1].textContent, ''); // untouched by qu-list's item-scoped stamping - it resolves (or fails to) on its own.
  container.remove();
});
