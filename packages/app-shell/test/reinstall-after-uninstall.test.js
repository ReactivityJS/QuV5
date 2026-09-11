/**
 * REINSTALL AFTER "DEINSTALLIEREN" — a real, reported production bug this
 * guards against: "Deinstallieren" (`@qu/app-core`'s `unregisterApp()` +
 * `nullGlobalAppContent()`) never actually frees a global app's underlying
 * page/View Node ids - it only retracts the registry entry and NULLS each
 * registered page's own `title`/`content` (`nullGlobalAppContent()`'s own
 * doc comment: "not a genuine deletion"). Every reference app's own
 * `installX()` (Guestbook/Blog/Forum) used to call `createGlobalPage()`/
 * `createGlobalView()` unconditionally - a SECOND `createNode()` for a Node
 * that already has real (if nulled) content on the relay once a relay-admin
 * reinstalled the SAME prefix, which `bundle-upsert.js`'s own top doc
 * comment already warns produces a "competing local Y.Doc": two
 * independently-stamped Y.Docs merging via CRDT clock/clientID tie-
 * breaking rather than "the newer write wins."
 *
 * ONLY REPRODUCES with a genuine relay PROCESS RESTART and PERSISTENT
 * (file) storage between the original install and the reinstall - a
 * single continuous in-memory-store test process (this package's OTHER
 * install/uninstall tests) never exercised the code path that actually
 * corrupts: the relay's own stored envelope history surviving across a
 * brand-new, cold local Y.Doc on the reinstalling side. This is exactly
 * what happens on a real deployment: the admin console session that clicks
 * "Deinstallieren" then re-submits the install form is almost always a
 * FRESH page load (a fresh Space, fresh local Y.Docs) relative to whenever
 * the app was originally installed, quite possibly after the relay
 * process itself was redeployed/restarted in between.
 *
 * Before the fix (`installX()` calling raw `createGlobalPage()`/
 * `createGlobalView()`), reinstalling Blog left its own index page with
 * EMPTY `content`/unset `template` even though the reinstall's own write
 * set them correctly - `#/blog/` and `#/admin/blog/cms` both 404ed for
 * every visitor, matching the exact "Blog feed und views" report this test
 * is named for. Fixed by routing `installX()` through the SAME
 * `upsertGlobalPage()`/`upsertGlobalView()` (edit-first, create-as-
 * fallback) helpers `updateX()` already used - a genuinely fresh prefix
 * still hits the create() fallback (edit() correctly reports "does not
 * exist" first), while a reinstall over previously-nulled content now
 * safely EDITS in place instead of racing a second creation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '@qu/space-transport';
import { createFileStore } from '@qu/space-storage';
import { registerApp, publishGlobalRoute, installGlobalAppBundle, unregisterApp, nullGlobalAppContent } from '@qu/app-core';
import { createLiveAppResolveKindSchema } from '../src/live-app-resolver.js';
import { startPlatform } from '../src/boot.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 8000, interval = 30 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

function mountRoute(space, hash) {
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: `https://platform.test/${hash}` });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router, platform } = startPlatform({ space, mountEl, window, resolveTimeout: 2000 });
  return { window, mountEl, router, platform };
}

async function installViaForm(mountEl, appType, prefix, fields = {}) {
  await waitUntil(() => mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`));
  const form = mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`);
  form.querySelector('input[name="prefix"]').value = prefix;
  for (const [name, value] of Object.entries(fields)) form.querySelector(`[name="${name}"]`).value = value;
  form.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /installiert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 8000 });
}

test('Blog: after "Deinstallieren", reinstalling the SAME prefix (over a restarted relay + persistent storage) leaves a working index page and accepts new posts, no 404', async () => {
  const dataDir = join(tmpdir(), `qu-reinstall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dataDir, { recursive: true });
  try {
    const relayAdmin = await actor();
    const relayAdmins = [relayAdmin.signingPub];
    const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];

    async function bootRelay() {
      const httpServer = createServer();
      const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
      const hub = createWsServerHub(wss);
      const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
      createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createFileStore(dataDir) });
      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;
      const url = `ws://127.0.0.1:${port}`;
      await start({ url, relayAdmins });
      return { httpServer, wss, url };
    }
    async function connect(url, identity) {
      const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
      await transport.connect();
      return new Space({ identity, members, relayAdmins, transport });
    }
    async function stopRelay(relay) {
      relay.wss.clients.forEach((ws) => ws.terminate());
      await new Promise((resolve) => relay.httpServer.close(resolve));
    }

    // ROUND 1 - fresh bootstrap: admin console + Blog, one published post.
    let relay = await bootRelay();
    let adminSpace = await connect(relay.url, relayAdmin);
    await registerApp(adminSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await publishGlobalRoute(adminSpace, 'admin', { route: '/', title: 'Relay-Admin' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await installGlobalAppBundle(adminSpace, 'admin', adminConsoleBundle);
    await new Promise((resolve) => setTimeout(resolve, 600));

    let admin = mountRoute(adminSpace, '#/admin/');
    await installViaForm(admin.mountEl, 'blog', 'blog', { routeScheme: 'flat' });
    admin.router.stop();
    await stopRelay(relay);

    // RESTART - a genuine process restart against the SAME persistent storage, the exact
    // condition this bug needs to reproduce (see this test's own top doc comment).
    relay = await bootRelay();
    adminSpace = await connect(relay.url, relayAdmin);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // ROUND 2 - Deinstallieren, then reinstall the SAME prefix via the real admin UI.
    admin = mountRoute(adminSpace, '#/admin/');
    await waitUntil(() => [...admin.mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].some((li) => li.textContent.includes('#/blog')));
    const blogLi = [...admin.mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes('#/blog'));
    const uninstallBtn = [...blogLi.querySelectorAll('button')].find((b) => b.textContent === 'Deinstallieren');
    uninstallBtn.dispatchEvent(new admin.mountEl.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));
    await waitUntil(() => ![...admin.mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].some((li) => li.textContent.includes('#/blog')), { timeout: 6000 });

    await installViaForm(admin.mountEl, 'blog', 'blog', { routeScheme: 'flat' });
    admin.router.stop();
    await new Promise((resolve) => setTimeout(resolve, 800));

    // The index page must render for a FRESH visitor, not 404.
    const outsider = await actor();
    const outsiderSpace = await connect(relay.url, outsider);
    const index = mountRoute(outsiderSpace, '#/blog/');
    await waitUntil(() => index.mountEl.textContent.includes('Blog'), { timeout: 6000 });
    assert.ok(!index.mountEl.textContent.includes('404'), 'the reinstalled index page renders real content, not a 404');
    index.router.stop();

    // A NEW post, published AFTER the reinstall, must be reachable - proves the app is genuinely
    // working going forward, not just "the index page happens to still show something."
    const author = mountRoute(adminSpace, '#/blog/');
    await waitUntil(() => author.mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = author.mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    form.querySelector('[name="title"]').value = 'Nach dem Reinstall';
    form.querySelector('[name="slug"]').value = 'nach-dem-reinstall';
    form.querySelector('[name="content"]').value = '<p>Funktioniert.</p>';
    form.dispatchEvent(new author.mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt|veröffentlicht/i.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 8000 });
    author.router.stop();

    const post = mountRoute(outsiderSpace, '#/blog/post/nach-dem-reinstall');
    await waitUntil(() => post.mountEl.textContent.includes('Funktioniert.'), { timeout: 4000 });
    assert.ok(!post.mountEl.textContent.includes('404'));
    post.router.stop();

    await stopRelay(relay);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
