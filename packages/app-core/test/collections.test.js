/**
 * COLLECTIONS — `kinds.js`'s `defineCollectionKind()` + `dev.js`'s
 * `createCollectionItem()`/`editCollectionItem()` + `resolver.js`'s
 * `resolveCollectionItems()`/`resolveCollectionItem()`, proven end to end
 * through a REAL (in-process) relay so write-ACL is genuinely enforced -
 * same rigor `cms-dev.test.js` already applies to templates/styles/pages,
 * generalized here to an arbitrary caller-defined item shape (a "blog
 * post": title/author/body) instead of one of the two built-in Kinds.
 * `relay-resolver.js`'s own `collectionRegistryKinds` param is exercised
 * throughout - omitting it is exactly the misclassification risk that
 * file's own doc comment warns about, so every `setupHub()` call here
 * passes it, and one dedicated test proves what happens if you don't.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createCollectionItem, editCollectionItem } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { defineCollectionKind } from '../src/kinds.js';

const blogPosts = defineCollectionKind('qu-blog-post', {
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

async function setupHub(members, { collectionRegistryKinds = [blogPosts.registryKind] } = {}) {
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: members.map((m) => m.pub), collectionRegistryKinds });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  return hub;
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport });
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('createCollectionItem() creates several blog posts, resolveCollectionItems() enumerates them, resolveCollectionItem() reads one back - by an unrelated visitor through a real relay', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }];
  const hub = await setupHub(members);
  const adminSpace = await connect(hub, admin, members, 'admin');

  await createCollectionItem(adminSpace, { ...blogPosts, path: 'hello-world', fields: { title: 'Hello World', author: 'Alice', body: 'First post!' } });
  await createCollectionItem(adminSpace, { ...blogPosts, path: 'second-post', fields: { title: 'Second Post', author: 'Bob', body: 'Another one.' } });

  const visitorSpace = await connect(hub, visitor, members, 'visitor');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });

  const items = await resolver.resolveCollectionItems({ registryKind: blogPosts.registryKind, registryField: blogPosts.registryField });
  assert.deepEqual(
    items.map((i) => i.name).sort(),
    ['hello-world', 'second-post']
  );

  const post = await resolver.resolveCollectionItem('hello-world', { itemKind: blogPosts.itemKind, timeout: 2000 });
  assert.equal(post.title, 'Hello World');
  assert.equal(post.author, 'Alice');
  assert.equal(post.body, 'First post!');
});

test('createCollectionItem() called twice with the same path does not duplicate the registry entry', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = await setupHub(members);
  const space = await connect(hub, admin, members, 'admin');

  await createCollectionItem(space, { ...blogPosts, path: 'hello-world', fields: { title: 'v1', author: 'Alice', body: 'v1 body' } });
  await createCollectionItem(space, { ...blogPosts, path: 'hello-world', fields: { title: 'v2', author: 'Alice', body: 'v2 body' } });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  const items = await resolver.resolveCollectionItems({ registryKind: blogPosts.registryKind, registryField: blogPosts.registryField });
  assert.equal(items.length, 1);
});

test('editCollectionItem() updates an EXISTING item in place - readable by an unrelated visitor through the relay', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }];
  const hub = await setupHub(members);
  const adminSpace = await connect(hub, admin, members, 'admin');

  await createCollectionItem(adminSpace, { ...blogPosts, path: 'hello-world', fields: { title: 'v1', author: 'Alice', body: 'v1 body' } });
  await editCollectionItem(adminSpace, { itemKind: blogPosts.itemKind, path: 'hello-world', fields: { title: 'v2', body: 'v2 body' }, timeout: 2000 });

  const visitorSpace = await connect(hub, visitor, members, 'visitor');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
  const post = await resolver.resolveCollectionItem('hello-world', { itemKind: blogPosts.itemKind, timeout: 2000 });
  assert.equal(post.title, 'v2');
  assert.equal(post.body, 'v2 body');
  assert.equal(post.author, 'Alice'); // untouched field survives a partial edit.
});

test('editCollectionItem() on an item a DIFFERENT, non-granted identity owns is rejected by the relay - real per-owner ACL, not just local trust', async () => {
  const admin = await actor();
  const mallory = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: mallory.signingPub, xPub: mallory.xPublicKey }];
  const hub = await setupHub(members);
  const adminSpace = await connect(hub, admin, members, 'admin');
  await createCollectionItem(adminSpace, { ...blogPosts, path: 'hello-world', fields: { title: 'admin owns this', author: 'Alice', body: 'x' } });

  const mallorySpace = await connect(hub, mallory, members, 'mallory');
  await editCollectionItem(mallorySpace, { itemKind: blogPosts.itemKind, path: 'hello-world', fields: { title: 'hacked by mallory' }, ownerPub: admin.signingPub, timeout: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const resolver = new ContentResolver(adminSpace, { appAdminPub: admin.signingPub });
  const post = await resolver.resolveCollectionItem('hello-world', { itemKind: blogPosts.itemKind, timeout: 2000 });
  assert.equal(post.title, 'admin owns this'); // unchanged.
});

test('WITHOUT collectionRegistryKinds configured on the relay, the registry write is silently rejected - proving relay-resolver.js\'s own documented misclassification risk is real, not just theoretical', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }];
  const hub = await setupHub(members, { collectionRegistryKinds: [] }); // the misconfiguration.
  const adminSpace = await connect(hub, admin, members, 'admin');

  await createCollectionItem(adminSpace, { ...blogPosts, path: 'hello-world', fields: { title: 'x', author: 'Alice', body: 'x' } });
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Checked via a SEPARATE peer, not adminSpace itself - admin's own local Y.Doc already applied
  // its own write optimistically regardless of what the relay does with it (the same local-first
  // property every write in this framework has), so reading it back through adminSpace would prove
  // nothing about whether the RELAY actually accepted it. A genuinely unrelated visitor only ever
  // sees what the relay actually mirrored/forwarded.
  const visitorSpace = await connect(hub, visitor, members, 'visitor');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });

  // The ITEM itself still wrote fine (its Kind shares pageKind's fallback classification) - proving
  // the failure below is specifically the registry's misclassification, not a general write failure.
  const post = await resolver.resolveCollectionItem('hello-world', { itemKind: blogPosts.itemKind, timeout: 2000 });
  assert.equal(post.title, 'x');

  // The REGISTRY write was misclassified as 'content'-ACL (grant-only) instead of its real
  // 'named'-ACL (owner-shortcut) - registerContentName()'s own write, sent without a grant since
  // the CLIENT correctly resolves this Kind, is rejected. A genuinely separate visitor sees an
  // empty collection, even though the item itself exists.
  const items = await resolver.resolveCollectionItems({ registryKind: blogPosts.registryKind, registryField: blogPosts.registryField, timeout: 500 });
  assert.deepEqual(items, []);
});
