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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createTemplate, createPage, registerApp, ContentResolver, platformAppsKind, PLATFORM_REGISTRY_ANCHOR } from '@qu/app-core';
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

  const hub = createInProcessHub();
  const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
  const relay = createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });
  await start({ hub, relayAdmins }); // AFTER createRelayForwarder(), same ordering relay-server.js's own main() uses.

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const relayAdminSpace = await connect(relayAdmin, 'relay-admin');
  const newAppAdminSpace = await connect(newAppAdmin, 'new-app-admin');
  const visitorSpace = await connect(visitor, 'visitor');

  await registerApp(relayAdminSpace, { prefix: 'newapp', appAdminPub: newAppAdmin.signingPub, name: 'New App' });

  // Wait for the RELAY to have actually processed (mirrored) the registration write, then give the
  // relay's own internal live-resolver Space (subscribed to the SAME registry Node) one tick to
  // receive the forwarded update and finish rebuilding its appAdminPubs set - both happen over the
  // SAME in-process hub, no real network latency, but still genuinely asynchronous.
  const platformNodeId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
  await waitUntil(() => relay.seen.some((e) => e.nodeId === platformNodeId));
  await new Promise((resolve) => setTimeout(resolve, 50));

  await createApp(newAppAdminSpace, { name: 'New App', rootTemplate: 'main' });
  await createTemplate(newAppAdminSpace, { name: 'main', html: '<qu-slot name="content"></qu-slot>' });
  await createPage(newAppAdminSpace, { route: '/', title: 'Hallo', template: 'main', content: '<p>Live registriert</p>' });

  // The visitor never wrote anything - if this resolves, it can only be because the relay actually
  // accepted, mirrored, and forwarded the new app-admin's writes (this Space's own independent ACL
  // re-verification, @qu/space-core's own `_isAuthorizedWriter()`, would otherwise silently drop them).
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: newAppAdmin.signingPub });
  const page = await resolver.resolvePage('/', { timeout: 1500 });

  assert.equal(page?.title, 'Hallo', "the newly-registered app-admin's content resolves for a DIFFERENT peer - the live resolver reclassified their Nodes without a relay restart");
});
