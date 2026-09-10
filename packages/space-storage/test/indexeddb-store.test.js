/**
 * INDEXEDDB STORE — proves the browser-client persistence tier against a
 * REAL IndexedDB implementation (`fake-indexeddb`, a spec-faithful pure-JS
 * polyfill - the standard way to exercise IndexedDB code under `node --test`,
 * since Node has no native `indexedDB` global and jsdom does not implement
 * one either), not a hand-rolled mock - the same "prove the actual contract
 * a real browser gives us" posture `file-store.js`'s own test suite already
 * has for real disk I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto'; // installs `indexedDB`/`IDBKeyRange` etc. on globalThis - see this file's own top doc comment.
import { createIndexedDbStore, isIndexedDbAvailable } from '../src/indexeddb-store.js';

let dbCounter = 0;
function freshStore() {
  // A fresh database NAME per test, not just a fresh store object - `fake-indexeddb`'s global
  // registry is shared across the whole process, so two tests reusing the same default name would
  // otherwise see each other's data.
  return createIndexedDbStore({ dbName: `qu-space-storage-test-${dbCounter++}` });
}

test('isIndexedDbAvailable() is true once the polyfill is installed', () => {
  assert.equal(isIndexedDbAvailable(), true);
});

test('append/load round-trips Uint8Array envelope fields with no encoding step needed', async () => {
  const store = freshStore();
  const envelope = { iv: new Uint8Array([1, 2, 3]), ct: new Uint8Array([4, 5, 6, 7]), ts: 123, to: [{ pub: new Uint8Array([9]), key: new Uint8Array([8, 8]) }] };

  await store.append('node-1', envelope);
  const loaded = await store.load('node-1');

  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], envelope);
  assert.ok(loaded[0].iv instanceof Uint8Array, 'structured clone preserves Uint8Array natively - not a plain {"0":1,...} object');
});

test('load() on an unwritten node id returns an empty array, not an error', async () => {
  const store = freshStore();
  assert.deepEqual(await store.load('never-written'), []);
});

test('append() preserves insertion order across multiple envelopes for the same node', async () => {
  const store = freshStore();
  await store.append('node-2', { ts: 1 });
  await store.append('node-2', { ts: 2 });
  await store.append('node-2', { ts: 3 });

  const loaded = await store.load('node-2');
  assert.deepEqual(loaded.map((e) => e.ts), [1, 2, 3]);
});

test('different node ids are stored separately, never mixed', async () => {
  const store = freshStore();
  await store.append('a', { ts: 1 });
  await store.append('b', { ts: 2 });
  assert.equal((await store.load('a')).length, 1);
  assert.equal((await store.load('b')).length, 1);
});

test('replace() discards the entire prior log and keeps only the new envelopes, in order', async () => {
  const store = freshStore();
  await store.append('node-3', { ts: 1 });
  await store.append('node-3', { ts: 2 });
  await store.append('node-3', { ts: 3 });

  await store.replace('node-3', [{ ts: 100, snapshot: true }]);

  const loaded = await store.load('node-3');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].ts, 100);
});

test('replace() on a node id never previously written just seeds it fresh', async () => {
  const store = freshStore();
  await store.replace('node-4', [{ ts: 1 }, { ts: 2 }]);
  const loaded = await store.load('node-4');
  assert.deepEqual(loaded.map((e) => e.ts), [1, 2]);
});

test('a fresh store instance pointed at the same dbName sees everything a prior instance wrote - simulates surviving a page reload', async () => {
  const dbName = `qu-space-storage-test-reload-${dbCounter++}`;
  const first = createIndexedDbStore({ dbName });
  await first.append('node-5', { iv: new Uint8Array([1]), ts: 1 });
  await first.append('node-5', { iv: new Uint8Array([2]), ts: 2 });

  const second = createIndexedDbStore({ dbName }); // a brand new object, as a fresh page load would construct
  const loaded = await second.load('node-5');
  assert.equal(loaded.length, 2);
  assert.deepEqual(Array.from(loaded[1].iv), [2]);
});
