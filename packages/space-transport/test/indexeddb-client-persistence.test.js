/**
 * CLIENT-SIDE INDEXEDDB PERSISTENCE — proves the actual scenario
 * `@qu/space-storage`'s `indexeddb-store.js` exists for: a BROWSER CLIENT
 * (not the relay) reconstructing a Node it already saw once, entirely from
 * its own local storage, with NO transport/relay connection at all - the
 * "instant local hydrate, resync happens in the background" behavior
 * `Space.useNode()`'s own doc comment already promises once ANY storage
 * adapter is configured (`poc-demo.test.js`'s own `createDurableStore()`-
 * based reload test proves the identical Space-level contract; this file
 * proves the SAME contract against the specific adapter a real browser
 * deployment (`@qu/app-shell`'s `shell.js`) actually wires in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createIndexedDbStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport } from '../src/index.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const noteKind = defineKind('note', { fields: { title: { shape: 'atomic' }, body: { shape: 'text' } } });

test('a "page reload" (fresh Space, same IndexedDB, NO transport connected) reconstructs a Node from local storage alone', async () => {
  const visitor = await actor();
  const members = [{ pub: visitor.signingPub, xPub: visitor.xPublicKey }];
  const hub = createInProcessHub();
  const dbName = 'qu-space-storage-client-test';

  const firstVisitStorage = createIndexedDbStore({ dbName });
  const transport = new InProcessTransport(hub, 'visitor');
  await transport.connect();
  const firstVisitSpace = new Space({ identity: visitor, members, transport, storage: firstVisitStorage });

  const note = await firstVisitSpace.createNode(noteKind, { title: 'Erste Sitzung' }, { id: 'my-note' });
  note.field('body').insert(0, 'Lokal gespeichert.');
  await waitUntil(() => note.field('body').get() === 'Lokal gespeichert.');
  // Let the local write actually reach the IndexedDB adapter (Space's own doc.on('update', ...)
  // handler persists fire-and-forget, same reasoning poc-demo.test.js's own top doc comment gives
  // for why every hop in this whole framework is awaited via an observable effect, never a fixed tick).
  await waitUntil(async () => (await firstVisitStorage.load('my-note')).length >= 2); // meta+title envelope, body envelope

  // A "page reload" - a BRAND NEW Space/transport, deliberately never connected (proves this is
  // storage alone doing the work, not a lucky fast relay round trip) - only `storage` carries over,
  // pointed at the SAME IndexedDB database name a real returning visitor's browser would still have.
  const secondVisitStorage = createIndexedDbStore({ dbName });
  const secondVisitSpace = new Space({ identity: visitor, members, transport: new InProcessTransport(createInProcessHub(), 'visitor-reloaded'), storage: secondVisitStorage });

  const reloadedNote = await secondVisitSpace.loadNode('my-note', noteKind);
  assert.equal(await reloadedNote.field('title').get(), 'Erste Sitzung');
  assert.equal(reloadedNote.field('body').get(), 'Lokal gespeichert.');
});
