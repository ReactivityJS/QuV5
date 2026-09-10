/**
 * RICH TEXT — OPTIONAL PROSEMIRROR UPGRADE — proves `boot.js`'s own
 * `richTextBind` injection point (`rich-text-actions.js`'s top doc
 * comment) actually works end to end: `startPlatform({..., richTextBind:
 * bindLocalRichText})` replaces Blog's post-content textarea with the
 * REAL `@qu/space-editor-prosemirror` editor instead of `@qu/space-ui`'s
 * built-in one - a DEV-only dependency of `@qu/app-shell` (see that
 * package's own `package.json`), never a runtime one; the built-in editor
 * stays the actual shipped default until a deployment explicitly opts in
 * exactly the way this test does. Same fixture shape as `blog-feeds.test.js`.
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
import { bindLocalRichText } from '@qu/space-editor-prosemirror';
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

async function installViaForm(mountEl, appType, prefix, fields = {}) {
  await waitUntil(() => mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`));
  const form = mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`);
  form.querySelector('input[name="prefix"]').value = prefix;
  for (const [name, value] of Object.entries(fields)) form.querySelector(`[name="${name}"]`).value = value;
  form.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /installiert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
}

test('startPlatform({richTextBind}) upgrades Blog\'s post-content textarea to the real ProseMirror editor, end to end', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const authorSpace = await relay.connect(relay.relayAdmin);
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/blog/' });
    const mountEl = window.document.querySelector('qu-app-shell');
    global.window = window;
    global.document = window.document;
    global.DOMParser = window.DOMParser;
    global.Node = window.Node;
    const { router } = startPlatform({ space: authorSpace, mountEl, window, resolveTimeout: 1500, richTextBind: bindLocalRichText });

    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    const contentField = form.querySelector('[name="content"]');
    await waitUntil(() => contentField.hidden === true, { timeout: 3000 });
    assert.ok(mountEl.querySelector('.ProseMirror'), 'the REAL ProseMirror editor mounted, not the built-in bindRichText() one');

    form.querySelector('[name="title"]').value = 'ProseMirror-Post';
    form.querySelector('[name="slug"]').value = 'prosemirror-post';
    contentField.value = '<p>Über ProseMirror geschrieben.</p>'; // still works exactly like before - the submit handler only ever reads .value.
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    router.navigate('/blog/post/prosemirror-post');
    await waitUntil(() => mountEl.textContent.includes('Über ProseMirror geschrieben.'), { timeout: 8000 });

    router.stop();
  } finally {
    await relay.close();
  }
});
