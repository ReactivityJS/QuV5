/**
 * `setFieldValue()` — proves the "replace the whole value, regardless of
 * shape" helper (`field.js`'s own top-of-function doc comment) actually
 * routes to the right underlying write for BOTH an 'atomic' field (its own
 * `set()`) and a 'text' field (no `set()` at all - delete-then-insert),
 * and that repeated calls on a 'text' field never accumulate stale
 * characters (the exact bug a naive "just insert the new value" without
 * first deleting the old one would produce).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { SpaceNode, stampMeta } from '../src/node.js';
import { setFieldValue } from '../src/field.js';

function createDoc(kind, ownerPub) {
  const doc = new Y.Doc();
  stampMeta(doc, kind, ownerPub);
  return doc;
}

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

test('setFieldValue() on an atomic field routes through set()', async () => {
  const author = await actor();
  const kind = defineKind('note', { fields: { title: { shape: 'atomic' } } });
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'n1', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await setFieldValue(node.field('title'), 'Erster Titel');
  assert.equal(await node.field('title').get(), 'Erster Titel');

  await setFieldValue(node.field('title'), 'Zweiter Titel');
  assert.equal(await node.field('title').get(), 'Zweiter Titel');
});

test('setFieldValue() on a text field replaces the whole content (delete-then-insert), never accumulates stale characters across repeated calls', async () => {
  const author = await actor();
  const kind = defineKind('post', { fields: { body: { shape: 'text' } } });
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'n2', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await setFieldValue(node.field('body'), 'Erster Inhalt, recht lang.');
  assert.equal(node.field('body').get(), 'Erster Inhalt, recht lang.');

  // A SHORTER replacement - if this only inserted without deleting the old (longer) content first,
  // stale trailing characters from the first call would still be there.
  await setFieldValue(node.field('body'), 'Kurz.');
  assert.equal(node.field('body').get(), 'Kurz.');

  await setFieldValue(node.field('body'), '');
  assert.equal(node.field('body').get(), '');
});

test('setFieldValue() on a text field that starts empty (never written) just inserts, no error from an empty delete', async () => {
  const author = await actor();
  const kind = defineKind('post', { fields: { body: { shape: 'text' } } });
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'n3', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await setFieldValue(node.field('body'), 'Ganz neu.');
  assert.equal(node.field('body').get(), 'Ganz neu.');
});
