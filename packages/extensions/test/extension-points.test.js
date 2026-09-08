/**
 * EXTENSION POINT HOST — proves the registry itself (order, id/appId
 * addressing, idempotent re-contribute) and all three read shapes
 * (renderSlot/collect/renderFrom), plus fault isolation and the two
 * test-only clear escape hatches. No DOM dependency beyond a tiny fake
 * element (`fakeContainer()`) - real usage against `jsdom` is covered by
 * `@qu/app-shell`'s own `cms-page-actions.test.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionPointHost, resolveActionHref } from '../src/index.js';

/** A minimal stand-in for a DOM element - just enough for renderSlot()'s `ownerDocument.createElement`/`appendChild`/`dataset` usage. */
function fakeContainer() {
  const doc = {
    createElement: () => ({ dataset: {}, children: [], appendChild(child) { this.children.push(child); } }),
  };
  const container = { ownerDocument: doc, children: [], appendChild(child) { this.children.push(child); } };
  return container;
}

test('contribute() + listContributions() sorts by order then registration sequence', () => {
  const host = new ExtensionPointHost();
  host.contribute('menu.item', { id: 'c', order: 5 });
  host.contribute('menu.item', { id: 'a', order: 0 });
  host.contribute('menu.item', { id: 'b', order: 0 });
  assert.deepEqual(
    host.listContributions('menu.item').map((c) => c.id),
    ['a', 'b', 'c']
  );
});

test('an unknown point lists as empty, never throws', () => {
  const host = new ExtensionPointHost();
  assert.deepEqual(host.listContributions('nothing.here'), []);
});

test('contribute() requires "id", rejects a non-function "handler"', () => {
  const host = new ExtensionPointHost();
  assert.throws(() => host.contribute('p', {}), /"id" is required/);
  assert.throws(() => host.contribute('p', { id: 'x', handler: 'nope' }), /"handler" must be a function/);
});

test('re-contribute()ing the same id replaces it in place (idempotent, keeps original registration order)', () => {
  const host = new ExtensionPointHost();
  host.contribute('p', { id: 'a', order: 0, label: 'first' });
  host.contribute('p', { id: 'b', order: 0, label: 'second' });
  host.contribute('p', { id: 'a', order: 0, label: 'updated' });
  const list = host.listContributions('p');
  assert.deepEqual(
    list.map((c) => c.label),
    ['updated', 'second']
  );
});

test('appId scopes ids - two apps may each contribute their own "edit" id to the same point', () => {
  const host = new ExtensionPointHost();
  host.contribute('p', { id: 'edit', appId: 'blog', label: 'Blog Edit' });
  host.contribute('p', { id: 'edit', appId: 'forum', label: 'Forum Edit' });
  assert.equal(host.listContributions('p').length, 2);
});

test('the unregister function returned by contribute() removes exactly that contribution', () => {
  const host = new ExtensionPointHost();
  const unregister = host.contribute('p', { id: 'a' });
  host.contribute('p', { id: 'b' });
  unregister();
  assert.deepEqual(
    host.listContributions('p').map((c) => c.id),
    ['b']
  );
});

test('uncontribute() on an unknown point/key is a correct no-op', () => {
  const host = new ExtensionPointHost();
  assert.doesNotThrow(() => host.uncontribute('nothing', 'nope'));
});

test('renderSlot() mounts every contributor into its OWN child container, in order, skipping data-only (no-handler) contributions', async () => {
  const host = new ExtensionPointHost();
  const calls = [];
  host.contribute('shell.header', { id: 'search', order: 1, handler: (el, payload) => calls.push(['search', el, payload]) });
  host.contribute('shell.header', { id: 'logo', order: 0, handler: (el, payload) => calls.push(['logo', el, payload]) });
  host.contribute('shell.header', { id: 'data-only', order: 2, label: 'no handler here' });
  const container = fakeContainer();
  const created = await host.renderSlot('shell.header', container, { userId: 'u1' });

  assert.equal(created.length, 2); // the data-only contribution never gets a container.
  assert.equal(container.children.length, 2);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['logo', 'search']
  );
  assert.deepEqual(calls[0][2], { userId: 'u1' });
  assert.equal(calls[0][1], created[0]);
});

test('renderSlot() isolates a throwing contributor - the rest still render, the error is logged not thrown', async () => {
  const host = new ExtensionPointHost();
  const rendered = [];
  host.contribute('p', { id: 'bad', order: 0, handler: () => { throw new Error('boom'); } });
  host.contribute('p', { id: 'good', order: 1, handler: (el) => rendered.push(el) });
  const originalError = console.error;
  console.error = () => {}; // expected: renderSlot() logs the thrown error - keep the test output clean.
  try {
    const created = await host.renderSlot('p', fakeContainer(), null);
    assert.equal(created.length, 2); // both got a container; only "good" actually populated it.
    assert.equal(rendered.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('collect() gathers return values in order, flattens array returns, ignores undefined', async () => {
  const host = new ExtensionPointHost();
  host.contribute('menu.context', { id: 'bookmark', order: 0, handler: () => ({ id: 'bookmark', label: 'Bookmark' }) });
  host.contribute('menu.context', { id: 'noop', order: 1, handler: () => undefined });
  host.contribute('menu.context', { id: 'reactions', order: 2, handler: () => [{ id: 'like' }, { id: 'star' }] });
  const items = await host.collect('menu.context', { entityId: 'e1' });
  assert.deepEqual(
    items.map((i) => i.id),
    ['bookmark', 'like', 'star']
  );
});

test('collect() isolates a throwing contributor - the rest still contribute', async () => {
  const host = new ExtensionPointHost();
  host.contribute('p', { id: 'bad', order: 0, handler: () => { throw new Error('boom'); } });
  host.contribute('p', { id: 'good', order: 1, handler: () => 'ok' });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await host.collect('p', null), ['ok']);
  } finally {
    console.error = originalError;
  }
});

test('renderFrom() calls only the contributor registered under the given appId', async () => {
  const host = new ExtensionPointHost();
  const calls = [];
  host.contribute('search.result', { id: 'render', appId: 'forum', handler: (el, payload) => calls.push(['forum', payload]) });
  host.contribute('search.result', { id: 'render', appId: 'blog', handler: (el, payload) => calls.push(['blog', payload]) });
  await host.renderFrom('search.result', 'blog', fakeContainer(), { hit: 1 });
  assert.deepEqual(calls, [['blog', { hit: 1 }]]);
});

test('renderFrom() returns undefined for an unregistered appId, never throws', async () => {
  const host = new ExtensionPointHost();
  assert.equal(await host.renderFrom('search.result', 'nobody', fakeContainer(), null), undefined);
});

test('_clearForTest() clears every point; _clearPointForTest() clears only the named one', () => {
  const host = new ExtensionPointHost();
  host.contribute('a', { id: 'x' });
  host.contribute('b', { id: 'y' });
  host._clearPointForTest('a');
  assert.deepEqual(host.listContributions('a'), []);
  assert.equal(host.listContributions('b').length, 1);
  host._clearForTest();
  assert.deepEqual(host.listContributions('b'), []);
});

test('resolveActionHref() fills named params, URI-encoding each, and blanks a missing one', () => {
  assert.equal(resolveActionHref({ hrefTemplate: '#/chat/{pub}' }, { pub: 'abc def' }), '#/chat/abc%20def');
  assert.equal(resolveActionHref({ hrefTemplate: '#/user/{id}/posts/{postId}' }, { id: 'u1' }), '#/user/u1/posts/');
  assert.equal(resolveActionHref({}), '');
});
