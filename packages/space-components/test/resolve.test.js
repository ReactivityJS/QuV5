/**
 * RESOLVE / CONTEXT — `self` (Phase 5's own "symbolic self-reference"
 * addition, `resolve.js`/`context.js`'s own doc comments): proves
 * `resolveNodeRef()` resolves BOTH `kindSchema` and `nodeId` together from
 * the nearest ancestor's `.quSelfNodeId`/`.quSelfKind` when the `self`
 * attribute is present, takes priority over `kind`/`node-id` if somehow
 * both are given, and stays a correct "not yet resolvable" `null` (never a
 * throw) when no ancestor has a self-context at all (an aggregate feed
 * shell, a "not found" fallback - `@qu/app-shell`'s `boot.js` own doc
 * comment on when it clears these).
 *
 * Pure DOM, no Custom Element registration needed - `resolveNodeRef()`
 * only ever reads attributes/properties/ancestry off whatever `Element` is
 * handed to it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { resolveNodeRef } from '../src/resolve.js';
import { findQuSelf } from '../src/context.js';

const { window } = new JSDOM('<!doctype html><body></body>');
const { document } = window;

function mount({ quSpace, quSelfNodeId, quSelfKind } = {}) {
  const container = document.createElement('div');
  if (quSpace !== undefined) container.quSpace = quSpace;
  if (quSelfNodeId !== undefined) container.quSelfNodeId = quSelfNodeId;
  if (quSelfKind !== undefined) container.quSelfKind = quSelfKind;
  document.body.appendChild(container);
  return container;
}

test('findQuSelf() reads {nodeId, kindSchema} off the nearest ancestor exposing .quSelfNodeId', () => {
  const kindSchema = { kind: 'qu-page' };
  const container = mount({ quSelfNodeId: 'page-1', quSelfKind: kindSchema });
  const el = document.createElement('span');
  container.appendChild(el);

  assert.deepEqual(findQuSelf(el), { nodeId: 'page-1', kindSchema });
  container.remove();
});

test('findQuSelf() returns null when no ancestor has a self-context', () => {
  const container = mount({});
  const el = document.createElement('span');
  container.appendChild(el);

  assert.equal(findQuSelf(el), null);
  container.remove();
});

test('resolveNodeRef() with the "self" attribute resolves against the ancestor self-context', () => {
  const kindSchema = { kind: 'qu-page' };
  const space = {};
  const container = mount({ quSpace: space, quSelfNodeId: 'page-1', quSelfKind: kindSchema });
  const el = document.createElement('qu-bind');
  el.setAttribute('self', '');
  el.setAttribute('field', 'title');
  container.appendChild(el);

  assert.deepEqual(resolveNodeRef(el), { space, kindSchema, nodeId: 'page-1' });
  container.remove();
});

test('resolveNodeRef() with "self" set but no self-context on any ancestor resolves to null (not an error)', () => {
  const container = mount({ quSpace: {} });
  const el = document.createElement('qu-bind');
  el.setAttribute('self', '');
  container.appendChild(el);

  assert.equal(resolveNodeRef(el), null);
  container.remove();
});

test('resolveNodeRef() "self" takes priority over kind/node-id when both are somehow present', () => {
  const selfKind = { kind: 'qu-page' };
  const otherKind = { kind: 'qu-template' };
  const space = {};
  const container = mount({ quSpace: space, quSelfNodeId: 'page-1', quSelfKind: selfKind });
  container.quKinds = { other: otherKind };
  const el = document.createElement('qu-bind');
  el.setAttribute('self', '');
  el.setAttribute('kind', 'other');
  el.setAttribute('node-id', 'unrelated-id');
  container.appendChild(el);

  assert.deepEqual(resolveNodeRef(el), { space, kindSchema: selfKind, nodeId: 'page-1' });
  container.remove();
});

test('resolveNodeRef() without "self" still resolves via plain kind/node-id, unchanged', () => {
  const kindSchema = { kind: 'qu-template' };
  const space = {};
  const container = mount({ quSpace: space });
  container.quKinds = { tpl: kindSchema };
  const el = document.createElement('qu-view');
  el.setAttribute('kind', 'tpl');
  el.setAttribute('node-id', 'n1');
  container.appendChild(el);

  assert.deepEqual(resolveNodeRef(el), { space, kindSchema, nodeId: 'n1' });
  container.remove();
});

test('resolveNodeRef() returns null with no .quSpace anywhere in the ancestry, self or not', () => {
  const container = mount({ quSelfNodeId: 'page-1', quSelfKind: { kind: 'qu-page' } });
  const el = document.createElement('qu-bind');
  el.setAttribute('self', '');
  container.appendChild(el);

  assert.equal(resolveNodeRef(el), null);
  container.remove();
});
