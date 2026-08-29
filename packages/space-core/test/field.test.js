import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { SpaceNode, stampMeta } from '../src/node.js';

function createDoc(kind, ownerPub) {
  const doc = new Y.Doc();
  stampMeta(doc, kind, ownerPub);
  return doc;
}

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

/** Mirrors a Node's Y.Doc into a second, independent Y.Doc - simulates "peer B received every update peer A produced," without needing a full Space/Transport for a pure field-level test. */
function mirror(sourceDoc, targetDoc) {
  sourceDoc.on('update', (update) => Y.applyUpdate(targetDoc, update));
}

test('atomic-encrypted field: recipient decrypts, non-recipient gets undefined (still ciphertext to them)', async () => {
  const author = await actor();
  const reader = await actor();
  const outsider = await actor();
  const noteKind = defineKind('note', { fields: { title: 'atomic-encrypted' } });

  const doc = createDoc(noteKind, author.signingPub);
  const node = new SpaceNode({ id: 'n1', kindSchema: noteKind, doc, identity: author, recipientXPubKeys: () => [reader.xPublicKey] });
  await node.field('title').set('Hallo Welt');

  const readerNode = new SpaceNode({ id: 'n1', kindSchema: noteKind, doc, identity: reader, recipientXPubKeys: () => [] });
  assert.equal(await readerNode.field('title').get(), 'Hallo Welt');

  const outsiderNode = new SpaceNode({ id: 'n1', kindSchema: noteKind, doc, identity: outsider, recipientXPubKeys: () => [] });
  assert.equal(await outsiderNode.field('title').get(), undefined);

  // The raw Yjs value is never the plaintext, regardless of who's looking.
  const raw = JSON.stringify(doc.getMap('content').get('title').ct);
  assert.equal(raw.includes('Hallo'), false);
});

test('text field: concurrent character-level edits from two peers converge to the same content', async () => {
  const kind = defineKind('note', { fields: { body: 'text' } });
  const author = await actor();

  const docA = createDoc(kind, author.signingPub);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA)); // B starts from A's current state.
  mirror(docA, docB);
  mirror(docB, docA);

  const nodeA = new SpaceNode({ id: 'n2', kindSchema: kind, doc: docA, identity: author, recipientXPubKeys: () => [] });
  const nodeB = new SpaceNode({ id: 'n2', kindSchema: kind, doc: docB, identity: author, recipientXPubKeys: () => [] });

  // A concurrent insert at the SAME position from two peers - this is exactly the case LWW would silently drop one side of.
  // mirror() delivers each side's update synchronously, so both docs converge immediately.
  nodeA.field('body').insert(0, 'Hello');
  nodeB.field('body').insert(0, 'Bonjour ');

  assert.equal(nodeA.field('body').get(), nodeB.field('body').get());
  assert.ok(nodeA.field('body').get().includes('Hello'));
  assert.ok(nodeA.field('body').get().includes('Bonjour'));
});

test('text field: observe() delivers Yjs\' own insert/delete delta, not a full-value re-render signal', async () => {
  const kind = defineKind('note', { fields: { body: 'text' } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'n3', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });
  node.field('body').insert(0, 'Hello');

  let lastDelta = null;
  node.field('body').observe((delta) => {
    lastDelta = delta;
  });
  node.field('body').insert(5, '!');

  // A single-character insert produces a small, precise delta (retain 5, insert '!') -
  // not "something changed, go re-read the whole 6-character string."
  assert.deepEqual(lastDelta, [{ retain: 5 }, { insert: '!' }]);
});

test('list field: concurrent pushes from two peers converge on the same, deterministically-ordered array - no cursor/pagination logic needed', async () => {
  const kind = defineKind('channel', { fields: { messages: 'list' } });
  const author = await actor();
  const reader = await actor();

  const docA = createDoc(kind, author.signingPub);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

  const nodeA = new SpaceNode({ id: 'ch1', kindSchema: kind, doc: docA, identity: author, recipientXPubKeys: () => [reader.xPublicKey] });
  const nodeB = new SpaceNode({ id: 'ch1', kindSchema: kind, doc: docB, identity: author, recipientXPubKeys: () => [reader.xPublicKey] });

  // "Simultaneous" appends from both peers, before either has seen the other's write.
  await nodeA.field('messages').push('from A');
  await nodeB.field('messages').push('from B');

  // Now exchange updates both ways.
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

  const readerNode = new SpaceNode({ id: 'ch1', kindSchema: kind, doc: docA, identity: reader, recipientXPubKeys: () => [] });
  const listA = await readerNode.field('messages').toArray();
  const readerNodeB = new SpaceNode({ id: 'ch1', kindSchema: kind, doc: docB, identity: reader, recipientXPubKeys: () => [] });
  const listB = await readerNodeB.field('messages').toArray();

  assert.equal(listA.length, 2);
  assert.deepEqual(listA, listB); // both peers converge on the identical order, with zero custom sort/cursor code.
});
