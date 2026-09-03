/**
 * QU-BIND — proves both editing modes qu-bind.js's own doc comment
 * describes: LIVE two-way binding (default) and the explicit
 * save/cancel `editable="inline"` chrome (pencil/save/cancel icons,
 * built on @qu/space-ui's `makeInlineEditable()`).
 *
 * Same one-shared-jsdom-window-per-file posture as qu-view.test.js's own
 * doc comment explains.
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

const { QuBind } = await import('../src/qu-bind.js');
if (!customElements.get('qu-bind')) customElements.define('qu-bind', QuBind);

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
    async _remoteSet(v) {
      value = v;
      for (const cb of observers) cb();
    },
  };
}

function fakeSpace() {
  const nodesByFields = new Map();
  function fieldsFor(nodeId) {
    if (!nodesByFields.has(nodeId)) nodesByFields.set(nodeId, new Map());
    return nodesByFields.get(nodeId);
  }
  return {
    async useNode(nodeId) {
      const fields = fieldsFor(nodeId);
      const node = { field: (name) => (fields.has(name) ? fields.get(name) : fields.set(name, fakeField()).get(name)) };
      return { node, release: () => {} };
    },
    seed(nodeId, name, value) {
      fieldsFor(nodeId).set(name, fakeField(value));
    },
    field(nodeId, name) {
      return fieldsFor(nodeId).get(name);
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

test('default mode: live two-way binding on a wrapped <input>', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', 'Alice');
  const container = mount(space);

  const el = document.createElement('qu-bind');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  const input = document.createElement('input');
  el.appendChild(input);
  container.appendChild(el);
  await tick();
  assert.equal(input.value, 'Alice');

  input.value = 'Alice B.';
  input.dispatchEvent(new window.Event('input'));
  await tick();
  assert.equal(await space.field('n1', 'alias').get(), 'Alice B.');
  container.remove();
});

test('editable="inline": renders read-only chrome with a visible edit icon and hidden save/cancel', async () => {
  const space = fakeSpace();
  space.seed('n1', 'bio', 'Hello.');
  const container = mount(space);

  const el = document.createElement('qu-bind');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'bio');
  el.setAttribute('editable', 'inline');
  container.appendChild(el);
  await tick();

  const text = el.querySelector('.qu-bind__text');
  const editIcon = el.querySelector('.qu-bind__edit-icon');
  const saveIcon = el.querySelector('.qu-bind__save-icon');
  const cancelIcon = el.querySelector('.qu-bind__cancel-icon');
  assert.equal(text.textContent, 'Hello.');
  assert.equal(text.contentEditable, 'false');
  assert.equal(editIcon.hidden, false);
  assert.equal(saveIcon.hidden, true);
  assert.equal(cancelIcon.hidden, true);
  container.remove();
});

test('editable="inline": clicking the edit icon enters edit mode; Save writes the field', async () => {
  const space = fakeSpace();
  space.seed('n1', 'bio', 'Hello.');
  const container = mount(space);

  const el = document.createElement('qu-bind');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'bio');
  el.setAttribute('editable', 'inline');
  container.appendChild(el);
  await tick();

  const text = el.querySelector('.qu-bind__text');
  const editIcon = el.querySelector('.qu-bind__edit-icon');
  const saveIcon = el.querySelector('.qu-bind__save-icon');

  editIcon.dispatchEvent(new window.Event('click'));
  assert.equal(text.contentEditable, 'true');
  assert.equal(editIcon.hidden, true);
  assert.equal(saveIcon.hidden, false);

  text.textContent = 'Updated bio.';
  saveIcon.dispatchEvent(new window.Event('click'));
  await tick();

  assert.equal(await space.field('n1', 'bio').get(), 'Updated bio.');
  assert.equal(text.contentEditable, 'false');
  assert.equal(editIcon.hidden, false);
  container.remove();
});

test('editable="inline": Cancel reverts without writing the field', async () => {
  const space = fakeSpace();
  space.seed('n1', 'bio', 'Hello.');
  const container = mount(space);

  const el = document.createElement('qu-bind');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'bio');
  el.setAttribute('editable', 'inline');
  container.appendChild(el);
  await tick();

  const text = el.querySelector('.qu-bind__text');
  el.querySelector('.qu-bind__edit-icon').dispatchEvent(new window.Event('click'));
  text.textContent = 'Discarded edit.';
  el.querySelector('.qu-bind__cancel-icon').dispatchEvent(new window.Event('click'));
  await tick();

  assert.equal(await space.field('n1', 'bio').get(), 'Hello.');
  assert.equal(text.textContent, 'Hello.');
  assert.equal(text.contentEditable, 'false');
  container.remove();
});

test('edit-icon="always" skips the hover-only class', async () => {
  const space = fakeSpace();
  space.seed('n1', 'bio', 'Hello.');
  const container = mount(space);

  const el = document.createElement('qu-bind');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'bio');
  el.setAttribute('editable', 'inline');
  el.setAttribute('edit-icon', 'always');
  container.appendChild(el);
  await tick();

  assert.equal(el.classList.contains('qu-bind--edit-always'), true);
  assert.equal(el.classList.contains('qu-bind--edit-hover'), false);
  container.remove();
});
