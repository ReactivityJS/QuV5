/**
 * RICH TEXT — ADMIN-TOGGLED, PLATFORM-WIDE — proves the OTHER (and, since
 * this round, the REAL default) way to get the optional ProseMirror editor:
 * a relay-admin flips a checkbox in the built-in admin console's own
 * "Editor-Einstellungen" form (`admin-console-bundle.js`/`admin-actions.js`),
 * which writes `platformAppsKind.platformConfig.richTextEditor` via
 * `setPlatformConfig()` (`@qu/app-core`'s `dev.js`) - `boot.js`'s
 * `startPlatform()` then binds every `[data-qu-richtext]` field to the
 * REAL editor for EVERY visitor, with NO `richTextBind` param passed by
 * the caller at all (unlike `rich-text-prosemirror-integration.test.js`,
 * which forces the bind explicitly - that test still covers the override
 * escape hatch, this one covers the actual `shell.js` boot path). Also
 * proves the flag is read FRESH on every route render (`boot.js`'s own doc
 * comment on `richTextBind`): the SAME already-connected author Space sees
 * the built-in editor before the toggle and the real ProseMirror editor
 * after, without reconnecting.
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

test("a relay-admin's 'Editor-Einstellungen' checkbox in #/admin upgrades Blog's textarea to the real ProseMirror editor for an already-connected author, no richTextBind param anywhere", async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');

    const authorSpace = await relay.connect(relay.relayAdmin);
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/blog/' });
    const mountEl = window.document.querySelector('qu-app-shell');
    global.window = window;
    global.document = window.document;
    global.DOMParser = window.DOMParser;
    global.Node = window.Node;
    // NO `richTextBind` passed - this is the exact call `shell.js` itself makes in a real browser.
    const { router } = startPlatform({ space: authorSpace, mountEl, window, resolveTimeout: 1500 });

    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    assert.equal(mountEl.querySelector('.ProseMirror'), null, 'BEFORE the admin toggle, the built-in editor is still the default - no ProseMirror mounted');

    // The admin flips the checkbox in the REAL admin console DOM, exactly as a person would.
    const configForm = adminMountEl.querySelector('form[data-qu-action="set-platform-config"]');
    assert.ok(configForm, 'the admin console renders the Editor-Einstellungen form');
    const checkbox = configForm.querySelector('input[name="richTextEditor"]');
    assert.equal(checkbox.checked, false, 'starts unchecked - nobody has enabled it yet');
    checkbox.checked = true;
    configForm.dispatchEvent(new adminMountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /Gespeichert/.test(configForm.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 4000 });
    adminRouter.stop();

    // The SAME author Space/router, re-rendering Blog's form - no reconnect, no new startPlatform()
    // call - proves the flag is read fresh on every navigation, not just once at boot. An
    // intermediate throwaway route first, since setting the hash to what it ALREADY is fires no
    // `hashchange` event at all (nothing to force a real onChange otherwise).
    router.navigate('/__force-rerender__');
    await new Promise((resolve) => setTimeout(resolve, 50));
    router.navigate('/blog/');
    await waitUntil(() => mountEl.querySelector('.ProseMirror'), { timeout: 4000 });
    assert.ok(mountEl.querySelector('.ProseMirror'), 'AFTER the admin toggle, the very next render upgrades to the real ProseMirror editor - same author Space, no reconnect');

    router.stop();
  } finally {
    await relay.close();
  }
});
