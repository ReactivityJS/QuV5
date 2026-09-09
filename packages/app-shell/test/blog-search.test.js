/**
 * BLOG: FULL-TEXT SEARCH — `dev.js`'s `excerptFromHtml()`/`view-sources.js`'s
 * `openLiveView().setQuery()` own doc comments. Proves the real, previously
 * missing capability end to end: a GLOBAL post published through the actual
 * form becomes searchable by its own CONTENT (not just its title), via the
 * SAME `blog-index` View `blog-bundle.js` already builds - no new View/UI
 * wiring needed for the underlying mechanism to work.
 *
 * Same fixture shape as `blog-feeds.test.js` (real WS relay, the live app
 * resolver actually running) - reused here rather than duplicated.
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
import { installGlobalAppBundle, registerApp, publishGlobalRoute, ContentResolver, openLiveView, globalAppAnchor, adminViewKind, adminPageKind, adminRouteRegistryKind } from '@qu/app-core';

const GLOBAL_KINDS = { pageKind: adminPageKind, routeRegistryKind: adminRouteRegistryKind, viewKind: adminViewKind };
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

async function bootRelay() {
  const relayAdmin = await actor();
  const relayAdmins = [relayAdmin.signingPub];
  const members = [relayAdmin].map((a) => ({ pub: a.signingPub, xPub: a.xPublicKey }));

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

function mountAt(space, hash) {
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: `https://platform.test/#${hash}` });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space, mountEl, window, resolveTimeout: 1500 });
  return { window, mountEl, router };
}

async function installViaForm(mountEl, appType, prefix, fields = {}) {
  await waitUntil(() => mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`));
  const form = mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`);
  form.querySelector('input[name="prefix"]').value = prefix;
  for (const [name, value] of Object.entries(fields)) form.querySelector(`[name="${name}"]`).value = value;
  form.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /installiert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
}

test('Blog: a globally-published post becomes searchable by its own CONTENT, not just its title, via blog-index + openLiveView().setQuery()', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const authorSpace = await relay.connect(relay.relayAdmin);
    const { window, mountEl, router } = mountAt(authorSpace, '/blog/');
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    form.querySelector('[name="title"]').value = 'Wochenrückblick';
    form.querySelector('[name="slug"]').value = 'woche-42';
    form.querySelector('[name="content"]').value = '<p>Diese Woche ging es viel um Wanderungen in den Alpen.</p>';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    router.stop();

    const readerSpace = await relay.connect(relay.relayAdmin);
    const blogAnchor = await globalAppAnchor('blog');
    const resolver = new ContentResolver(readerSpace, { appAdminPub: blogAnchor, kinds: GLOBAL_KINDS });
    const config = await resolver.resolveView('blog-index', { timeout: 3000 });
    const view = await openLiveView(readerSpace, { appAdminPub: blogAnchor, kinds: GLOBAL_KINDS, ...config });
    try {
      let items = await view.toArray();
      assert.deepEqual(items.map((i) => i.title), ['Wochenrückblick']);

      // "Alpen" appears in the post's own CONTENT, nowhere in its title - only findable at all if
      // the route registry's own excerpt (captured at publish time, `blog-actions.js`'s
      // `publishGlobalPost()`) actually made it into this View's normalized items.
      await view.setQuery('Alpen');
      items = await view.toArray();
      assert.deepEqual(items.map((i) => i.title), ['Wochenrückblick'], 'found by content, not title');

      await view.setQuery('nichts-passt-hier');
      items = await view.toArray();
      assert.deepEqual(items, [], 'a genuinely non-matching query yields an empty result, not an error');

      await view.setQuery('');
      items = await view.toArray();
      assert.equal(items.length, 1, 'clearing the query restores the full feed');
    } finally {
      view.close();
    }
  } finally {
    await relay.close();
  }
});

test('Blog: the Global Feed\'s own rendered search box filters the visible feed by content, live, no reload', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const authorSpace = await relay.connect(relay.relayAdmin);
    const { window, mountEl, router } = mountAt(authorSpace, '/blog/');
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');

    async function publish({ title, slug, content }) {
      form.querySelector('[name="title"]').value = title;
      form.querySelector('[name="slug"]').value = slug;
      form.querySelector('[name="content"]').value = content;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    }
    await publish({ title: 'Wochenrückblick', slug: 'woche-42', content: '<p>Diese Woche ging es viel um Wanderungen in den Alpen.</p>' });
    await publish({ title: 'Kochrezept', slug: 'kochrezept', content: '<p>Heute gibt es Pasta mit Tomatensauce.</p>' });

    await waitUntil(() => mountEl.querySelectorAll('[data-qu-view="blog-index"] [data-qu-view-link]').length === 2, { timeout: 6000 });
    const searchInput = mountEl.querySelector('[data-qu-search-for="blog-index"]');
    assert.ok(searchInput, 'the Global Feed page ships a search box wired to its own blog-index View');

    searchInput.value = 'Alpen';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitUntil(() => mountEl.querySelectorAll('[data-qu-view="blog-index"] [data-qu-view-link]').length === 1, { timeout: 3000 });
    assert.equal(mountEl.querySelector('[data-qu-view="blog-index"] [data-qu-view-link]').textContent, 'Wochenrückblick', 'found by its own content text, not typed into the title field');

    searchInput.value = '';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitUntil(() => mountEl.querySelectorAll('[data-qu-view="blog-index"] [data-qu-view-link]').length === 2, { timeout: 3000 });

    router.stop();
  } finally {
    await relay.close();
  }
});
