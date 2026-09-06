/**
 * ROUTED VIEWS — `createView()`'s own `route` doc comment: "Views
 * zusammenklickbar wie bei Drupal" (the user's own framing) - a View given
 * a `route` becomes directly visitable, with NO separate page/`<div
 * data-qu-view>` markup ever authored by hand. Proves the auto-created
 * wrapper page actually works end to end: visiting the route renders the
 * live feed, wrapped in the given template, with no manual page/embed step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createAppResolveKindSchema, createTemplate, publishRoute, createView, ContentResolver } from '@qu/app-core';
import { startApp } from '../src/boot.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('createView({route}) auto-creates a wrapper page - visiting the route renders the live feed with no manually-authored page', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub, sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminSpace = await connect(admin, 'admin');
  await createTemplate(adminSpace, { name: 'layout', html: '<header>Meine Seite</header><qu-slot name="content"></qu-slot>' });
  await publishRoute(adminSpace, { route: '/blog/hallo', title: 'Hallo Welt' });

  // The ENTIRE "page" - route, wrapping template, and the feed placeholder - comes from ONE
  // createView() call, no separate createPage() anywhere in this test.
  const viewNode = await createView(adminSpace, {
    name: 'blog-index',
    route: '/blog',
    template: 'layout',
    sources: [{ type: 'pages', prefix: '/blog/' }],
    sortBy: 'title',
    itemTemplate: '<a data-qu-view-link><qu-slot name="title"></qu-slot></a>',
  });
  assert.ok(viewNode, 'createView() itself still returns the View node, unchanged');

  // `resolveView()` reports back where it's mounted - useful for a CMS editor to show "already
  // live at /blog" without separately tracking that itself.
  const resolver = new ContentResolver(adminSpace, { appAdminPub: admin.signingPub });
  const config = await resolver.resolveView('blog-index', { timeout: 2000 });
  assert.equal(config.route, '/blog');
  assert.equal(config.template, 'layout');

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/blog' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const visitorSpace = await connect(admin, 'visitor');
  startApp({ space: visitorSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('[data-qu-view="blog-index"] a'));
  assert.ok(mountEl.querySelector('header'), 'the given template actually wraps the feed - this is a real page, not bare markup');
  assert.equal(mountEl.querySelector('header').textContent, 'Meine Seite');
  assert.equal(mountEl.querySelector('[data-qu-view="blog-index"] a').textContent, 'Hallo Welt');
  assert.equal(mountEl.querySelector('[data-qu-view="blog-index"] a').getAttribute('href'), '#/blog/hallo');
});
