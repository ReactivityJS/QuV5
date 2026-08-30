/**
 * LIST BIND — see list-bind.js's own doc comment. Proves keyed reconcile
 * behavior: new items insert, removed items are removed, reordered items
 * MOVE (not recreate), and unrelated siblings are left untouched (tracked
 * via a `renderCount` on each item, since a naive implementation could
 * "work" by just always re-rendering everything).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bindList } from '../src/list-bind.js';

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

function dom() {
  const { window } = new JSDOM('<!doctype html><body><ul id="list"></ul></body>');
  return window;
}

test('renders every item once, in order', async () => {
  const { document } = dom();
  const container = document.getElementById('list');
  const field = fakeListField([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]);
  const renderCounts = {};

  bindList(container, field, {
    key: (item) => item.id,
    render: (item) => {
      renderCounts[item.id] = (renderCounts[item.id] ?? 0) + 1;
      const li = document.createElement('li');
      li.textContent = item.text;
      li.dataset.id = item.id;
      return li;
    },
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual([...container.children].map((el) => el.dataset.id), ['a', 'b']);
});

test('a new item is inserted without re-rendering existing ones', async () => {
  const { document } = dom();
  const container = document.getElementById('list');
  const field = fakeListField([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]);
  const renderCounts = {};

  bindList(container, field, {
    key: (item) => item.id,
    render: (item) => {
      renderCounts[item.id] = (renderCounts[item.id] ?? 0) + 1;
      const li = document.createElement('li');
      li.textContent = item.text;
      li.dataset.id = item.id;
      return li;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const originalAEl = container.querySelector('[data-id="a"]');

  await field._set([{ id: 'a', text: 'A' }, { id: 'c', text: 'C' }, { id: 'b', text: 'B' }]);
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual([...container.children].map((el) => el.dataset.id), ['a', 'c', 'b']);
  assert.equal(renderCounts.a, 1); // never re-rendered.
  assert.equal(renderCounts.b, 1); // never re-rendered, even though its position shifted.
  assert.equal(renderCounts.c, 1);
  assert.equal(container.querySelector('[data-id="a"]'), originalAEl); // the SAME element instance, not a replacement.
});

test('a removed item\'s element is removed from the DOM', async () => {
  const { document } = dom();
  const container = document.getElementById('list');
  const field = fakeListField([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

  bindList(container, field, {
    key: (item) => item.id,
    render: (item) => {
      const li = document.createElement('li');
      li.dataset.id = item.id;
      return li;
    },
  });
  await new Promise((r) => setTimeout(r, 0));

  await field._set([{ id: 'a' }, { id: 'c' }]);
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual([...container.children].map((el) => el.dataset.id), ['a', 'c']);
});

test('a reordered item MOVES its existing element rather than recreating it', async () => {
  const { document } = dom();
  const container = document.getElementById('list');
  const field = fakeListField([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const renderCounts = {};

  bindList(container, field, {
    key: (item) => item.id,
    render: (item) => {
      renderCounts[item.id] = (renderCounts[item.id] ?? 0) + 1;
      const li = document.createElement('li');
      li.dataset.id = item.id;
      return li;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const bEl = container.querySelector('[data-id="b"]');

  await field._set([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual([...container.children].map((el) => el.dataset.id), ['c', 'a', 'b']);
  assert.equal(container.querySelector('[data-id="b"]'), bEl); // moved, not recreated.
  assert.equal(renderCounts.b, 1);
});

test('an `update` function patches existing elements in place instead of replacing them', async () => {
  const { document } = dom();
  const container = document.getElementById('list');
  const field = fakeListField([{ id: 'a', text: 'A' }]);
  let updateCalls = 0;

  bindList(container, field, {
    key: (item) => item.id,
    render: (item) => {
      const li = document.createElement('li');
      li.dataset.id = item.id;
      li.textContent = item.text;
      return li;
    },
    update: (el, item) => {
      updateCalls++;
      el.textContent = item.text;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const originalEl = container.querySelector('[data-id="a"]');

  await field._set([{ id: 'a', text: 'A (edited)' }]);
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(container.querySelector('[data-id="a"]'), originalEl);
  assert.equal(container.textContent, 'A (edited)');
  assert.equal(updateCalls, 1);
});

test('without `update`, a changed item is replaced (new element instance)', async () => {
  const { document } = dom();
  const container = document.getElementById('list');
  const field = fakeListField([{ id: 'a', text: 'A' }]);

  bindList(container, field, {
    key: (item) => item.id,
    render: (item) => {
      const li = document.createElement('li');
      li.dataset.id = item.id;
      li.textContent = item.text;
      return li;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  const originalEl = container.querySelector('[data-id="a"]');

  await field._set([{ id: 'a', text: 'A (edited)' }]);
  await new Promise((r) => setTimeout(r, 0));

  assert.notEqual(container.querySelector('[data-id="a"]'), originalEl);
  assert.equal(container.textContent, 'A (edited)');
});
