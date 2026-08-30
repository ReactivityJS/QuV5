/**
 * BOOT — the Phase-1 acceptance scenario itself (docs/
 * app-shell-arbeitsauftrag.md §32/§33), assembled from real packages: an
 * "app-admin" Space publishes a Manifest + Template + Style + Page through
 * a real (in-process) relay; `startApp()` (this package's own `boot.js`)
 * wires a SEPARATE "visitor" Space to `@qu/app-core`'s `AppRuntime`/
 * `HashRouter` and `@qu/app-renderer`'s `renderPage()` against a jsdom
 * `window`/mount element; navigating the hash actually mounts the
 * Space-sourced template+content+style into the DOM. No real WebSocket/
 * relay process needed - `WsClientTransport`/`shell.js`'s browser glue is
 * exercised by actually running a browser, not by this test (see
 * identity.test.js for the one piece of `shell.js`'s own logic - `join` -
 * that IS unit-testable without a DOM).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createTemplate, createStyle, createPage, publishRoute, createAppResolveKindSchema } from '@qu/app-core';
import { startApp } from '../src/boot.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('startApp() loads an app-admin\'s manifest/template/style/pages from the Space and renders them on route change - the empty-shell-to-working-app PoC', async () => {
  const appAdmin = await actor();
  const visitor = await actor();
  const members = [
    { pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: appAdmin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'app-admin');
  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await adminTransport.connect();
  await visitorTransport.connect();

  const adminSpace = new Space({ identity: appAdmin, members, transport: adminTransport });
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport });

  await createApp(adminSpace, { name: 'Qu Demo', rootTemplate: 'layout/main', defaultRoute: '/', theme: 'global' });
  await createTemplate(adminSpace, {
    name: 'layout/main',
    html: '<header>Qu Demo</header><main><qu-slot name="content"></qu-slot></main>',
  });
  await createStyle(adminSpace, { name: 'global', css: 'body { font-family: sans-serif; }' });
  await createPage(adminSpace, { route: '/', title: 'Start', template: 'layout/main', content: '<p>Willkommen</p>' });
  await createPage(adminSpace, { route: '/hello', title: 'Hallo', template: 'layout/main', content: '<p>Hallo aus dem Space!</p>' });
  await publishRoute(adminSpace, { route: '/', title: 'Start' });
  await publishRoute(adminSpace, { route: '/hello', title: 'Hallo' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/' });
  const mountEl = window.document.querySelector('qu-app-shell');

  const { router } = startApp({ space: visitorSpace, appAdminPub: appAdmin.signingPub, mountEl, window, resolveTimeout: 300 });

  await waitUntil(() => mountEl.innerHTML.includes('Willkommen'));
  assert.equal(window.document.title, 'Start');
  assert.ok(mountEl.innerHTML.includes('<header>Qu Demo</header>'));
  assert.equal(window.document.head.querySelector('style[data-qu-style="qu-app-theme"]').textContent, 'body { font-family: sans-serif; }');

  router.navigate('/hello');
  await waitUntil(() => mountEl.innerHTML.includes('Hallo aus dem Space!'));
  assert.equal(window.document.title, 'Hallo');

  router.navigate('/does-not-exist');
  await waitUntil(() => mountEl.innerHTML.includes('404'));

  router.stop();
});
