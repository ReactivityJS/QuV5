/**
 * `data-qu-action="qu-write"` (`generic-write-actions.js`) — proves the
 * "header/footer needs a way to WRITE, not just a way to READ" gap
 * `docs/example-apps.md`'s own §5 used to call out as the one remaining
 * piece: after building a shared-list-backed View entirely through the
 * admin console (the SAME `views-ui.test.js` workflow this test picks up
 * right where that one leaves off), a relay-admin edits the auto-created
 * wrapper page's own content (the CMS "Seiten" editor, exactly as
 * `docs/example-apps.md` §5 step 4 describes) to wrap the feed in a
 * generic, declarative write form - no `bundle.js`, no per-app JS file at
 * all - and an ORDINARY Space member's submission through THAT form shows
 * up live, same as any other reference app's own hand-wired one.
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
import { installGlobalAppBundle, registerApp, publishGlobalRoute, addSharedLists, pushToSharedList } from '@qu/app-core';
import { createLiveAppResolveKindSchema } from '../src/live-app-resolver.js';
import { startPlatform } from '../src/boot.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 6000, interval = 20 } = {}) {
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

test('data-qu-action="qu-write": a page built purely through the CMS gets a GENERIC write form, no bundle.js - and an ordinary member\'s submission through it shows up live', async () => {
  const member = await actor();
  const relay = await bootRelay({ extraActors: [member] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { window, mountEl } = mountAdmin(adminSpace);

    // Same starting point as views-ui.test.js: a blank realm:'global' app, a shared list registered,
    // a route-bound shared-list View built entirely through the rendered CMS forms.
    await registerApp(adminSpace, { prefix: 'signboard', name: 'Aushang', realm: 'global' });
    await new Promise((resolve) => setTimeout(resolve, 400)); // settle - see registerApp()'s own doc comment on a concurrent resolveApps() (mountAdmin()'s own initial dispatch) tearing the local registry Node handle back down between calls.
    await addSharedLists(adminSpace, { prefix: 'signboard', sharedLists: ['signboard-entries'] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await publishGlobalRoute(adminSpace, 'signboard', { route: '/cms', title: 'CMS' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { installGlobalCms } = await import('../cms-bundle.js');
    await installGlobalCms(adminSpace, 'signboard');

    window.location.hash = '/admin/signboard/cms/content';
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-content-form"]'));
    await new Promise((resolve) => setTimeout(resolve, 500)); // see views-ui.test.js's own doc comment on this exact settle margin.

    const viewForm = mountEl.querySelector('form[data-qu-action="cms-content-form"]');
    const sourceTypeSelect = viewForm.querySelector('[name="sourceType"]');
    sourceTypeSelect.value = 'shared-list';
    sourceTypeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    viewForm.querySelector('[name="name"]').value = 'signboard-feed';
    viewForm.querySelector('[name="route"]').value = '/';
    viewForm.querySelector('[name="listName"]').value = 'signboard-entries';
    viewForm.querySelector('[name="sortBy"]').value = 'timestamp';
    viewForm.querySelector('[name="itemTemplate"]').value = '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>';
    viewForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(viewForm.querySelector('[data-qu-status]')?.textContent ?? ''));

    // Step 4 of docs/example-apps.md §5: load the auto-created wrapper page (route "/") back from
    // the SAME unified Content list and wrap its existing <div data-qu-view> in a GENERIC write form
    // - purely declarative attributes, no data-qu-action code of this app's own anywhere. The
    // Content list is a one-shot `resolveRoutes()` read (not live-subscribed) taken when this page
    // was FIRST wired, before `createView({route: '/'})` above ever published this route -
    // re-navigating away and back re-wires the CMS fresh, the same list a genuine second visit
    // would see.
    window.location.hash = '/admin/';
    await waitUntil(() => window.location.hash === '#/admin/');
    window.location.hash = '/admin/signboard/cms/content';
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-content-form"]'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] button')].some((b) => b.textContent === '/'));
    const pageBtn = [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] button')].find((b) => b.textContent === '/');
    pageBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-content-form"] [name="content"]').value.includes('signboard-feed'));

    const pageForm = mountEl.querySelector('form[data-qu-action="cms-content-form"]');
    const contentField = pageForm.querySelector('[name="content"]');
    contentField.value = `<h1>Aushang</h1>
${contentField.value}
<form data-qu-action="qu-write" data-qu-target="shared-list" data-qu-list="signboard-entries">
  <input name="name" placeholder="Name">
  <input name="message" placeholder="Nachricht">
  <button type="submit">Eintragen</button>
  <p data-qu-status></p>
</form>`;
    pageForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(pageForm.querySelector('[data-qu-status]')?.textContent ?? ''));

    // An ORDINARY Space member (never the relay-admin) visits the page and submits the GENERIC form.
    const memberSpace = await relay.connect(member);
    const { window: visitorWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/signboard/' });
    const visitorMount = visitorWindow.document.querySelector('qu-app-shell');
    const { router: visitorRouter } = startPlatform({ space: memberSpace, mountEl: visitorMount, window: visitorWindow, resolveTimeout: 1500 });
    await waitUntil(() => visitorMount.querySelector('form[data-qu-action="qu-write"]'));

    const writeForm = visitorMount.querySelector('form[data-qu-action="qu-write"]');
    writeForm.querySelector('[name="name"]').value = 'Bob';
    writeForm.querySelector('[name="message"]').value = 'Rein per generischem Formular, ohne eigenes JS!';
    writeForm.dispatchEvent(new visitorWindow.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(writeForm.querySelector('[data-qu-status]')?.textContent ?? ''));

    await waitUntil(() => visitorMount.querySelector('[data-qu-view="signboard-feed"]')?.textContent.includes('Rein per generischem Formular, ohne eigenes JS!'));
    assert.ok(visitorMount.querySelector('[data-qu-view="signboard-feed"]').textContent.includes('Bob'));

    // The SAME list, also writable via the plain Dev API - proving the generic form is a genuine
    // `pushToSharedList()` call under the hood, not a parallel, form-only side channel.
    await pushToSharedList(memberSpace, 'signboard-entries', { name: 'Charly', message: 'Auch über die Dev API sichtbar', ts: Date.now() });
    await waitUntil(() => visitorMount.querySelector('[data-qu-view="signboard-feed"]')?.textContent.includes('Auch über die Dev API sichtbar'));

    visitorRouter.stop();
  } finally {
    await relay.close();
  }
});
