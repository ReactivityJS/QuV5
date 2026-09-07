/**
 * `qu-placeholders.js` — unit tests for `resolvePlaceholders()`/
 * `AMBIENT_PLACEHOLDERS`/`ROUTE_SCHEMES` in isolation, no Space/relay needed
 * at all (this module's own whole point: pure string substitution plus one
 * ambient identity lookup).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { resolvePlaceholders, AMBIENT_PLACEHOLDERS, ROUTE_SCHEMES } from '../src/qu-placeholders.js';

test('resolvePlaceholders(): a submitted FIELD value wins over an ambient default of the same name', () => {
  const space = { identity: { signingPub: new Uint8Array(32) } };
  const result = resolvePlaceholders('{yyyy}/{slug}', { space, fields: { yyyy: 'ÜBERSCHRIEBEN', slug: 'mein-titel' } });
  assert.equal(result, 'ÜBERSCHRIEBEN/mein-titel');
});

test('resolvePlaceholders(): {yyyy}/{mm}/{dd} resolve to TODAY\'S date, zero-padded', () => {
  const space = { identity: { signingPub: new Uint8Array(32) } };
  const now = new Date();
  const expected = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(resolvePlaceholders('{yyyy}/{mm}/{dd}', { space }), expected);
});

test('resolvePlaceholders(): {pub} resolves to the ACTING identity\'s own pubkey, base64url-encoded', async () => {
  const kp = await QuCrypto.generateKeypair();
  const space = { identity: { signingPub: kp.publicKey } };
  assert.equal(resolvePlaceholders('{pub}', { space }), QuCrypto.toBase64Url(kp.publicKey));
});

test('resolvePlaceholders(): an UNKNOWN placeholder (neither a submitted field nor in AMBIENT_PLACEHOLDERS) throws loudly, never leaves the literal token in place', () => {
  const space = { identity: { signingPub: new Uint8Array(32) } };
  assert.throws(() => resolvePlaceholders('/post/{nonsense}', { space }), /unknown placeholder.*nonsense/);
});

test('AMBIENT_PLACEHOLDERS: exactly the four documented keys, each a function', () => {
  assert.deepEqual(Object.keys(AMBIENT_PLACEHOLDERS).sort(), ['dd', 'mm', 'pub', 'yyyy']);
  for (const fn of Object.values(AMBIENT_PLACEHOLDERS)) assert.equal(typeof fn, 'function');
});

test('ROUTE_SCHEMES: every scheme ends in {slug}, "flat" adds no date segment at all', () => {
  assert.equal(ROUTE_SCHEMES.flat, '{slug}');
  assert.equal(ROUTE_SCHEMES.yyyy, '{yyyy}/{slug}');
  assert.equal(ROUTE_SCHEMES['yyyy/mm'], '{yyyy}/{mm}/{slug}');
  assert.equal(ROUTE_SCHEMES['yyyy/mm/dd'], '{yyyy}/{mm}/{dd}/{slug}');
  for (const scheme of Object.values(ROUTE_SCHEMES)) assert.ok(scheme.endsWith('{slug}'));
});
