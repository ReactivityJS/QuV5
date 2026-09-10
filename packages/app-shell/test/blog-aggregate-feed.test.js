/**
 * BLOG: `mode: 'personal'` AGGREGATE FEED — `blog-bundle.js`'s
 * `aggregateFeedViewFields()`/`blog-actions.js`'s `pushAggregateIndexEntry()`
 * own doc comments. Proves the real, previously-missing capability end to
 * end: multiple DIFFERENT visitors each publish their own personal post,
 * and the app's bare prefix (now `mode: 'personal'`, a read-only merged
 * feed) shows every one of them, each still linking through to that
 * SPECIFIC owner's own post content correctly.
 *
 * Same fixture shape as `blog-feeds.test.js`/`installed-apps.test.js` (real
 * WS relay, the live app resolver actually running) - reused here rather
 * than duplicated.
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
import { installGlobalAppBundle, registerApp, publishGlobalRoute, setAppMode } from '@qu/app-core';
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

async function publishPersonalPost(space, { title, slug, content }) {
  const { window, mountEl, router } = mountAt(space, '/blog/u/me/');
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
  form.querySelector('[name="title"]').value = title;
  form.querySelector('[name="slug"]').value = slug;
  form.querySelector('[name="content"]').value = content;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
  router.stop();
}

test('Blog: mode:"personal" merges every visitor\'s own posts into one read-only feed at the bare prefix, each still linking to its own correct content', async () => {
  const alice = await actor();
  const bob = await actor();
  const visitor = await actor();
  // `visitor` is a relay MEMBER too, even though it only ever reads here - `sharedListKind`'s
  // `acl.write: 'members'` gates SUBSCRIBING to it as well, not just writing (`relay.js`'s own
  // subscribe-handler doc comment: a `'members'`-mode Kind keeps the flat membership gate for
  // both). This matches real deployments exactly: `shell.js`'s own boot sequence calls
  // `joinSpace()` unconditionally for every visitor before ever touching a Kind - there is no
  // genuinely un-joined, anonymous reader in this framework's actual model, just visitors who
  // never happen to WRITE anything.
  const relay = await bootRelay({ extraActors: [alice, bob, visitor] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    await setAppMode(adminSpace, { prefix: 'blog', mode: 'personal' });

    const aliceSpace = await relay.connect(alice);
    await publishPersonalPost(aliceSpace, { title: 'Alices erster Post', slug: 'alice-post', content: '<p>Hallo von Alice.</p>' });

    const bobSpace = await relay.connect(bob);
    await publishPersonalPost(bobSpace, { title: 'Bobs Gedanken', slug: 'bob-post', content: '<p>Hallo von Bob.</p>' });

    // A fourth, uninvolved visitor (never wrote anything) browses the bare prefix - now the
    // read-only aggregate feed.
    const visitorSpace = await relay.connect(visitor);
    const { mountEl, router } = mountAt(visitorSpace, '/blog/');

    await waitUntil(() => mountEl.querySelector('[data-qu-view="blog-aggregate-feed"]')?.textContent.includes('Alices erster Post') && mountEl.textContent.includes('Bobs Gedanken'), { timeout: 6000 });
    assert.equal(mountEl.querySelectorAll('[data-qu-view="blog-aggregate-feed"] [data-qu-view-link]').length, 2, 'both posts appear, no duplicates');

    // Follow Alice's own entry - must land on HER content specifically, not Bob's. Navigated via
    // `router.navigate()` (the same mechanism every other test in this codebase already uses to
    // follow a link), not a real anchor click - jsdom's own same-document hash-anchor-click
    // behavior isn't something any other test here relies on either.
    const aliceLink = [...mountEl.querySelectorAll('[data-qu-view-link]')].find((a) => a.textContent === 'Alices erster Post');
    const aliceHref = aliceLink.getAttribute('href');
    assert.ok(aliceHref.includes('/u/'), "the aggregate feed's own links are already owner-prefixed - no rewrite needed/possible here");
    router.navigate(aliceHref.slice(1));
    await waitUntil(() => mountEl.textContent.includes('Hallo von Alice.'), { timeout: 6000 });
    assert.ok(!mountEl.textContent.includes('Hallo von Bob.'));

    router.stop();
  } finally {
    await relay.close();
  }
});
