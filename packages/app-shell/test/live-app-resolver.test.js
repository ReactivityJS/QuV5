/**
 * LIVE APP-ADMIN RESOLVER — the actual regression this file exists for: a
 * relay-admin registers a BRAND NEW app-admin (`registerApp()`) on an
 * ALREADY RUNNING relay, and that app-admin's `qu-app`/registry writes
 * become visible to a COMPLETELY DIFFERENT peer (a visitor who wrote
 * nothing itself, so only a real relay round-trip - not the writer's own
 * local state - can explain it seeing anything) through the SAME relay,
 * with NO restart and NO separate static `appAdminPubs` list -
 * `qu-platform-apps` (now `'relay-admins'`-ACL, see `@qu/app-core`'s
 * kinds.js own doc comment) is the only config this relay needed. Proves
 * `live-app-resolver.js`'s own core claim, not just that it doesn't throw.
 *
 * Runs over a REAL WebSocket server on a real (loopback) TCP port, same
 * pattern `@qu/space-transport`'s own `ws-relay.test.js` uses - required
 * here specifically because `live-app-resolver.js` connects to ITSELF as
 * an ordinary client (see that file's own "WHY A REAL SOCKET" doc
 * comment), which an in-process hub cannot serve (`createWsServerHub()`
 * has no local-peer registration API, unlike the in-process test hub).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import {
  createApp,
  createTemplate,
  createPage,
  registerApp,
  ContentResolver,
  platformAppsKind,
  PLATFORM_REGISTRY_ANCHOR,
  createGlobalApp,
  createGlobalTemplate,
  createGlobalPage,
  publishGlobalRoute,
  adminPageKind,
  adminTemplateKind,
  globalAppAnchor,
} from '@qu/app-core';
import { createLiveAppResolveKindSchema } from '../src/live-app-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

test('a relay-admin registers a brand-new app-admin at runtime; a DIFFERENT visitor peer resolves their content through the SAME relay with no restart and no static appAdminPubs list', async () => {
  const relayAdmin = await actor();
  const newAppAdmin = await actor();
  const visitor = await actor();
  const relayAdmins = [relayAdmin.signingPub];
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: newAppAdmin.signingPub, xPub: newAppAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
  // `storage` matters here, not just cosmetically: EVERY real deployment
  // (`@qu/app-shell`'s own relay-server.js) always mirrors durable-persistence
  // writes to disk (`createFileStore()`) - a late subscriber's `handleSubscribe()`
  // replays from THAT mirror regardless of when its own subscribe happened to
  // arrive relative to the write. Omitting `storage` here (as an earlier version
  // of this test did) makes the assertion below depend on a genuine, accidental
  // NETWORK RACE instead (whether the write or the late subscribe reaches the
  // relay first) - not a reflection of anything this test is actually meant to
  // verify, and NOT how a real relay behaves. A plain in-memory store is enough
  // to remove that race; a real `createFileStore()` isn't needed for a unit test.
  const relay = createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  await new Promise((resolve) => httpServer.listen(0, resolve)); // port 0 = OS picks a free port
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;

  await start({ url, relayAdmins }); // AFTER the server is actually listening - see relay-server.js's own main() for the same ordering.

  async function connect(identity) {
    const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const relayAdminSpace = await connect(relayAdmin);
  const newAppAdminSpace = await connect(newAppAdmin);
  const visitorSpace = await connect(visitor);

  await registerApp(relayAdminSpace, { prefix: 'newapp', appAdminPub: newAppAdmin.signingPub, name: 'New App' });

  // Wait for the RELAY to have actually processed (mirrored) the registration write, then give the
  // relay's own internal live-resolver Space (subscribed to the SAME registry Node) one tick to
  // receive the forwarded update and finish rebuilding its appAdminPubs set - both happen over the
  // network, so a small settle delay is needed even after the write itself is confirmed seen.
  const platformNodeId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
  const seen = await waitUntil(() => relay.seen.some((e) => e.nodeId === platformNodeId));
  assert.ok(seen, 'the registerApp() write reached the relay');
  await new Promise((resolve) => setTimeout(resolve, 150));

  await createApp(newAppAdminSpace, { name: 'New App', rootTemplate: 'main' });
  await createTemplate(newAppAdminSpace, { name: 'main', html: '<qu-slot name="content"></qu-slot>' });
  await createPage(newAppAdminSpace, { route: '/', title: 'Hallo', template: 'main', content: '<p>Live registriert</p>' });

  // The visitor never wrote anything - if this resolves, it can only be because the relay actually
  // accepted, mirrored, and forwarded the new app-admin's writes (this Space's own independent ACL
  // re-verification, @qu/space-core's own `_isAuthorizedWriter()`, would otherwise silently drop them).
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: newAppAdmin.signingPub });
  const page = await resolver.resolvePage('/', { timeout: 2000 });

  assert.equal(page?.title, 'Hallo', "the newly-registered app-admin's content resolves for a DIFFERENT peer - the live resolver reclassified their Nodes without a relay restart");

  // The live resolver's own internal Space keeps its self-connection open for this relay process's
  // entire lifetime BY DESIGN (see live-app-resolver.js's own doc comment) - httpServer.close()'s
  // callback otherwise never fires (Node waits for every connection to end), so every remaining
  // WebSocket (that one included) is force-terminated first, same as a real process exit would do.
  wss.clients.forEach((ws) => ws.terminate());
  await new Promise((resolve) => httpServer.close(resolve));
});

test('a relay-admin registers a brand-new GLOBAL app ("admin") at runtime, publishes its route, and its template+page resolve correctly for a DIFFERENT relay-admin - the exact regression a fixed bug once broke in production', async () => {
  // Real, production-observed regression this guards against: once live-app-resolver.js starts
  // rebuilding reactively, it ALWAYS passes an explicit `globalApps` array to
  // createAppResolveKindSchema() - silently bypassing that function's own STATIC default (which
  // otherwise supplies `templateNames: ['main']` for prefix "admin", matching what
  // admin-console-bundle.js ships) - so the admin console's own "main" template got silently
  // misclassified and rejected by the relay the moment PLATFORM mode's live resolver took over,
  // even though the exact same content worked fine through the non-reactive, static resolver a
  // unit test alone would exercise. This test goes through the REAL live-app-resolver.js, the only
  // way to actually catch it.
  const relayAdminA = await actor();
  const relayAdminB = await actor(); // a DIFFERENT relay-admin - proves this isn't just "the writer reads back its own local state."
  const relayAdmins = [relayAdminA.signingPub, relayAdminB.signingPub];
  const members = [
    { pub: relayAdminA.signingPub, xPub: relayAdminA.xPublicKey },
    { pub: relayAdminB.signingPub, xPub: relayAdminB.xPublicKey },
  ];

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
  // See the first test's own comment on why `storage` is required here: without it, whether the
  // page/template below actually resolve for `spaceB` depends on an accidental race between its
  // own (late) subscribe and spaceA's writes reaching the relay - not on whether the CLASSIFICATION
  // fix this test exists to verify actually works. Real deployments always mirror durable writes.
  const relay = createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;
  await start({ url, relayAdmins });

  async function connect(identity) {
    const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const spaceA = await connect(relayAdminA);
  const spaceB = await connect(relayAdminB);

  await registerApp(spaceA, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  const platformNodeId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
  assert.ok(await waitUntil(() => relay.seen.some((e) => e.nodeId === platformNodeId)), 'the registerApp() write reached the relay');
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the relay start watching "admin"'s own route registry.

  await publishGlobalRoute(spaceA, 'admin', { route: '/', title: 'Relay-Admin' });
  const anchor = await globalAppAnchor('admin');
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the relay observe the new route before content writes follow.

  await createGlobalApp(spaceA, 'admin', { name: 'Relay-Admin', rootTemplate: 'main', defaultRoute: '/' });
  await createGlobalTemplate(spaceA, 'admin', { name: 'main', html: '<header>ADMIN</header><qu-slot name="content"></qu-slot>' });
  await createGlobalPage(spaceA, 'admin', { route: '/', title: 'Relay-Admin', template: 'main', content: '<p>Konsole</p>' });

  // A DIFFERENT relay-admin (never wrote anything above) resolves BOTH the page AND its template -
  // the template check is what the regression actually broke (the page alone could still resolve
  // while the template silently failed, rendering through @qu/app-renderer's template-not-found
  // fallback instead of the real one).
  const resolver = new ContentResolver(spaceB, { appAdminPub: anchor, kinds: { pageKind: adminPageKind, templateKind: adminTemplateKind } });
  const page = await resolver.resolvePage('/', { timeout: 2000 });
  assert.equal(page?.title, 'Relay-Admin', 'the global app\'s page resolves for a different relay-admin');
  assert.equal(page?.content, '<p>Konsole</p>');

  const template = await resolver.resolveTemplate('main', { timeout: 2000 });
  assert.ok(template?.includes('ADMIN'), 'the global app\'s "main" template resolves too - this is the part the regression actually broke');

  wss.clients.forEach((ws) => ws.terminate());
  await new Promise((resolve) => httpServer.close(resolve));
});
