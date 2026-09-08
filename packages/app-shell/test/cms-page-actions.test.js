/**
 * CMS PAGE ACTIONS — proves `cms-actions.js`'s new `cms.pageActions`
 * extension point end to end: a "plugin" (here, the test itself, standing
 * in for e.g. a future Blog `blog-actions.js` contribution) registers on
 * `@qu/app-shell`'s own SHARED `extensionPoints` host
 * (`src/extension-points.js`) BEFORE the CMS Content section renders, and
 * its extra per-page button shows up in the rendered `<li>`, is clickable,
 * and runs the contributed `onClick` - all without `cms-actions.js`
 * importing this test/plugin, or knowing it exists. Mirrors
 * `cms-actions.test.js`'s own "real relay, real DOM" rigor, scoped to just
 * this one new integration point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createAppResolveKindSchema, createPage, publishRoute } from '@qu/app-core';
import { startApp } from '../src/boot.js';
import { installCms } from '../cms-bundle.js';
import { extensionPoints, _clearExtensionPointForTest } from '../src/extension-points.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('a plugin contributing to "cms.pageActions" gets an extra button on every Content list row, without cms-actions.js knowing it exists', async (t) => {
  t.after(() => _clearExtensionPointForTest('cms.pageActions'));

  const admin = await actor();
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members: [{ pub: admin.signingPub, xPub: admin.xPublicKey }], resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members: [{ pub: admin.signingPub, xPub: admin.xPublicKey }], transport });
  }

  const bootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createApp(bootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(bootstrapSpace);
  await createPage(bootstrapSpace, { route: '/hello', title: 'Hello' });
  await publishRoute(bootstrapSpace, { route: '/hello', title: 'Hello' });

  // The "plugin": offers exactly one extra action, on every page, tracking whether it was actually clicked.
  let clicked = null;
  extensionPoints.contribute('cms.pageActions', {
    id: 'duplicate',
    appId: 'test-plugin',
    handler: ({ route }) => ({ id: 'duplicate', label: 'Duplizieren', onClick: () => { clicked = route; } }),
  });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms/content' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit');
  startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] button')].some((b) => b.textContent === '/hello'));

  const actionBtn = mountEl.querySelector('[data-qu-bind="cms-content-list"] button[data-qu-page-action="duplicate"]');
  assert.ok(actionBtn, 'the plugin-contributed action button should be rendered next to the page entry');
  assert.equal(actionBtn.textContent, 'Duplizieren');

  actionBtn.click();
  assert.equal(clicked, '/hello', 'clicking the contributed button should run the plugin\'s own onClick with this row\'s route');
});

test('with no contributor registered, the Content list renders exactly as before (no extra buttons, correct no-op)', async () => {
  const admin = await actor();
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members: [{ pub: admin.signingPub, xPub: admin.xPublicKey }], resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members: [{ pub: admin.signingPub, xPub: admin.xPublicKey }], transport });
  }

  const bootstrapSpace = await connect(admin, 'admin-bootstrap-2');
  await createApp(bootstrapSpace, { name: 'Demo2', rootTemplate: null, defaultRoute: '/' });
  await installCms(bootstrapSpace);
  await createPage(bootstrapSpace, { route: '/solo', title: 'Solo' });
  await publishRoute(bootstrapSpace, { route: '/solo', title: 'Solo' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms/content' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit-2');
  startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] button')].some((b) => b.textContent === '/solo'));

  const row = [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] li')].find((li) => li.textContent.includes('/solo'));
  assert.equal(row.querySelectorAll('button').length, 1, 'no contributor registered -> only the built-in "open in editor" button');
});
