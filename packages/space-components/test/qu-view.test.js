/**
 * QU-VIEW — proves the declarative wrapper actually does what qu-view.js's
 * own doc comment claims: resolves its Node reference from attributes/
 * properties/DOM-ancestry (including the "ancestor context arrives one
 * microtask late" ordering hazard - see resolve.js's own doc comment),
 * subscribes via a fake `Space` (isolating this from real @qu/space-core/
 * Yjs, the same posture space-ui's own bind.test.js takes), renders and
 * live-updates, and releases its subscription on disconnect.
 *
 * ONE shared jsdom window for the whole file (not a fresh one per test,
 * unlike bind.test.js's `dom()` helper) - `class QuView extends HTMLElement`
 * binds to whichever `HTMLElement` was global at import time, so every
 * element this file creates has to come from that SAME window/document.
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

const { QuView } = await import('../src/qu-view.js');
if (!customElements.get('qu-view')) customElements.define('qu-view', QuView);

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

/** A minimal fake `Space`: `useNode(nodeId, kindSchema)` -> `{node, release}`, `node.field(name)` -> a fresh `fakeField()`, memoized per `nodeId`+`name` so a test can seed/observe it. */
function fakeSpace() {
  const nodesByFields = new Map();
  const releaseLog = [];
  function fieldsFor(nodeId) {
    if (!nodesByFields.has(nodeId)) nodesByFields.set(nodeId, new Map());
    return nodesByFields.get(nodeId);
  }
  return {
    releaseLog,
    async useNode(nodeId, kindSchema) {
      const fields = fieldsFor(nodeId);
      const node = { kindSchema, field: (name) => (fields.has(name) ? fields.get(name) : fields.set(name, fakeField()).get(name)) };
      return { node, release: () => releaseLog.push(nodeId) };
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

test('renders the field value into textContent by default', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', 'Alice');
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;

  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  container.appendChild(el);
  await tick();

  assert.equal(el.textContent, 'Alice');
  container.remove();
});

test('updates live when the field changes remotely', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', 'Alice');
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;

  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  container.appendChild(el);
  await tick();
  assert.equal(el.textContent, 'Alice');

  await space.field('n1', 'alias')._remoteSet('Carol');
  await tick();
  assert.equal(el.textContent, 'Carol');
  container.remove();
});

test('retries once on the next microtask if ancestor context arrives after append', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  container.appendChild(el); // connectedCallback runs now - no .quSpace yet.

  const space = fakeSpace();
  space.seed('n1', 'alias', 'Bob');
  container.quSpace = space; // set in the SAME synchronous tick, after append - the ordering hazard resolveField()'s retry exists for.
  await tick();

  assert.equal(el.textContent, 'Bob');
  container.remove();
});

test('resolves a string kind="" attribute via an ancestor\'s .quKinds registry', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', 'Dana');
  const kindSchema = { kind: 'profile' };
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;
  container.quKinds = { profile: kindSchema };

  const el = document.createElement('qu-view');
  el.setAttribute('kind', 'profile');
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  container.appendChild(el);
  await tick();

  assert.equal(el.textContent, 'Dana');
  container.remove();
});

test('a computed node-id set as a JS property works the same as the attribute (the "current visitor" case)', async () => {
  const space = fakeSpace();
  space.seed('visitor-42', 'alias', 'Erin');
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;

  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'profile' };
  el.nodeId = 'visitor-42'; // computed in JS, e.g. deriveOwnerNodeId(identity.signingPub, 'profile') - never a plain attribute, see resolve.js's own doc comment.
  el.setAttribute('field', 'alias');
  container.appendChild(el);
  await tick();

  assert.equal(el.textContent, 'Erin');
  container.remove();
});

test('binds to its sole child element instead of itself, e.g. a wrapped <input>', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', 'Frank');
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;

  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  const input = document.createElement('input');
  el.appendChild(input);
  container.appendChild(el);
  await tick();

  assert.equal(input.value, 'Frank');
  assert.equal(el.textContent, ''); // the wrapper itself was never written to.
  container.remove();
});

test('releases its Node subscription on disconnect', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', 'Gina');
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;

  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  container.appendChild(el);
  await tick();

  el.remove();
  assert.deepEqual(space.releaseLog, ['n1']);
  container.remove();
});

test('attr="innerHTML" is refused - live Space data is never rendered as markup here', async () => {
  const space = fakeSpace();
  space.seed('n1', 'alias', '<b>x</b>');
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.quSpace = space;

  const el = document.createElement('qu-view');
  el.kindSchema = { kind: 'test-kind' };
  el.setAttribute('node-id', 'n1');
  el.setAttribute('field', 'alias');
  el.setAttribute('attr', 'innerHTML');
  container.appendChild(el); // connectedCallback() fires synchronously; the async _start() it kicks off is what actually rejects.

  await assert.rejects(() => el._started, /innerHTML/);
  container.remove();
});
