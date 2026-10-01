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
import { Space, ensureUserProfile } from '@qu/space-core';
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

test('Chat (a file-based /apps/* app): installs via the admin console; two ordinary Space members each add the other as a contact, converge on the SAME 1:1 room, and exchange a real message through the rendered messenger UI', async () => {
  // v2 (the real messenger - see apps/chat/bundle.js's own top doc comment) replaced the v1
  // shared-public-feed demo this test used to cover. There is deliberately NO push/notify
  // mechanism (messenger.js's own "contacts-first" doc comment, confirmed with the user) - BOTH
  // sides must independently add each other as a contact and start the chat for it to appear in
  // their own sidebar; `getOrCreateDirectChat()`'s own "either side starting first is found, not
  // duplicated" guarantee (already proven at the Dev-API level in app-core's messenger.test.js) is
  // what this test proves end to end through the ACTUAL RENDERED UI instead.
  const alice = await actor();
  const bob = await actor();
  const relay = await bootRelay({ extraActors: [alice, bob] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'chat', 'chat');
    adminRouter.stop();

    // Both profiles ("qu-user", `epub` - @qu/space-core's own user.js) published BEFORE either
    // adds the other as a contact - adding a contact resolves their REAL X25519 encryption key
    // this way (never guessed/reused from the signing pubkey - actions.js's own doc comment on the
    // real bug that fixes), exactly what `@qu/app-shell`'s own `shell.js` already does automatically
    // on every real boot; this test calls it explicitly since it bypasses `shell.js` entirely.
    const aliceSpace = await relay.connect(alice);
    const bobSpace = await relay.connect(bob);
    await Promise.all([ensureUserProfile(aliceSpace), ensureUserProfile(bobSpace)]);
    // A settle wait, same reasoning as every other `registerApp()`/write-then-read-from-elsewhere
    // step in this file's own `bootRelay()`: `ensureUserProfile()` resolving only guarantees the
    // LOCAL write happened, not that it has already reached the relay's own durable mirror - without
    // this, a contact-add lookup moments later can race ahead of the actual write landing and
    // correctly (not a bug - `user.js`'s own `waitUntilSet()` doc comment) conclude "never published."
    await new Promise((resolve) => setTimeout(resolve, 300));

    const { window: aliceWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/chat/' });
    const aliceMountEl = aliceWindow.document.querySelector('qu-app-shell');
    const { router: aliceRouter } = startPlatform({ space: aliceSpace, mountEl: aliceMountEl, window: aliceWindow, resolveTimeout: 1500 });
    await waitUntil(() => aliceMountEl.querySelector('[data-qu-chat-app]'));

    const bobPubB64 = QuCrypto.toBase64(bob.signingPub);
    aliceMountEl.querySelector('[data-qu-chat-new-toggle]').dispatchEvent(new aliceWindow.Event('click', { bubbles: true }));
    aliceMountEl.querySelector('[data-qu-chat-contact-pub]').value = bobPubB64;
    aliceMountEl.querySelector('[data-qu-chat-contact-alias]').value = 'Bob';
    aliceMountEl.querySelector('[data-qu-chat-contact-add]').dispatchEvent(new aliceWindow.Event('click', { bubbles: true }));
    await waitUntil(() => [...aliceMountEl.querySelectorAll('[data-qu-chat-contacts] a')].some((a) => a.textContent === 'Bob'));
    [...aliceMountEl.querySelectorAll('[data-qu-chat-contacts] a')].find((a) => a.textContent === 'Bob').dispatchEvent(new aliceWindow.Event('click', { bubbles: true }));

    await waitUntil(() => aliceMountEl.querySelector('[data-qu-chat-composer]'));
    aliceMountEl.querySelector('[data-qu-chat-input]').value = 'Hallo Bob, echte Messenger-UI!';
    aliceMountEl.querySelector('[data-qu-chat-composer]').dispatchEvent(new aliceWindow.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => aliceMountEl.querySelector('[data-qu-chat-message]'));
    assert.ok(aliceMountEl.querySelector('[data-qu-chat-tick]'), "alice's own sent message shows a delivery tick");

    const { window: bobWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/chat/' });
    const bobMountEl = bobWindow.document.querySelector('qu-app-shell');
    const { router: bobRouter } = startPlatform({ space: bobSpace, mountEl: bobMountEl, window: bobWindow, resolveTimeout: 1500 });
    await waitUntil(() => bobMountEl.querySelector('[data-qu-chat-app]'));

    const alicePubB64 = QuCrypto.toBase64(alice.signingPub);
    bobMountEl.querySelector('[data-qu-chat-new-toggle]').dispatchEvent(new bobWindow.Event('click', { bubbles: true }));
    bobMountEl.querySelector('[data-qu-chat-contact-pub]').value = alicePubB64;
    bobMountEl.querySelector('[data-qu-chat-contact-alias]').value = 'Alice';
    bobMountEl.querySelector('[data-qu-chat-contact-add]').dispatchEvent(new bobWindow.Event('click', { bubbles: true }));
    await waitUntil(() => [...bobMountEl.querySelectorAll('[data-qu-chat-contacts] a')].some((a) => a.textContent === 'Alice'));
    [...bobMountEl.querySelectorAll('[data-qu-chat-contacts] a')].find((a) => a.textContent === 'Alice').dispatchEvent(new bobWindow.Event('click', { bubbles: true }));

    // Converges on the SAME room alice already created (getOrCreateDirectChat()'s own "found, not
    // duplicated" guarantee) - bob sees alice's message without ever having sent anything himself.
    await waitUntil(() => bobMountEl.querySelector('[data-qu-chat-message]')?.textContent.includes('Hallo Bob, echte Messenger-UI!'), { timeout: 4000 });

    aliceRouter.stop();
    bobRouter.stop();
  } finally {
    await relay.close();
  }
});
