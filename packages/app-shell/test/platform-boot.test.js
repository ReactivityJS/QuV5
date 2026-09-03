/**
 * PLATFORM BOOT — `startPlatform()` (boot.js), revised for the two-realm
 * design (architecture.md §7): a registered app resolves through the MAIN
 * Space as before; an UNREGISTERED app resolves too, via its own owner id,
 * with zero relay-admin involvement (the new default-routing fallback); an
 * unmatched route falls back to a landing page; and the built-in admin
 * console is now genuinely installed Qu CONTENT (`admin-console-bundle.js`)
 * living in a SEPARATE, confidentially-membered Space - resolved and
 * rendered through the exact same `AppRuntime`/`renderPage()` pipeline as
 * any other app, with `admin-actions.js`'s `wireAdminConsole()` as the only
 * framework-provided interactivity layered on top (never a `<script>`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import {
  createApp,
  createTemplate,
  createPage,
  registerApp,
  installAdminAppBundle,
  createAppResolveKindSchema,
  createAdminResolveKindSchema,
  platformAppsKind,
  PLATFORM_REGISTRY_ANCHOR,
} from '@qu/app-core';
import { startPlatform } from '../src/boot.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

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

test('startPlatform() resolves a REGISTERED app by alias, an UNREGISTERED app by its own owner id, and falls back to a landing page', async () => {
  const relayAdmin = await actor();
  const forumAdmin = await actor();
  const soloAdmin = await actor(); // never registered as an alias - reachable only via its own owner id.
  const visitor = await actor();
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: forumAdmin.signingPub, xPub: forumAdmin.xPublicKey },
    { pub: soloAdmin.signingPub, xPub: soloAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({
    appAdminPubs: [forumAdmin.signingPub, soloAdmin.signingPub],
  });
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const relayAdminSpace = await connect(relayAdmin, 'relay-admin');
  const forumSpace = await connect(forumAdmin, 'forum-admin');
  const soloSpace = await connect(soloAdmin, 'solo-admin');
  const visitorSpace = await connect(visitor, 'visitor');

  await createApp(forumSpace, { name: 'Forum', rootTemplate: 'main' });
  await createTemplate(forumSpace, { name: 'main', html: '<header>Forum</header><qu-slot name="content"></qu-slot>' });
  await createPage(forumSpace, { route: '/', title: 'Forum Start', template: 'main', content: '<p>Willkommen im Forum</p>' });
  await registerApp(relayAdminSpace, { prefix: 'forum', appAdminPub: forumAdmin.signingPub, name: 'Forum' });

  await createApp(soloSpace, { name: 'Solo', rootTemplate: 'main' });
  await createTemplate(soloSpace, { name: 'main', html: '<qu-slot name="content"></qu-slot>' });
  await createPage(soloSpace, { route: '/', title: 'Solo Start', template: 'main', content: '<p>Ganz ohne Registrierung erreichbar</p>' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space: visitorSpace, mountEl, window, resolveTimeout: 500 });

  router.navigate('/forum/');
  await waitUntil(() => mountEl.innerHTML.includes('Willkommen im Forum'));
  assert.ok(mountEl.innerHTML.includes('<header>Forum</header>'));

  const soloId = QuCrypto.toBase64Url(soloAdmin.signingPub);
  router.navigate(`/${soloId}/`);
  await waitUntil(() => mountEl.innerHTML.includes('Ganz ohne Registrierung erreichbar'));

  router.navigate('/does-not-exist');
  await waitUntil(() => mountEl.textContent.includes('Qu App Shell'));
  assert.ok(mountEl.querySelector('a[href="#/forum/"]'), 'the landing page lists the registered alias');

  router.stop();
});

test('the built-in admin console is genuine installed content in a separate, confidentially-membered Space - a real admin sees and uses it, a non-admin gets a plain 404', async () => {
  const relayAdmin = await actor();
  const calendarAdmin = await actor();
  const outsider = await actor();
  const mainMembers = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: outsider.signingPub, xPub: outsider.xPublicKey },
  ];
  const adminMembers = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }]; // outsider is NOT an admin-realm member.

  const relayAdmins = [relayAdmin.signingPub];
  const mainHub = createInProcessHub();
  const mainResolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub: mainHub, members: mainMembers, relayAdmins, resolveKindSchema: mainResolveKindSchema, storage: createMemoryStore() });

  const adminHub = createInProcessHub();
  const adminResolveKindSchema = await createAdminResolveKindSchema();
  createRelayForwarder({ hub: adminHub, members: adminMembers, resolveKindSchema: adminResolveKindSchema, storage: createMemoryStore() });

  async function connectMain(identity, peerId) {
    const transport = new InProcessTransport(mainHub, peerId);
    await transport.connect();
    return new Space({ identity, members: mainMembers, relayAdmins, transport });
  }
  async function connectAdmin(identity, peerId) {
    const transport = new InProcessTransport(adminHub, peerId);
    await transport.connect();
    return new Space({ identity, members: adminMembers, transport });
  }

  // Bootstrap, as the relay-admin: install the console's own content into the admin realm, then
  // register the "admin" alias in the MAIN space - see bin/install-admin-console.mjs for the real,
  // two-process version of exactly these two steps.
  const relayAdminMainSpace = await connectMain(relayAdmin, 'relay-admin-main');
  const relayAdminAdminSpace = await connectAdmin(relayAdmin, 'relay-admin-admin');
  await installAdminAppBundle(relayAdminAdminSpace, adminConsoleBundle);
  await registerApp(relayAdminMainSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'admin' });

  // A REAL admin visits #/admin: gets a second Space connected to the admin realm (as the real
  // shell.js would), sees the installed content, and can register a new app THROUGH the rendered
  // form (proving the content-driven write path end to end, not just its markup).
  {
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
    const mountEl = window.document.querySelector('qu-app-shell');
    const mainSpace = await connectMain(relayAdmin, 'relay-admin-visit');
    const { router } = startPlatform({
      space: mainSpace,
      connectAdminSpace: () => connectAdmin(relayAdmin, 'relay-admin-visit-admin'),
      mountEl,
      window,
      resolveTimeout: 500,
    });

    await waitUntil(() => mountEl.textContent.includes('Relay-Admin'));
    assert.ok(mountEl.querySelector('form[data-qu-action="register-app"]'), 'the console is rendered from installed content, not hardcoded DOM-building');

    const form = mountEl.querySelector('form');
    form.querySelector('input[name="prefix"]').value = 'calendar';
    form.querySelector('input[name="appAdminPub"]').value = QuCrypto.toBase64(calendarAdmin.signingPub);
    form.querySelector('input[name="name"]').value = 'Kalender';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await new Promise((resolve) => setTimeout(resolve, 300)); // let the write actually leave and land.

    const platformNodeId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
    const apps = await relayAdminMainSpace.getNode(platformNodeId).field('apps').toArray();
    assert.ok(apps.some((a) => a.prefix === 'calendar' && a.name === 'Kalender'), 'submitting the content-driven form actually registered the app');

    router.stop();
  }

  // An OUTSIDER (never a member of the admin realm's own Space) visits #/admin: the alias resolves
  // (aliases are public metadata, not secret - kinds.js's own `platformAppsKind` doc comment), and a
  // Space connection to the admin realm is even attempted (proving this isn't just a client-side
  // courtesy check), but the relay's OWN subscribe-gate + the content's `'encrypted'` visibility mean
  // nothing decrypts - the visitor gets the framework's ordinary "not found", never admin content.
  {
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
    const mountEl = window.document.querySelector('qu-app-shell');
    const mainSpace = await connectMain(outsider, 'outsider-main');
    const { router } = startPlatform({
      space: mainSpace,
      connectAdminSpace: () => connectAdmin(outsider, 'outsider-admin'),
      mountEl,
      window,
      resolveTimeout: 300,
    });

    await waitUntil(() => mountEl.innerHTML.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the (doomed) resolve attempt finish.
    assert.ok(mountEl.textContent.includes('404'), 'an outsider sees the plain not-found fallback, never admin content');
    assert.ok(!mountEl.textContent.includes('Kalender'), 'the outsider learns nothing about the admin realm\'s own content');

    router.stop();
  }
});
