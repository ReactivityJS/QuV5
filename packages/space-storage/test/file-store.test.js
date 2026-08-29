import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/file-store.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'qu-space-filestore-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('append/load round-trips Uint8Array envelope fields through real disk I/O', async () => {
  await withTempDir(async (dir) => {
    const store = createFileStore(dir);
    const envelope = { iv: new Uint8Array([1, 2, 3]), ct: new Uint8Array([4, 5, 6, 7]), ts: 123, to: [{ pub: new Uint8Array([9]), key: new Uint8Array([8, 8]) }] };

    await store.append('node-1', envelope);
    const loaded = await store.load('node-1');

    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0], envelope);
    assert.ok(loaded[0].iv instanceof Uint8Array); // not a plain {"0":1,...} object
  });
});

test('load() on an unwritten node id returns an empty array, not an error', async () => {
  await withTempDir(async (dir) => {
    const store = createFileStore(dir);
    assert.deepEqual(await store.load('never-written'), []);
  });
});

test('a fresh FileStore instance pointed at the same directory sees everything a prior instance wrote - simulates surviving a process restart', async () => {
  await withTempDir(async (dir) => {
    const first = createFileStore(dir);
    await first.append('node-2', { iv: new Uint8Array([1]), ts: 1 });
    await first.append('node-2', { iv: new Uint8Array([2]), ts: 2 });

    const second = createFileStore(dir); // a brand new object, as a restarted process would construct
    const loaded = await second.load('node-2');
    assert.equal(loaded.length, 2);
    assert.deepEqual(Array.from(loaded[1].iv), [2]);
  });
});

test('different node ids are stored in separate files, never mixed', async () => {
  await withTempDir(async (dir) => {
    const store = createFileStore(dir);
    await store.append('a', { ts: 1 });
    await store.append('b', { ts: 2 });
    assert.equal((await store.load('a')).length, 1);
    assert.equal((await store.load('b')).length, 1);
  });
});

test('appended data is actually plain JSON on disk (no binary/opaque format lock-in)', async () => {
  await withTempDir(async (dir) => {
    const store = createFileStore(dir);
    await store.append('c', { ts: 42 });
    const raw = await readFile(join(dir, `${encodeURIComponent('c')}.ndjson`), 'utf8');
    assert.ok(raw.trim().startsWith('{'));
    assert.deepEqual(JSON.parse(raw.trim()), { ts: 42 });
  });
});
