/**
 * RELAY IDENTITY — proves the "auto-generate on first boot, persist,
 * reuse on every later boot" contract relay-identity.js exists for (see
 * that file's own doc comment on why this replaces a manual keygen-then-
 * paste chicken-and-egg step).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity, describeIdentity } from '../src/relay-identity.js';

test('loadOrCreateIdentity() generates a fresh identity when the file does not exist yet, and persists it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-identity-'));
  try {
    const filePath = join(dir, 'nested', 'relay-identity.json'); // also proves it creates missing parent dirs.
    const { identity, created } = await loadOrCreateIdentity(filePath);
    assert.equal(created, true);
    assert.equal(identity.signingPub.length, 32);
    assert.equal(identity.xPublicKey.length, 32);

    const fileStat = await stat(filePath);
    assert.ok(fileStat.isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadOrCreateIdentity() reuses the SAME identity on a later call against the same file - never regenerates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-identity-'));
  try {
    const filePath = join(dir, 'relay-identity.json');
    const first = await loadOrCreateIdentity(filePath);
    assert.equal(first.created, true);

    const second = await loadOrCreateIdentity(filePath);
    assert.equal(second.created, false);
    assert.deepEqual(second.identity.signingPub, first.identity.signingPub);
    assert.deepEqual(second.identity.xPublicKey, first.identity.xPublicKey);
    assert.deepEqual(second.identity.signingKey, first.identity.signingKey);
    assert.deepEqual(second.identity.xPrivateKey, first.identity.xPrivateKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('describeIdentity() exposes only the PUBLIC halves, never the private keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-identity-'));
  try {
    const { identity } = await loadOrCreateIdentity(join(dir, 'relay-identity.json'));
    const described = await describeIdentity(identity);
    assert.equal('signingKey' in described, false);
    assert.equal('xPrivateKey' in described, false);
    assert.ok(described.fingerprint);
    assert.ok(described.pub);
    assert.ok(described.xPub);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
