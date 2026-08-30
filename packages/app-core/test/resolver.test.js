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
import { createApp, createTemplate, createStyle, createPage, publishRoute } from '../src/dev.js';
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
