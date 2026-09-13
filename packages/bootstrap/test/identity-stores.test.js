import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { loadOrCreateIdentity, registerIdentityStoreAdapters } from '../src/identity-stores.js';

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

test('loadOrCreateIdentity(): creates once, reloads the SAME identity on every later call for that key', async () => {
  const storage = fakeStorage();
  const first = await loadOrCreateIdentity(storage, 'k');
  const second = await loadOrCreateIdentity(storage, 'k');
  assert.deepEqual(first.signingPub, second.signingPub);
});

test('loadOrCreateIdentity(): a DIFFERENT key on the same storage gets a DIFFERENT identity', async () => {
  const storage = fakeStorage();
  const a = await loadOrCreateIdentity(storage, 'a');
  const b = await loadOrCreateIdentity(storage, 'b');
  assert.notDeepEqual(a.signingPub, b.signingPub);
});

test("registerIdentityStoreAdapters(): 'memory' adapter reuses the same identity across bootstrapSpace-style create() calls for the same key", async () => {
  const registry = new AdapterRegistry();
  registerIdentityStoreAdapters(registry);
  const first = await registry.create('identity', 'memory', { key: 'room-42' });
  const second = await registry.create('identity', 'memory', { key: 'room-42' });
  assert.deepEqual(first.signingPub, second.signingPub);
  const other = await registry.create('identity', 'memory', { key: 'room-43' });
  assert.notDeepEqual(first.signingPub, other.signingPub);
});

test("registerIdentityStoreAdapters(): 'local-storage'/'session-storage' throw a clear error when no such global exists (this test's own Node process)", async () => {
  const registry = new AdapterRegistry();
  registerIdentityStoreAdapters(registry);
  await assert.rejects(() => registry.create('identity', 'local-storage', { key: 'k' }), /no global localStorage/);
  await assert.rejects(() => registry.create('identity', 'session-storage', { key: 'k' }), /no global sessionStorage/);
});
