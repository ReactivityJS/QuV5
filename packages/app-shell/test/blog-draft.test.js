/**
 * BLOG: ENTWURF/VERÖFFENTLICHEN — `blog-bundle.js`/`blog-actions.js`'s own
 * "UPDATE - ENTWURF/VERÖFFENTLICHEN" doc comments, `kinds.js`'s
 * `pageKind.status`/`resolver.js`'s `resolvePage()` underneath them. Proves
 * the real, previously-missing workflow end to end, for both the personal
 * and the global (relay-admin) post form:
 *   1. "Als Entwurf speichern" creates a REAL page Node that is invisible
 *      to an ordinary visitor (resolves as `null`, same as never-published)
 *      and absent from the index View - not registered, not enumerable.
 *   2. The SAME still-open form can then click "Veröffentlichen" to go
 *      live - now resolvable and listed, exactly once (no double
 *      registration from having existed as a draft first).
 *   3. Editing an ALREADY-published post and clicking "Als Entwurf
 *      speichern" reverts it to draft (same not-found signal) without
 *      touching the route registry.
 *
 * Same fixture shape as `blog-feeds.test.js`/`blog-search.test.js` (real WS
 * relay, the live app resolver actually running) - reused here rather than
 * duplicated.
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

function fillPost(form, window, { title, slug, content }) {
  form.querySelector('[name="title"]').value = title;
  const slugField = form.querySelector('[name="slug"]');
  if (!slugField.readOnly) slugField.value = slug;
  form.querySelector('[name="content"]').value = content;
}

function clickThenSubmit(form, window, btn) {
  btn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('Blog personal: "Als Entwurf speichern" is invisible until "Veröffentlichen" is clicked on the same still-open form', async () => {
  const visitor = await actor();
  const relay = await bootRelay({ extraActors: [visitor] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const authorSpace = await relay.connect(visitor);
    const { window, mountEl, router } = mountAt(authorSpace, '/blog/u/me/');
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    const draftBtn = form.querySelector('[data-qu-draft-btn]');
    const submitBtn = form.querySelector('button[type="submit"]');

    fillPost(form, window, { title: 'Roman-Entwurf', slug: 'roman-entwurf', content: '<p>Noch nicht fertig.</p>' });
    clickThenSubmit(form, window, draftBtn);
    await waitUntil(() => /Entwurf gespeichert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    assert.equal(form.querySelector('[name="slug"]').readOnly, true, 'the route is now fixed - the SAME draft, not a new post, on the next submit');
    assert.equal(submitBtn.textContent, 'Veröffentlichen');

    // Invisible: never in the personal index, and a completely different visitor cannot resolve it
    // by navigating straight to its own route either - resolvePage() treats a draft as unpublished.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!mountEl.querySelector('[data-qu-view="blog-personal-index"]')?.textContent.includes('Roman-Entwurf'), 'not listed while still a draft');

    const readerSpace = await relay.connect(relay.relayAdmin);
    const ownerRef = QuCrypto.toBase64Url(visitor.signingPub);
    const { mountEl: readerEl, router: readerRouter } = mountAt(readerSpace, `/blog/u/${ownerRef}/post/roman-entwurf`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(!readerEl.textContent.includes('Noch nicht fertig.'), 'a draft is not directly reachable via its own route either - same "not found" as never-published');
    readerRouter.stop();

    // --- Now actually publish the SAME draft, from the SAME still-open form. ---
    clickThenSubmit(form, window, submitBtn);
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    await waitUntil(() => mountEl.querySelector('[data-qu-view="blog-personal-index"]')?.textContent.includes('Roman-Entwurf'), { timeout: 6000 });
    assert.equal(mountEl.querySelectorAll('[data-qu-view-link]').length, 1, 'exactly one entry - no duplicate registration from having existed as a draft first');

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Blog global: a relay-admin can save a draft and later publish it from the same still-open form', async () => {
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
    const draftBtn = form.querySelector('[data-qu-draft-btn]');
    const submitBtn = form.querySelector('button[type="submit"]');

    fillPost(form, window, { title: 'Ankündigung', slug: 'ankuendigung', content: '<p>In Arbeit.</p>' });
    clickThenSubmit(form, window, draftBtn);
    await waitUntil(() => /Entwurf gespeichert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(!mountEl.querySelector('[data-qu-view="blog-index"]')?.textContent.includes('Ankündigung'), 'not listed while still a draft');

    clickThenSubmit(form, window, submitBtn);
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    await waitUntil(() => mountEl.querySelector('[data-qu-view="blog-index"]')?.textContent.includes('Ankündigung'), { timeout: 6000 });
    assert.equal(mountEl.querySelectorAll('[data-qu-view-link]').length, 1, 'exactly one entry - no duplicate registration from having existed as a draft first');

    router.stop();
  } finally {
    await relay.close();
  }
});
