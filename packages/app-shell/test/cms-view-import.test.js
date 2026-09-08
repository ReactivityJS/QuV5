/**
 * VIEW JSON IMPORT (Phase 4) — proves the "View aus JSON übernehmen"
 * textarea/button actually populates the Content form's own fields
 * (WITHOUT saving anything on its own), and that submitting afterward
 * creates the exact multi-source View described by the pasted JSON - the
 * user's own explicit ask: importing a complex, hand-authored/copy-pasted
 * View definition instead of rebuilding it field by field through the
 * simple single-source picker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createAppResolveKindSchema, ContentResolver } from '@qu/app-core';
import { startApp } from '../src/boot.js';
import { installCms } from '../cms-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

function submit(form, window) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('pasting a View JSON and clicking "Übernehmen" fills the form without saving; submitting afterward creates exactly that View', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const bootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createApp(bootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(bootstrapSpace);

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms/content' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit');
  startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-content-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="cms-content-form"]');

  const definition = {
    name: 'combined-feed',
    route: '/feed',
    sources: [
      { type: 'pages', prefix: '/blog/' },
      { type: 'shared-list', name: 'guestbook' },
    ],
    sortBy: 'timestamp',
    sortOrder: 'asc',
    limit: 5,
    itemTemplate: '<a data-qu-view-link><span data-qu-slot="title"></span></a>',
  };
  mountEl.querySelector('[data-qu-view-import]').value = JSON.stringify(definition);
  mountEl.querySelector('[data-qu-action="cms-content-import-view"]').click();

  assert.equal(mountEl.querySelector('[name="name"]').value, 'combined-feed');
  assert.equal(mountEl.querySelector('[name="route"]').value, '/feed');
  assert.deepEqual(JSON.parse(mountEl.querySelector('[name="sourcesOverride"]').value), definition.sources);
  assert.equal(mountEl.querySelector('[name="sortBy"]').value, 'timestamp');
  assert.equal(mountEl.querySelector('[name="sortOrder"]').value, 'asc');
  assert.equal(mountEl.querySelector('[name="limit"]').value, '5');
  assert.equal(mountEl.querySelector('[name="itemTemplate"]').value, definition.itemTemplate);
  // Nothing saved yet - the whole point of "import into the form, don't auto-submit."
  assert.equal(/Gespeichert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), false);

  submit(form, window);
  await waitUntil(() => /Gespeichert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));

  const resolver = new ContentResolver(adminSpace, { appAdminPub: admin.signingPub });
  const view = await resolver.resolveView('combined-feed', { timeout: 2000 });
  assert.deepEqual(view.sources, definition.sources);
  assert.equal(view.sortBy, 'timestamp');
  assert.equal(view.sortOrder, 'asc');
  assert.equal(view.limit, 5);
  assert.equal(view.itemTemplate, definition.itemTemplate);
});

test('an invalid JSON import shows an error and never touches the form', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  const transport = new InProcessTransport(hub, 'admin');
  await transport.connect();
  const space = new Space({ identity: admin, members, transport });
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(space);

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms/content' });
  const mountEl = window.document.querySelector('qu-app-shell');
  startApp({ space, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-content-form"]'));

  mountEl.querySelector('[data-qu-view-import]').value = '{not valid json';
  mountEl.querySelector('[data-qu-action="cms-content-import-view"]').click();

  assert.match(mountEl.querySelector('[data-qu-view-import-status]').textContent, /Kein gültiges JSON/);
  assert.equal(mountEl.querySelector('[name="name"]').value, '');
});
