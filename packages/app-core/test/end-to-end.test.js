/**
 * END TO END — the actual Phase-1 acceptance scenario (docs/
 * app-shell-arbeitsauftrag.md §32/§33): a real, separate "app-admin" peer
 * publishes an App Manifest + Route Registry + Page + Template + Style
 * through a real relay; an entirely unrelated "visitor" peer - a different
 * identity, a different Space instance, connected through the SAME relay -
 * resolves and reads all of it back, never having created any of it
 * itself. Proves `createAppResolveKindSchema()`'s relay-side ACL wiring is
 * actually correct, not just locally self-consistent (unlike
 * resolver.test.js/runtime.test.js, which read back through the SAME Space
 * that wrote - see those files' own doc comments).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { AppRuntime } from '../src/runtime.js';
import { ContentResolver } from '../src/resolver.js';
import { createApp, createTemplate, createStyle, createPage, publishRoute } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

test('a visitor who never authored anything resolves a full route through a real relay, knowing only the app-admin pubkey', async () => {
  const appAdmin = await actor();
  const visitor = await actor();
  // Space membership here is what a real deployment's relay `POST /join` (see
  // @qu/app-shell's identity.js) grows dynamically - both peers are members so 'members'-ACL
  // qu-page/qu-template/qu-style content is readable, exactly the tradeoff kinds.js documents.
  const members = [
    { pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: appAdmin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'app-admin');
  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await adminTransport.connect();
  await visitorTransport.connect();

  const adminSpace = new Space({ identity: appAdmin, members, transport: adminTransport });
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport });

  await createApp(adminSpace, { name: 'Qu Demo', rootTemplate: 'layout/main', defaultRoute: '/hello', theme: 'global' });
  await createTemplate(adminSpace, { name: 'layout/main', html: '<main><qu-slot name="content"></qu-slot></main>' });
  await createStyle(adminSpace, { name: 'global', css: 'body { font-family: sans-serif; }' });
  await createPage(adminSpace, { route: '/hello', title: 'Hallo Qu', template: 'layout/main', content: '<p>Hallo aus dem Space!</p>' });
  await publishRoute(adminSpace, { route: '/hello', title: 'Hallo Qu' });

  // The visitor knows NOTHING but appAdmin's pubkey - no node id was ever handed to it directly.
  const runtime = new AppRuntime(visitorSpace, { appAdminPub: appAdmin.signingPub });
  const plan = await runtime.resolveRoute('/hello');

  assert.equal(plan.manifest.name, 'Qu Demo');
  assert.equal(plan.page.title, 'Hallo Qu');
  assert.equal(plan.page.content, '<p>Hallo aus dem Space!</p>');
  assert.equal(plan.templateHtml, '<main><qu-slot name="content"></qu-slot></main>');
  assert.equal(plan.css, 'body { font-family: sans-serif; }');

  const routes = await runtime.resolveRoutes();
  assert.deepEqual(routes, [{ route: '/hello', title: 'Hallo Qu' }]);
});

/**
 * REGRESSION - the real installer shape (`demo/install-app-shell-demo.mjs`),
 * not the symmetric one above: the app-admin's OWN Space starts out knowing
 * ONLY itself and creates content BEFORE the visitor exists/joins at all -
 * exactly what caught kinds.js's `publicMeta()` bug while building the
 * first real-relay App Shell demo. Before that fix, `qu-page`/`qu-template`/
 * `qu-style`'s meta-stamp (their Y.Doc's very first update) sealed
 * `'encrypted'`-mode for whoever was a member at THAT moment (the app-admin
 * alone) - a later-joining visitor could never decrypt it, and because Yjs
 * integrates one author's updates as a strictly ordered, gapless sequence
 * (see grant.js's own "WRITE-BEFORE-GRANT IS A TRAP" doc comment), could
 * then never integrate ANY later update to that Node either, even though
 * every field on it is `visibility: 'public'`. The content would silently,
 * permanently never resolve for that visitor.
 */
test('a visitor who joins AFTER the app-admin already created content still reads it (regression: meta-stamp must not depend on write-time membership)', async () => {
  const appAdmin = await actor();
  const visitor = await actor();

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: appAdmin.signingPub });
  // The relay - and the app-admin's own Space - start out knowing ONLY the app-admin.
  const relay = createRelayForwarder({ hub, members: [{ pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey }], resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'app-admin-late');
  await adminTransport.connect();
  const adminSpace = new Space({ identity: appAdmin, members: [{ pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey }], transport: adminTransport });

  await createTemplate(adminSpace, { name: 'layout/late', html: '<main><qu-slot name="content"></qu-slot></main>' });
  await createPage(adminSpace, { route: '/late', title: 'Late', template: 'layout/late', content: '<p>late content</p>' });
  await new Promise((resolve) => setTimeout(resolve, 30)); // let the writes above actually reach the relay's mirror before the visitor subscribes.

  // ONLY NOW does the visitor join - unknown to the relay/app-admin while the content above was written.
  relay.addMember({ pub: visitor.signingPub, xPub: visitor.xPublicKey });
  const visitorTransport = new InProcessTransport(hub, 'visitor-late');
  await visitorTransport.connect();
  const visitorSpace = new Space({
    identity: visitor,
    members: [
      { pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey },
      { pub: visitor.signingPub, xPub: visitor.xPublicKey },
    ],
    transport: visitorTransport,
  });

  const resolver = new ContentResolver(visitorSpace, { appAdminPub: appAdmin.signingPub });
  const page = await resolver.resolvePage('/late');
  assert.ok(page, 'a late-joining visitor must still be able to read page content created before they joined');
  assert.equal(page.content, '<p>late content</p>');
  assert.equal(await resolver.resolveTemplate('layout/late'), '<main><qu-slot name="content"></qu-slot></main>');
});
