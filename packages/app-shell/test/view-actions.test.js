/**
 * VIEW RENDERING — `view-actions.js`'s `wireViews()` (wired into
 * `boot.js`'s `startApp()`), proven end to end through a REAL (in-process)
 * relay and REAL DOM (jsdom): a page whose own content simply declares
 * `<div data-qu-view="feed">` gets that element populated from a
 * `viewKind` combining a `'pages'` source and a `'shared-list'` source -
 * and, since `openLiveView()` stays open, updates LIVE when either source
 * changes, with no reload and no re-navigation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createAppResolveKindSchema, createPage, publishRoute, createView, pushToSharedList } from '@qu/app-core';
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

test('a page declaring <div data-qu-view="name"> gets it populated from a live, multi-source View, updating without reload', async () => {
  const admin = await actor();
  const guest = await actor();
  const members = [
    { pub: admin.signingPub, xPub: admin.xPublicKey },
    { pub: guest.signingPub, xPub: guest.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub, sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminBootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createPage(adminBootstrapSpace, {
    route: '/',
    title: 'Start',
    content: '<h1>Willkommen</h1><div data-qu-view="feed"></div>',
  });
  await publishRoute(adminBootstrapSpace, { route: '/blog/hallo', title: 'Hallo Welt' });
  await pushToSharedList(adminBootstrapSpace, 'guestbook', { name: 'Alice', message: 'Erster Eintrag' });
  await createView(adminBootstrapSpace, {
    name: 'feed',
    sources: [{ type: 'pages', prefix: '/blog/' }, { type: 'shared-list', name: 'guestbook' }],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<a data-qu-view-link><qu-slot name="title"></qu-slot></a>',
  });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const visitorSpace = await connect(guest, 'visitor');
  startApp({ space: visitorSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('[data-qu-view="feed"] a'));
  let links = [...mountEl.querySelectorAll('[data-qu-view="feed"] a')];
  assert.deepEqual(
    links.map((a) => a.textContent),
    ['Alice', 'Hallo Welt'],
    'both sources are merged and rendered through the item template, sorted by title'
  );
  assert.equal(links.find((a) => a.textContent === 'Hallo Welt').getAttribute('href'), '#/blog/hallo', 'a page item\'s route is wired onto [data-qu-view-link], not left as a dead link');

  // --- LIVE: a new guestbook entry from a DIFFERENT identity updates the rendered DOM with no reload. ---
  await pushToSharedList(visitorSpace, 'guestbook', { name: 'Bob', message: 'Auch da' });
  await waitUntil(() => mountEl.querySelectorAll('[data-qu-view="feed"] a').length === 3);
  links = [...mountEl.querySelectorAll('[data-qu-view="feed"] a')];
  assert.deepEqual(links.map((a) => a.textContent).sort(), ['Alice', 'Bob', 'Hallo Welt'].sort());
});
