/**
 * DELETE PRIMITIVES (Phase 4) — `deleteTemplate()`/`deleteStyle()`/
 * `deletePage()`/`deleteView()` (`dev.js`), built on `@qu/space-core`'s
 * newly-added `ListField.remove()` (previously only `push()` existed - no
 * registry entry could ever be un-registered at all, the structural reason
 * Pages/Templates/Styles/Views had no delete story until now). Each
 * removes the item from its own registry (so `resolveTemplateNames()`/
 * `resolveStyleNames()`/`resolveRoutes()` stop enumerating it) AND
 * best-effort clears its own content - see each function's own doc
 * comment on why this is "cleared and unreachable," not a genuine Node
 * deletion (no such primitive exists in this architecture).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createApp, createTemplate, createStyle, createPage, publishRoute, createView, deleteTemplate, deleteStyle, deletePage, deleteView } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function setupSpace(identity) {
  const hub = createInProcessHub();
  const members = [{ pub: identity.signingPub, xPub: identity.xPublicKey }];
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: identity.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  const transport = new InProcessTransport(hub, 'peer');
  await transport.connect();
  return new Space({ identity, members, transport });
}

test('deleteTemplate() removes the template from resolveTemplateNames() and clears its own html', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createTemplate(space, { name: 'a', html: '<p>a</p>' });
  await createTemplate(space, { name: 'b', html: '<p>b</p>' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  await deleteTemplate(space, { name: 'a', timeout: 2000 });

  const names = await resolver.resolveTemplateNames({ timeout: 1000 });
  assert.deepEqual(names.map((n) => n.name).sort(), ['b']); // "a" is gone, "b" untouched.
  assert.equal(await resolver.resolveTemplate('a', { timeout: 500 }), null); // cleared -> no longer resolves.
  assert.equal(await resolver.resolveTemplate('b', { timeout: 500 }), '<p>b</p>');
});

test('deleteTemplate() throws for a name that was never created', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await assert.rejects(() => deleteTemplate(space, { name: 'nope', timeout: 500 }), /is not registered/);
});

test('deleteStyle() removes the style from resolveStyleNames() and clears its own css', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createStyle(space, { name: 'global', css: 'body{color:navy}' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  await deleteStyle(space, { name: 'global', timeout: 2000 });

  const names = await resolver.resolveStyleNames({ timeout: 1000 });
  assert.deepEqual(names, []);
});

test('deletePage() unpublishes the route and clears the page - resolveRoutes()/resolvePage() both stop finding it', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createPage(space, { route: '/a', title: 'A', content: '<p>a</p>' });
  await publishRoute(space, { route: '/a', title: 'A' });
  await createPage(space, { route: '/b', title: 'B', content: '<p>b</p>' });
  await publishRoute(space, { route: '/b', title: 'B' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  await deletePage(space, { route: '/a', timeout: 2000 });

  const routes = await resolver.resolveRoutes({ timeout: 1000 });
  assert.deepEqual(routes.map((r) => r.route).sort(), ['/b']);
  assert.equal(await resolver.resolvePage('/a', { timeout: 500 }), null);
  assert.equal((await resolver.resolvePage('/b', { timeout: 500 })).title, 'B');
});

test('deletePage() throws for a route that was never published', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await assert.rejects(() => deletePage(space, { route: '/nope', timeout: 500 }), /is not published/);
});

test('deleteView() with a route unpublishes it and clears the view itself, so resolveView() and resolveRoutes() both stop finding it', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createView(space, { name: 'latest', route: '/latest', sources: [{ type: 'pages' }], itemTemplate: '<a>{{title}}</a>' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  assert.ok(await resolver.resolveView('latest', { timeout: 1000 })); // sanity: it really exists first.

  await deleteView(space, { name: 'latest', route: '/latest', timeout: 2000 });

  assert.equal(await resolver.resolveView('latest', { timeout: 500 }), null);
  const routes = await resolver.resolveRoutes({ timeout: 500 });
  assert.equal(routes.some((r) => r.route === '/latest'), false);
});

test('deleteView() without a route (embed-only) just clears the view itself', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createView(space, { name: 'sidebar', sources: [{ type: 'pages' }], itemTemplate: '<a>{{title}}</a>' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  await deleteView(space, { name: 'sidebar', timeout: 2000 });

  assert.equal(await resolver.resolveView('sidebar', { timeout: 500 }), null);
});
