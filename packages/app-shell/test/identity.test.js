import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOrCreateIdentity, joinSpace } from '../src/identity.js';

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

test('loadOrCreateIdentity() generates a new identity once, then returns the SAME one on every later call', async () => {
  const storage = fakeStorage();
  const first = await loadOrCreateIdentity(storage, 'test-identity');
  const second = await loadOrCreateIdentity(storage, 'test-identity');
  assert.deepEqual(Array.from(first.signingPub), Array.from(second.signingPub));
  assert.deepEqual(Array.from(first.signingKey), Array.from(second.signingKey));
});

test('loadOrCreateIdentity() called TWICE CONCURRENTLY for the same never-yet-created key does not generate two different keypairs - both callers get the SAME identity, and only one ends up persisted', async () => {
  const storage = fakeStorage();
  // Both calls start before either has finished - key generation is genuinely async (Web Crypto),
  // so without de-duplication both would see "nothing stored yet" and each generate its own
  // keypair, the second write silently clobbering the first (see identity.js's own doc comment on
  // why dev-console.js's window.Qu and shell.js's <qu-app-shell> boot can now race for this exact
  // key on the same page).
  const [first, second] = await Promise.all([loadOrCreateIdentity(storage, 'race-key'), loadOrCreateIdentity(storage, 'race-key')]);
  assert.deepEqual(Array.from(first.signingPub), Array.from(second.signingPub));
  assert.deepEqual(Array.from(first.signingKey), Array.from(second.signingKey));

  // And the persisted value matches what both callers got - a THIRD, later call reads back the
  // exact same identity, not some orphaned third keypair.
  const third = await loadOrCreateIdentity(storage, 'race-key');
  assert.deepEqual(Array.from(first.signingPub), Array.from(third.signingPub));
});

test('loadOrCreateIdentity() with different storage keys yields different identities', async () => {
  const storage = fakeStorage();
  const a = await loadOrCreateIdentity(storage, 'a');
  const b = await loadOrCreateIdentity(storage, 'b');
  assert.notDeepEqual(Array.from(a.signingPub), Array.from(b.signingPub));
});

test('joinSpace() POSTs the public identity halves to /join, then returns the full member list from /members.json', async () => {
  const storage = fakeStorage();
  const identity = await loadOrCreateIdentity(storage, 'x');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/join')) return { ok: true, json: async () => ({}) };
    if (url.endsWith('/members.json')) {
      return {
        ok: true,
        json: async () => [{ name: 'me', pub: btoa('pub'), xPub: btoa('xpub') }],
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  // btoa() produces standard base64, not the framework's own toBase64() format for real keys - fine
  // here, this test only checks that joinSpace() round-trips whatever /members.json returns, not
  // that these particular bytes are cryptographically meaningful.
  const members = await joinSpace({ fetchImpl, baseUrl: '', name: 'me', identity });

  assert.equal(calls[0].url, '/join');
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.name, 'me');
  assert.equal(members.length, 1);
});

test('joinSpace() throws with the relay\'s own error body when /join fails', async () => {
  const storage = fakeStorage();
  const identity = await loadOrCreateIdentity(storage, 'y');
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'not allowed' });
  await assert.rejects(() => joinSpace({ fetchImpl, name: 'me', identity }), /403/);
});
