/**
 * VIEW 'collection' SOURCE — `view-sources.js`'s own doc comment for the
 * full design. Proves, over a REAL (in-process) relay:
 *   1. A View sourcing a Collection (`kinds.js`'s `defineCollectionKind()`)
 *      normalizes each item via the adapter's `titleField`/`excerptField`
 *      params, with the item's full field set still available via `raw`.
 *   2. LIVE at the REGISTRY level: a brand-new item created after the View
 *      was opened appears with no re-open (same as `'pages'`/`'shared-list'`).
 *   3. LIVE at the ITEM level too (the two-level liveness `'pages'`/
 *      `'shared-list'` don't need, since they only ever watch ONE Node):
 *      editing an EXISTING item's own field, with no registry change at
 *      all, also triggers a live recompute.
 *   4. A source config missing `itemKind`/`registryKind` fails loudly, not
 *      silently misreading `undefined` fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createCollectionItem, editCollectionItem, createView } from '../src/dev.js';
import { ContentResolver } from '../src/resolver.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { defineCollectionKind } from '../src/kinds.js';
import { openLiveView } from '../src/view-sources.js';

const blogPosts = defineCollectionKind('qu-view-collection-test-post', {
  fields: {
    title: { shape: 'atomic', visibility: 'public' },
    author: { shape: 'atomic', visibility: 'public' },
    body: { shape: 'text', visibility: 'public' },
  },
});

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport });
}

/** @param {() => boolean|Promise<boolean>} fn - MAY be async, unlike views.test.js's own otherwise-identical helper - some of this file's own checks poll toArray() itself, not just a plain sync flag. */
async function waitForCondition(fn, { timeout = 2000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitForCondition: timed out');
}

test("a View sourcing a Collection normalizes items via titleField/excerptField, full data still in raw", async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: [admin.signingPub], collectionRegistryKinds: [blogPosts.registryKind] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminSpace = await connect(hub, admin, members, 'admin');
  await createCollectionItem(adminSpace, { ...blogPosts, path: 'hello-world', fields: { title: 'Hello World', author: 'Alice', body: 'First post!' } });
  await createCollectionItem(adminSpace, { ...blogPosts, path: 'second-post', fields: { title: 'Second Post', author: 'Bob', body: 'Another one.' } });

  await createView(adminSpace, {
    name: 'blog-feed',
    sources: [{ type: 'collection', itemKind: blogPosts.itemKind, registryKind: blogPosts.registryKind, titleField: 'title', excerptField: 'body' }],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<div><qu-slot name="title"></qu-slot></div>',
  });

  const readerSpace = await connect(hub, admin, members, 'reader');
  const resolver = new ContentResolver(readerSpace, { appAdminPub: admin.signingPub });
  const config = await resolver.resolveView('blog-feed', { timeout: 2000 });

  const view = await openLiveView(readerSpace, { appAdminPub: admin.signingPub, ...config });
  try {
    const items = await view.toArray();
    assert.deepEqual(items.map((i) => i.title), ['Hello World', 'Second Post']);
    const helloItem = items.find((i) => i.title === 'Hello World');
    assert.equal(helloItem.excerpt, 'First post!');
    assert.equal(helloItem.raw.author, 'Alice', "an item's full field set (not just the mapped ones) is available via raw");
    assert.equal(helloItem.raw.path, 'hello-world');
  } finally {
    view.close();
  }
});

test("a View sourcing a Collection is LIVE at both the registry level (new item) and the item level (existing item edited)", async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: [admin.signingPub], collectionRegistryKinds: [blogPosts.registryKind] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminSpace = await connect(hub, admin, members, 'admin');
  await createCollectionItem(adminSpace, { ...blogPosts, path: 'first', fields: { title: 'First', author: 'Alice', body: 'Original body' } });

  await createView(adminSpace, {
    name: 'live-blog-feed',
    sources: [{ type: 'collection', itemKind: blogPosts.itemKind, registryKind: blogPosts.registryKind, titleField: 'title', excerptField: 'body' }],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<div><qu-slot name="title"></qu-slot></div>',
  });

  const readerSpace = await connect(hub, admin, members, 'reader');
  const resolver = new ContentResolver(readerSpace, { appAdminPub: admin.signingPub });
  const config = await resolver.resolveView('live-blog-feed', { timeout: 2000 });
  const view = await openLiveView(readerSpace, { appAdminPub: admin.signingPub, ...config });
  try {
    let items = await view.toArray();
    assert.deepEqual(items.map((i) => i.title), ['First']);

    // --- LIVE at the registry level: a brand-new item appears with no re-open. ---
    let notified = false;
    let unobserve = view.observe(() => (notified = true));
    await createCollectionItem(adminSpace, { ...blogPosts, path: 'second', fields: { title: 'Second', author: 'Bob', body: 'Another body' } });
    await waitForCondition(() => notified, { timeout: 2000 });
    items = await view.toArray();
    assert.deepEqual(items.map((i) => i.title), ['First', 'Second'], 'a new Collection item created after the View was opened appears live');
    unobserve();

    // --- LIVE at the item level: editing an EXISTING item's field (no registry change at all)
    // also triggers a recompute - the two-level liveness this adapter specifically adds. ---
    await editCollectionItem(adminSpace, { ...blogPosts, path: 'first', fields: { body: 'Updated body' } });
    // Polls the actual end state, not a one-shot "was I notified" flag - openLiveView()'s
    // recompute() is fire-and-forget from an adapter's own onUpdate (never awaited), so more than
    // one recompute can legitimately be in flight at once; a boolean notified flag can flip true
    // from a DIFFERENT (earlier, still-settling) recompute than the one that actually carries this
    // edit's own result - the real assertion is "does toArray() EVENTUALLY reflect the edit".
    await waitForCondition(async () => (await view.toArray()).find((i) => i.title === 'First')?.excerpt === 'Updated body', { timeout: 2000 });
    items = await view.toArray();
    assert.equal(items.find((i) => i.title === 'First').excerpt, 'Updated body', "editing an existing item's own field (no registry change) is reflected live");
  } finally {
    view.close();
  }
});

test("a 'collection' source missing itemKind/registryKind fails loudly", async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: [admin.signingPub] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  const adminSpace = await connect(hub, admin, members, 'admin');

  await assert.rejects(
    () => openLiveView(adminSpace, { appAdminPub: admin.signingPub, sources: [{ type: 'collection' }] }),
    /requires \{ itemKind, registryKind \}/
  );
});
