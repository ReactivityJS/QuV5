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
  const noteKind = defineKind('note', { fields: { title: { shape: 'atomic' } } });

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
  const kind = defineKind('note', { fields: { body: { shape: 'text' } } });
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
  const kind = defineKind('note', { fields: { body: { shape: 'text' } } });
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

test('richtext field: .yxml is a direct, pre-created Y.XmlFragment handle - bind ProseMirror/y-prosemirror straight to it', async () => {
  const kind = defineKind('doc', { fields: { body: { shape: 'richtext' } } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'r1', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  assert.ok(node.field('body').yxml instanceof Y.XmlFragment);
  // Pre-created at Node-creation time (node.js's stampMeta()) - the SAME Y.XmlFragment INSTANCE
  // every call returns, not a fresh one each time (would silently orphan any prior edits).
  assert.equal(node.field('body').yxml, node.field('body').yxml);
});

test('richtext field: concurrent structural edits from two peers (via raw Yjs XML ops) converge to the same document', async () => {
  const kind = defineKind('doc', { fields: { body: { shape: 'richtext' } } });
  const author = await actor();

  const docA = createDoc(kind, author.signingPub);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  mirror(docA, docB);
  mirror(docB, docA);

  const nodeA = new SpaceNode({ id: 'r2', kindSchema: kind, doc: docA, identity: author, recipientXPubKeys: () => [] });
  const nodeB = new SpaceNode({ id: 'r2', kindSchema: kind, doc: docB, identity: author, recipientXPubKeys: () => [] });

  // Raw Yjs XML ops here (not through a ProseMirror binding - see @qu/space-editor-prosemirror's
  // own tests for that layer) - proves the underlying CRDT convergence this field's whole point is,
  // independent of whatever editor eventually sits on top of it.
  docA.transact(() => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Hello')]);
    nodeA.field('body').yxml.insert(0, [p]);
  });
  docB.transact(() => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Bonjour')]);
    nodeB.field('body').yxml.insert(0, [p]);
  });

  assert.equal(nodeA.field('body').yxml.toString(), nodeB.field('body').yxml.toString());
  assert.ok(nodeA.field('body').yxml.toString().includes('Hello'));
  assert.ok(nodeA.field('body').yxml.toString().includes('Bonjour'));
});

test('richtext field: get() returns a plain-text snapshot with every tag stripped', async () => {
  const kind = defineKind('doc', { fields: { body: { shape: 'richtext' } } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'r3', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  assert.equal(node.field('body').get(), '', 'empty fragment - empty snapshot, not an error');

  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Hallo Welt')]);
    node.field('body').yxml.insert(0, [p]);
  });
  assert.equal(node.field('body').get(), 'Hallo Welt');
});

test('richtext field: observe() fires on a structural change, with Yjs\' own delta', async () => {
  const kind = defineKind('doc', { fields: { body: { shape: 'richtext' } } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'r4', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  let fired = 0;
  node.field('body').observe(() => fired++);
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    node.field('body').yxml.insert(0, [p]);
  });
  assert.equal(fired, 1);
});

test('list field: concurrent pushes from two peers converge on the same, deterministically-ordered array - no cursor/pagination logic needed', async () => {
  const kind = defineKind('channel', { fields: { messages: { shape: 'list' } } });
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

test('list field: remove() deletes exactly the entry at the given index, shifting the rest', async () => {
  const kind = defineKind('registry', { fields: { names: { shape: 'list' } } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'reg1', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await node.field('names').push('a');
  await node.field('names').push('b');
  await node.field('names').push('c');

  node.field('names').remove(1, 1); // removes 'b'.

  assert.deepEqual(await node.field('names').toArray(), ['a', 'c']);
});

test('list field: slice() reads a window in the SAME order toArray() returns, negative indices count from the end (Array.prototype.slice semantics)', async () => {
  const kind = defineKind('archive', { fields: { entries: { shape: 'list' } } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'arc1', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  for (let i = 0; i < 10; i++) await node.field('entries').push(`item-${i}`);

  assert.deepEqual(await node.field('entries').slice(0, 3), ['item-0', 'item-1', 'item-2']);
  assert.deepEqual(await node.field('entries').slice(-3), ['item-7', 'item-8', 'item-9'], 'the most recently pushed N, via a negative start index');
  assert.deepEqual(await node.field('entries').slice(), await node.field('entries').toArray(), 'no args reads the whole list, same as toArray()');
});

test('list field: slice() on an \'encrypted\'-visibility list decrypts only the requested window, and every recipient sees the same plaintext window', async () => {
  const kind = defineKind('inbox', { fields: { messages: { shape: 'list' } } }); // default visibility: 'encrypted'.
  const author = await actor();
  const reader = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'inbox1', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [reader.xPublicKey] });

  for (let i = 0; i < 5; i++) await node.field('messages').push(`secret-${i}`);

  const readerNode = new SpaceNode({ id: 'inbox1', kindSchema: kind, doc, identity: reader, recipientXPubKeys: () => [] });
  assert.deepEqual(await readerNode.field('messages').slice(-2), ['secret-3', 'secret-4']);
  // The raw Yjs value is never the plaintext, regardless of window size - same guarantee toArray() already
  // has. A 'list' field's own Y.Array lives at the TOP LEVEL of the doc (doc.getArray(name)), not inside
  // the 'content' Y.Map atomic/text fields use (field.js's own createField() doc comment).
  assert.equal(JSON.stringify(doc.getArray('messages').toArray()).includes('secret-'), false);
});

test('list field: a concurrent remove() and push() from two peers both survive - CRDT-merged, not last-write-wins over the whole array', async () => {
  const kind = defineKind('registry', { fields: { names: { shape: 'list' } } });
  const author = await actor();

  const docA = createDoc(kind, author.signingPub);
  const docB = new Y.Doc();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  const nodeA = new SpaceNode({ id: 'reg2', kindSchema: kind, doc: docA, identity: author, recipientXPubKeys: () => [] });
  const nodeB = new SpaceNode({ id: 'reg2', kindSchema: kind, doc: docB, identity: author, recipientXPubKeys: () => [] });

  await nodeA.field('names').push('a');
  await nodeA.field('names').push('b');
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));

  // Peer A removes 'a' (index 0) while peer B, at the SAME time and unaware of A's removal, pushes 'c' -
  // a naive "whole array is one last-write-wins value" field would let one of these clobber the other.
  nodeA.field('names').remove(0, 1);
  await nodeB.field('names').push('c');

  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

  const listA = await nodeA.field('names').toArray();
  const listB = await nodeB.field('names').toArray();
  assert.deepEqual(listA, listB); // converge.
  assert.deepEqual(listA, ['b', 'c']); // BOTH the removal and the concurrent push took effect.
});

test('a notify hint declared in the Kind-Schema is accepted and rides as the Yjs transaction origin', async () => {
  const kind = defineKind('channel', { fields: { messages: { shape: 'list' } }, notifyTopics: ['message', 'mention'] });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'ch2', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  let capturedOrigin = null;
  doc.on('update', (_update, origin) => {
    capturedOrigin = origin;
  });
  await node.field('messages').push('hi', { notify: { topic: 'mention', to: ['somePub'] } });

  assert.deepEqual(capturedOrigin, { notify: { topic: 'mention', to: ['somePub'] }, visibility: 'encrypted', recipients: undefined });
});

test('a notify hint whose topic is NOT declared in the Kind-Schema throws, before touching Yjs at all', async () => {
  const kind = defineKind('channel', { fields: { messages: { shape: 'list' } }, notifyTopics: ['message'] });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'ch3', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await assert.rejects(
    () => node.field('messages').push('hi', { notify: { topic: 'mention' } }),
    /notify\.topic "mention" is not declared/
  );
  // The rejected write must not have reached the CRDT - length still 0.
  assert.equal(node.field('messages').length, 0);
});

test('a Kind-Schema with no declared notifyTopics rejects ANY notify hint (opt-in, not silently ignored)', async () => {
  const kind = defineKind('channel', { fields: { messages: { shape: 'list' } } }); // notifyTopics omitted - defaults to []
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'ch4', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await assert.rejects(() => node.field('messages').push('hi', { notify: { topic: 'anything' } }), /not declared/);
});

test('omitting notify entirely still works exactly as before - no {notify} option required', async () => {
  const kind = defineKind('channel', { fields: { messages: { shape: 'list' } } });
  const author = await actor();
  const doc = createDoc(kind, author.signingPub);
  const node = new SpaceNode({ id: 'ch5', kindSchema: kind, doc, identity: author, recipientXPubKeys: () => [] });

  await node.field('messages').push('hi'); // no options arg at all
  assert.equal(node.field('messages').length, 1);
});
