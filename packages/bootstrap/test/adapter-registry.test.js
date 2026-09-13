import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '../src/adapter-registry.js';

test('AdapterRegistry: register then create resolves via the factory', async () => {
  const registry = new AdapterRegistry();
  registry.register('storage', 'fake', ({ label } = {}) => ({ label }));
  const instance = await registry.create('storage', 'fake', { label: 'hi' });
  assert.deepEqual(instance, { label: 'hi' });
});

test('AdapterRegistry: create() without options still works (factory gets {})', async () => {
  const registry = new AdapterRegistry();
  registry.register('storage', 'fake', (options) => options);
  assert.deepEqual(await registry.create('storage', 'fake'), {});
});

test('AdapterRegistry: registering the same (slot, name) twice throws', () => {
  const registry = new AdapterRegistry();
  registry.register('storage', 'fake', () => ({}));
  assert.throws(() => registry.register('storage', 'fake', () => ({})), /already registered/);
});

test('AdapterRegistry: the SAME name may be registered for a DIFFERENT slot', async () => {
  const registry = new AdapterRegistry();
  registry.register('storage', 'memory', () => 'storage-memory');
  registry.register('volatileStorage', 'memory', () => 'volatile-memory');
  assert.equal(await registry.create('storage', 'memory'), 'storage-memory');
  assert.equal(await registry.create('volatileStorage', 'memory'), 'volatile-memory');
});

test('AdapterRegistry: create() for an unknown name throws, listing what IS registered', async () => {
  const registry = new AdapterRegistry();
  registry.register('storage', 'memory', () => ({}));
  registry.register('storage', 'file', () => ({}));
  await assert.rejects(() => registry.create('storage', 'nope'), (err) => {
    assert.match(err.message, /no "nope" adapter registered for slot "storage"/);
    assert.match(err.message, /memory/);
    assert.match(err.message, /file/);
    return true;
  });
});

test('AdapterRegistry: create() for an entirely unregistered slot throws a "none registered" hint', async () => {
  const registry = new AdapterRegistry();
  await assert.rejects(() => registry.create('transport', 'ws-client'), /no adapters registered for slot "transport" at all/);
});

test('AdapterRegistry: has()/names() reflect what was registered', () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.has('storage', 'memory'), false);
  registry.register('storage', 'memory', () => ({}));
  registry.register('storage', 'file', () => ({}));
  assert.equal(registry.has('storage', 'memory'), true);
  assert.deepEqual(new Set(registry.names('storage')), new Set(['memory', 'file']));
  assert.deepEqual(registry.names('transport'), []);
});

test('AdapterRegistry: a factory may return a Promise - create() awaits it', async () => {
  const registry = new AdapterRegistry();
  registry.register('identity', 'async-fake', async () => {
    await Promise.resolve();
    return { ok: true };
  });
  assert.deepEqual(await registry.create('identity', 'async-fake'), { ok: true });
});
