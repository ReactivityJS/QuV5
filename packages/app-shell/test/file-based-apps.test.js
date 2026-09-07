/**
 * FILE-BASED /apps/* APPS, END TO END, THROUGH THE REAL ADMIN-CONSOLE
 * INSTALLER — the counterpart to `installed-apps.test.js` (that file's own
 * top doc comment covers the three STORAGE/Template-only reference apps;
 * this one covers the discovery mechanism repo root's own `apps/README.md`
 * documents, proven against the real `/apps/chat` app committed there).
 * Goes through a REAL WebSocket relay with `live-app-resolver.js` actually
 * running, exactly like `installed-apps.test.js` - a discovered app's own
 * `registerApp()`/`adminPage`/`adminView`/shared-list writes need the exact
 * same live reclassification any other `realm: 'global'` app does.
 *
 * Requires `apps-registry.generated.js` to actually list `chat` - run
 * `npm run apps:registry` (or `node packages/app-shell/apps-registry.mjs`)
 * first if this fails with "chat installieren" never appearing; `npm test`
 * at the repo root already does this via its own `pretest` script.
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

/** Same shape/ordering as `installed-apps.test.js`'s own `bootRelay()` - see that file's own doc comment on why register-then-publish-then-install matters. */
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

async function installViaForm(mountEl, appType, prefix) {
  await waitUntil(() => mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`));
  const form = mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`);
  form.querySelector('input[name="prefix"]').value = prefix;
  form.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /installiert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
}

test('the admin console dynamically offers an install form for the discovered /apps/chat app, identically to a hardcoded reference app', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl, router } = mountAdmin(adminSpace);

    await waitUntil(() => mountEl.querySelector('form[data-qu-action="install-app"][data-app-type="guestbook"]'));
    const chatForm = mountEl.querySelector('form[data-qu-action="install-app"][data-app-type="chat"]');
    assert.ok(chatForm, '/apps/chat shows up as an install form, dynamically injected into [data-qu-bind="file-app-installers"]');
    assert.ok(chatForm.closest('[data-qu-bind="file-app-installers"]'), 'lives inside the dynamic container, not hand-authored stored content');
    assert.match(chatForm.querySelector('button').textContent, /Chat installieren/);

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Chat (a file-based /apps/* app): installs via the admin console, and any Space member can send a message and see it live in the shared feed', async () => {
  const member = await actor();
  const relay = await bootRelay({ extraActors: [member] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'chat', 'chat');
    adminRouter.stop();

    // An ORDINARY Space member (never the relay-admin, never the installer) - proving the shared
    // list's own 'members'-ACL genuinely lets anyone participate, not just whoever installed it.
    const memberSpace = await relay.connect(member);
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/chat/' });
    const mountEl = window.document.querySelector('qu-app-shell');
    const { router } = startPlatform({ space: memberSpace, mountEl, window, resolveTimeout: 1500 });

    await waitUntil(() => mountEl.querySelector('form[data-qu-action="chat-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="chat-form"]');
    form.querySelector('[name="name"]').value = 'Erin';
    form.querySelector('[name="message"]').value = 'Hallo aus dem file-basierten Chat!';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));
    await waitUntil(() => mountEl.querySelector('[data-qu-view="chat-feed"]')?.textContent.includes('Hallo aus dem file-basierten Chat!'));
    assert.ok(mountEl.querySelector('[data-qu-view="chat-feed"]').textContent.includes('Erin'));

    router.stop();
  } finally {
    await relay.close();
  }
});
