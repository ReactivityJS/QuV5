/**
 * PLATFORM BOOT — `startPlatform()` (boot.js), the multi-app counterpart
 * to `boot.test.js`'s single-app `startApp()`: a relay-admin registers one
 * app under a path prefix; a visitor's Shell resolves it, falls back to a
 * landing page for an unregistered prefix, and renders the built-in
 * `#/admin/relay` console - which, for an identity that actually IS the
 * relay-admin, can register a SECOND app through the rendered form itself
 * (proving the admin UI's write path end to end, not just its markup).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createTemplate, createPage, registerApp, createAppResolveKindSchema, platformAppsKind } from '@qu/app-core';
import { startPlatform } from '../src/boot.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('startPlatform() routes to the right app by prefix, falls back to a landing page, and renders a working #/admin/relay console', async () => {
  const relayAdmin = await actor();
  const forumAdmin = await actor();
  const visitor = await actor();
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: forumAdmin.signingPub, xPub: forumAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: [forumAdmin.signingPub], relayAdminPub: relayAdmin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const relayAdminSpace = await connect(relayAdmin, 'relay-admin');
  const forumSpace = await connect(forumAdmin, 'forum-admin');
  const visitorSpace = await connect(visitor, 'visitor');

  await createApp(forumSpace, { name: 'Forum', rootTemplate: 'main' });
  await createTemplate(forumSpace, { name: 'main', html: '<header>Forum</header><qu-slot name="content"></qu-slot>' });
  await createPage(forumSpace, { route: '/', title: 'Forum Start', template: 'main', content: '<p>Willkommen im Forum</p>' });
  await registerApp(relayAdminSpace, { prefix: 'forum', appAdminPub: forumAdmin.signingPub, name: 'Forum' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space: visitorSpace, relayAdminPub: relayAdmin.signingPub, mountEl, window, resolveTimeout: 500 });

  router.navigate('/forum/');
  await waitUntil(() => mountEl.innerHTML.includes('Willkommen im Forum'));
  assert.ok(mountEl.innerHTML.includes('<header>Forum</header>'));

  router.navigate('/does-not-exist');
  await waitUntil(() => mountEl.textContent.includes('Qu App Shell'));
  assert.ok(mountEl.querySelector('a[href="#/forum/"]'), 'the landing page must link to the one installed app');

  router.navigate('/admin/relay');
  await waitUntil(() => mountEl.textContent.includes('Relay-Admin'));
  assert.ok(mountEl.textContent.includes('nicht als Relay-Admin angemeldet'), 'a non-admin visitor sees the courtesy warning');
  assert.ok(mountEl.textContent.includes('Forum'), 'the admin console lists the already-registered app');

  router.stop();
});

test('the #/admin/relay console, booted AS the relay-admin, can register a second app through its own rendered form', async () => {
  const relayAdmin = await actor();
  const calendarAdmin = await actor();
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: calendarAdmin.signingPub, xPub: calendarAdmin.xPublicKey },
  ];

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ relayAdminPub: relayAdmin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const transport = new InProcessTransport(hub, 'relay-admin');
  await transport.connect();
  const relayAdminSpace = new Space({ identity: relayAdmin, members, transport });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin/relay' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space: relayAdminSpace, relayAdminPub: relayAdmin.signingPub, mountEl, window, resolveTimeout: 300 });

  await waitUntil(() => mountEl.textContent.includes('Relay-Admin'));
  assert.ok(!mountEl.textContent.includes('nicht als Relay-Admin angemeldet'), 'the actual relay-admin sees no warning');

  const form = mountEl.querySelector('form');
  form.querySelector('input[name="prefix"]').value = 'calendar';
  form.querySelector('input[name="appAdminPub"]').value = QuCrypto.toBase64(calendarAdmin.signingPub);
  form.querySelector('input[name="name"]').value = 'Kalender';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await new Promise((resolve) => setTimeout(resolve, 300)); // let the write actually leave and land

  const platformNodeId = await deriveOwnerNodeId(relayAdmin.signingPub, platformAppsKind.kind);
  const apps = relayAdminSpace.getNode(platformNodeId);
  const registered = await apps.field('apps').toArray();
  assert.ok(registered.some((a) => a.prefix === 'calendar' && a.name === 'Kalender'), 'submitting the admin form actually registered the app');

  router.stop();
});
