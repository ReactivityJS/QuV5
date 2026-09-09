/**
 * CONTENT RESOLVER — proves resolver.js's read path against content
 * created via dev.js's own write path, all within ONE Space (author =
 * reader): `useNode()` finds an already-attached Node instantly (see
 * space.js's own doc comment), so this needs no relay/network at all -
 * see end-to-end.test.js for the real, two-peer "an unrelated visitor
 * reads an app-admin's content through a relay" scenario.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createApp, createTemplate, createStyle, createPage, editPage, publishRoute } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

/** One Space, wired through a real (in-process) relay so write ACL is genuinely enforced, not just locally trusted. */
async function setupSpace(identity) {
  const hub = createInProcessHub();
  const members = [{ pub: identity.signingPub, xPub: identity.xPublicKey }];
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: identity.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  const transport = new InProcessTransport(hub, 'peer');
  await transport.connect();
  return new Space({ identity, members, transport });
}

test('resolveManifest() returns a published App Manifest', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Hello App', rootTemplate: 'layout/main', theme: 'global' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  const manifest = await resolver.resolveManifest();
  assert.equal(manifest.name, 'Hello App');
  assert.equal(manifest.rootTemplate, 'layout/main');
  assert.equal(manifest.theme, 'global');
});

test('resolveManifest() returns null when nothing has been published (within the timeout)', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolveManifest({ timeout: 50 }), null);
});

test('resolveTemplate()/resolveStyle() return published HTML/CSS by name', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createTemplate(space, { name: 'layout/main', html: '<main><qu-slot name="content"></qu-slot></main>' });
  await createStyle(space, { name: 'global', css: 'body { margin: 0; }' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolveTemplate('layout/main'), '<main><qu-slot name="content"></qu-slot></main>');
  assert.equal(await resolver.resolveStyle('global'), 'body { margin: 0; }');
});

test('resolvePage() returns a published page by route, including its live qu-page.content text', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createPage(space, { route: '/hello', title: 'Hallo', template: 'layout/main', content: '<p>Hallo Qu!</p>' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  const page = await resolver.resolvePage('/hello');
  assert.equal(page.title, 'Hallo');
  assert.equal(page.template, 'layout/main');
  assert.equal(page.content, '<p>Hallo Qu!</p>');
});

test('resolvePage() returns null for an unpublished route (within the timeout) - the router\'s 404 signal', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolvePage('/does-not-exist', { timeout: 50 }), null);
});

test('resolvePage() treats a "draft"-status page as not found, unless includeDrafts is passed - kinds.js\'s pageKind.status own doc comment', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createPage(space, { route: '/draft-post', title: 'Roman-Entwurf', content: '<p>Noch nicht fertig.</p>', status: 'draft' });
  // Deliberately NOT calling publishRoute() - see this Kind's own doc comment: a draft stays
  // unregistered until actually published, same as the app's own "Als Entwurf speichern" UI flow.

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolvePage('/draft-post', { timeout: 200 }), null, 'invisible to ordinary navigation - indistinguishable from never-published');

  const draft = await resolver.resolvePage('/draft-post', { timeout: 2000, includeDrafts: true });
  assert.equal(draft.title, 'Roman-Entwurf', 'the author\'s own "load this draft back into the form" path can still see it');
  assert.equal(draft.status, 'draft');
});

test('editPage({status}) promotes a draft to published; resolvePage() then finds it once publishRoute() is also called', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createPage(space, { route: '/promoted', title: 'Ankündigung', content: '<p>In Arbeit.</p>', status: 'draft' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolvePage('/promoted', { timeout: 200 }), null);

  await editPage(space, { route: '/promoted', status: 'published' });
  await publishRoute(space, { route: '/promoted', title: 'Ankündigung' });

  const page = await resolver.resolvePage('/promoted', { timeout: 2000 });
  assert.equal(page.title, 'Ankündigung');
  assert.equal(page.status, 'published');
  const routes = await resolver.resolveRoutes();
  assert.deepEqual(routes.map((r) => r.route), ['/promoted'], 'exactly one registration - see this test\'s own doc comment on why the caller only calls publishRoute() ONCE, at the draft->published transition');
});

test('editPage({status: "draft"}) reverts an already-published page back to invisible, without touching the route registry', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createPage(space, { route: '/toggle', title: 'Ankündigung', content: '<p>Live.</p>', status: 'published' });
  await publishRoute(space, { route: '/toggle', title: 'Ankündigung' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.equal((await resolver.resolvePage('/toggle', { timeout: 2000 })).title, 'Ankündigung');

  await editPage(space, { route: '/toggle', status: 'draft' });
  assert.equal(await resolver.resolvePage('/toggle', { timeout: 200 }), null, 'reverted to draft - not found again, even though still registered');
  // Still registered (editPage() never touches the registry) - a stale entry until published again,
  // same accepted shape kinds.js's pageKind.status doc comment describes.
  const routes = await resolver.resolveRoutes();
  assert.deepEqual(routes.map((r) => r.route), ['/toggle']);
});

test('resolveRoutes() enumerates every route published to the Route Registry', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await publishRoute(space, { route: '/', title: 'Start' });
  await publishRoute(space, { route: '/hello', title: 'Hallo' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  const routes = await resolver.resolveRoutes();
  assert.deepEqual(
    routes.map((r) => r.route).sort(),
    ['/', '/hello']
  );
});
