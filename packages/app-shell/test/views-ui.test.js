/**
 * THE ADMIN CONSOLE'S "VIEWS/SEITEN (CMS)" BUTTON — proves the full "build a
 * Gästebuch-like app entirely through the UI, no bundle.js at all" workflow
 * `admin-actions.js`'s own doc comment on the button promises:
 *
 *   1. A relay-admin registers a BLANK `realm: 'global'` app (no installer,
 *      no bundle.js - just `registerApp()`).
 *   2. Clicking "Views/Seiten (CMS)" (optionally naming a NEW shared list
 *      first, `dev.js`'s `addSharedLists()` own doc comment on why that step
 *      exists) self-provisions `installGlobalCms()`'s own Template/Page/View
 *      editor for THAT app and navigates to it - the exact same editor
 *      `view-editor.test.js` already proves for a self-owned app, just
 *      reached a different way and writing `qu-admin-*` Kinds instead.
 *   3. The rendered View form (`wireCms()` already wires this generically,
 *      `global: true` and all - nothing new needed there) creates a
 *      shared-list-sourced, ROUTE-bound View - `createGlobalView()`'s own
 *      `route`/`template` params already connect a path to a generated feed.
 *   4. An ORDINARY Space member (never the relay-admin) contributes an
 *      entry and sees it live - proving the resulting app is genuinely
 *      multi-contributor, not just a relay-admin's own content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { installGlobalAppBundle, registerApp, publishGlobalRoute } from '@qu/app-core';
import { createLiveAppResolveKindSchema } from '../src/live-app-resolver.js';
import { startPlatform } from '../src/boot.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 5000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

async function bootRelay({ extraActors = [] } = {}) {
  const relayAdmin = await actor();
  const relayAdmins = [relayAdmin.signingPub];
  const members = [relayAdmin, ...extraActors].map((a) => ({ pub: a.signingPub, xPub: a.xPublicKey }));

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;
  await start({ url, relayAdmins });

  async function connect(identity) {
    const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const adminSpace = await connect(relayAdmin);
  await registerApp(adminSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await publishGlobalRoute(adminSpace, 'admin', { route: '/', title: 'Relay-Admin' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await installGlobalAppBundle(adminSpace, 'admin', adminConsoleBundle);
  await new Promise((resolve) => setTimeout(resolve, 300));

  async function close() {
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { relayAdmin, members, url, connect, close };
}

function mountAdmin(space) {
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router, platform } = startPlatform({ space, mountEl, window, resolveTimeout: 1500 });
  return { window, mountEl, router, platform };
}

test('a relay-admin builds a Gästebuch-like app entirely through the admin console\'s Views/Seiten (CMS) editor, no bundle.js at all - and an ordinary Space member can contribute to it live', async () => {
  const member = await actor();
  const relay = await bootRelay({ extraActors: [member] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { window, mountEl, router } = mountAdmin(adminSpace);

    // A BLANK realm:'global' app - no installer, no bundle.js, exactly the "I just want to build
    // something through the UI" starting point.
    await registerApp(adminSpace, { prefix: 'notesboard', name: 'Notizbrett', realm: 'global' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    router.navigate('/admin/');
    await waitUntil(() => mountEl.querySelector('[data-qu-bind="platform-apps-list"] li'));

    function notesboardListItem() {
      return [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes('#/notesboard'));
    }
    await waitUntil(() => notesboardListItem());
    const li = notesboardListItem();
    const sharedListInput = li.querySelector('input[placeholder="neue shared-list (optional)"]');
    assert.ok(sharedListInput, 'the CMS button offers a way to register a NEW shared list for a bundle-less app');
    sharedListInput.value = 'notesboard-entries';
    const cmsBtn = [...li.querySelectorAll('button')].find((b) => b.textContent === 'Views/Seiten (CMS)');
    assert.ok(cmsBtn, '"Views/Seiten (CMS)" is offered for every realm:"global" app, including a bundle-less one');
    cmsBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

    // Navigates to the app's own CMS editor and self-provisions it - the SAME editor
    // view-editor.test.js already proves in detail, reached a different way here.
    await waitUntil(() => window.location.hash === '#/admin/notesboard/cms', { timeout: 6000 });
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-view-form"]'), { timeout: 6000 });
    // A short settle margin - `renderGlobalShell()` calls `wireInstalledApps()` BEFORE `wireCms()`
    // (sequentially, not `Promise.all`'d together the way `wireCms()`'s own three sections are) -
    // the form already sits in the DOM the instant `renderPage()` ran, but `wireViewEditor()`'s own
    // submit listener isn't attached until `wireCms()` itself actually starts running. A real human
    // filling out a form takes far longer than this gap; only a script firing `submit` immediately
    // after the element appears can actually hit it.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Build a shared-list-backed, route-bound View through the rendered form - no Dev API call,
    // no bundle.js, exactly the "Gästebuch nachbauen nur per UI" workflow.
    const viewForm = mountEl.querySelector('form[data-qu-action="cms-view-form"]');
    viewForm.querySelector('[name="name"]').value = 'notesboard-feed';
    viewForm.querySelector('[name="route"]').value = '/';
    viewForm.querySelector('[name="sources"]').value = JSON.stringify([{ type: 'shared-list', name: 'notesboard-entries' }]);
    viewForm.querySelector('[name="sortBy"]').value = 'timestamp';
    viewForm.querySelector('[name="itemTemplate"]').value = '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>';
    viewForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(viewForm.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    router.stop();

    // An ORDINARY Space member (never the relay-admin) contributes - proving write access is
    // genuinely open to anyone, not just whoever built the app.
    const memberSpace = await relay.connect(member);
    const { pushToSharedList } = await import('@qu/app-core');
    await pushToSharedList(memberSpace, 'notesboard-entries', { name: 'Fenna', message: 'Erster Eintrag, komplett per UI gebaut!', ts: Date.now() });

    const { window: visitorWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/notesboard/' });
    const visitorMount = visitorWindow.document.querySelector('qu-app-shell');
    const { router: visitorRouter } = startPlatform({ space: memberSpace, mountEl: visitorMount, window: visitorWindow, resolveTimeout: 1500 });
    await waitUntil(() => visitorMount.querySelector('[data-qu-view="notesboard-feed"]')?.textContent.includes('Erster Eintrag, komplett per UI gebaut!'), { timeout: 6000 });
    assert.ok(visitorMount.querySelector('[data-qu-view="notesboard-feed"]').textContent.includes('Fenna'));
    visitorRouter.stop();
  } finally {
    await relay.close();
  }
});
