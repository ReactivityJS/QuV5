/**
 * PLATFORM RUNTIME — proves the multi-app routing story end to end
 * through a real relay: a relay-admin registers TWO independent apps
 * (each with its OWN app-admin identity/content) under different path
 * prefixes; a visitor who authored nothing resolves both, and an
 * unregistered prefix resolves to `null` (the caller's 404 signal).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { PlatformRuntime } from '../src/platform.js';
import { AppRuntime } from '../src/runtime.js';
import { createApp, createTemplate, createPage, registerApp, setAppMode, setPlatformConfig } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

test('a visitor resolves TWO independent apps mounted at different prefixes, through one relay-admin registry', async () => {
  const relayAdmin = await actor();
  const forumAdmin = await actor();
  const calendarAdmin = await actor();
  const visitor = await actor();

  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: forumAdmin.signingPub, xPub: forumAdmin.xPublicKey },
    { pub: calendarAdmin.signingPub, xPub: calendarAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({
    appAdminPubs: [forumAdmin.signingPub, calendarAdmin.signingPub],
  });
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const relayAdminSpace = await connect(relayAdmin, 'relay-admin');
  const forumSpace = await connect(forumAdmin, 'forum-admin');
  const calendarSpace = await connect(calendarAdmin, 'calendar-admin');
  const visitorSpace = await connect(visitor, 'visitor');

  await createApp(forumSpace, { name: 'Forum', rootTemplate: 'main' });
  await createTemplate(forumSpace, { name: 'main', html: '<qu-slot name="content"></qu-slot>' });
  await createPage(forumSpace, { route: '/', title: 'Forum Start', template: 'main', content: '<p>Willkommen im Forum</p>' });

  await createApp(calendarSpace, { name: 'Kalender', rootTemplate: 'main' });
  await createTemplate(calendarSpace, { name: 'main', html: '<qu-slot name="content"></qu-slot>' });
  await createPage(calendarSpace, { route: '/', title: 'Kalender Start', template: 'main', content: '<p>Termine</p>' });

  await registerApp(relayAdminSpace, { prefix: 'forum', appAdminPub: forumAdmin.signingPub, name: 'Forum' });
  await registerApp(relayAdminSpace, { prefix: 'calendar', appAdminPub: calendarAdmin.signingPub, name: 'Kalender' });

  const platform = new PlatformRuntime(visitorSpace);

  const forumMatch = await platform.resolveForPath('/forum/');
  assert.equal(forumMatch.name, 'Forum');
  assert.equal(forumMatch.subPath, '/');
  const forumRuntime = new AppRuntime(visitorSpace, { appAdminPub: forumMatch.appAdminPub });
  const forumPlan = await forumRuntime.resolveRoute(forumMatch.subPath);
  assert.equal(forumPlan.page.title, 'Forum Start');
  assert.equal(forumPlan.page.content, '<p>Willkommen im Forum</p>');

  const calendarMatch = await platform.resolveForPath('/calendar/');
  assert.equal(calendarMatch.name, 'Kalender');
  const calendarRuntime = new AppRuntime(visitorSpace, { appAdminPub: calendarMatch.appAdminPub });
  const calendarPlan = await calendarRuntime.resolveRoute(calendarMatch.subPath);
  assert.equal(calendarPlan.page.title, 'Kalender Start');

  const noMatch = await platform.resolveForPath('/does-not-exist', { timeout: 50 });
  assert.equal(noMatch, null);
});

test('resolveForPath() splits a nested route into (prefix, subPath) correctly', async () => {
  const relayAdmin = await actor();
  const appAdmin = await actor();
  const visitor = await actor();
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  const relayAdminTransport = new InProcessTransport(hub, 'relay-admin');
  await relayAdminTransport.connect();
  const relayAdminSpace = new Space({ identity: relayAdmin, members, relayAdmins, transport: relayAdminTransport });
  await registerApp(relayAdminSpace, { prefix: 'forum', appAdminPub: appAdmin.signingPub, name: 'Forum' });

  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const visitorSpace = new Space({ identity: visitor, members, relayAdmins, transport: visitorTransport });
  const platform = new PlatformRuntime(visitorSpace);

  const match = await platform.resolveForPath('/forum/topic/123');
  assert.equal(match.prefix, 'forum');
  assert.equal(match.subPath, '/topic/123');
});

test('setAppMode() works right after registerApp(), over a FRESH Space connection for the same relay-admin identity - regression for the "not a registered app" bug', async () => {
  // Reproduces a real, reported failure: an admin console's mode-toggle button called
  // `setAppMode()` right after `registerApp()`, over a Space that had just freshly resubscribed
  // to the shared `qu-platform-apps` registry Node (e.g. after a page reload, or after
  // `PlatformRuntime.resolveApps()` released its own hold on it) - a weak sync gate in
  // `dev.js`'s `getOrSyncRegistryNode()` (meta-stamp only) let `setAppMode()` read the `apps`
  // list before the relay had fully replayed every entry, so the just-registered prefix looked
  // unregistered. `getOrSyncRegistryNode()`/`PlatformRuntime.resolveApps()` now both gate on
  // `space.isNodeSynced()` instead - this test registers several global apps, then immediately
  // (no delay) calls `setAppMode()` for the LAST one, over a brand new connection/Space instance.
  const relayAdmin = await actor();
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity: relayAdmin, members, relayAdmins, transport });
  }

  const setupSpace = await connect('relay-admin-setup');
  await registerApp(setupSpace, { prefix: 'guestbook', name: 'Gästebuch', realm: 'global', mode: 'global' });
  await registerApp(setupSpace, { prefix: 'forum', name: 'Forum', realm: 'global', mode: 'global' });
  await registerApp(setupSpace, { prefix: 'blog', name: 'Blog', realm: 'global', mode: 'global' });

  // A FRESH Space/connection - simulates a reloaded admin console, not the same in-memory
  // instance `registerApp()` above already has a warm, fully-synced local subscription on.
  const freshSpace = await connect('relay-admin-fresh');
  await setAppMode(freshSpace, { prefix: 'blog', mode: 'multiuser' });

  const platform = new PlatformRuntime(freshSpace);
  const apps = await platform.resolveApps();
  const blog = apps.find((a) => a.prefix === 'blog');
  assert.equal(blog?.mode, 'multiuser');
});

test('setPlatformConfig()/resolvePlatformConfig() - a relay-admin\'s platform-wide setting reaches a DIFFERENT, already-connected visitor Space live, and later keys merge rather than clobber', async () => {
  const relayAdmin = await actor();
  const visitor = await actor();
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const adminSpace = await connect(relayAdmin, 'relay-admin');
  const visitorSpace = await connect(visitor, 'visitor');
  const visitorPlatform = new PlatformRuntime(visitorSpace);

  // Nothing set yet - `{}`, never null/undefined, so a caller can destructure straight off it.
  assert.deepEqual(await visitorPlatform.resolvePlatformConfig(), {});

  await setPlatformConfig(adminSpace, { richTextEditor: true });
  await new Promise((resolve) => setTimeout(resolve, 300)); // settle - let the write reach the visitor's own Space.
  assert.deepEqual(await visitorPlatform.resolvePlatformConfig(), { richTextEditor: true });

  // A LATER call setting a DIFFERENT key merges in, rather than clobbering `richTextEditor` -
  // same "whole-object read-merge-write" contract `setAppConfig()` already has one level down
  // (kinds.js's own `platformConfig` doc comment).
  await setPlatformConfig(adminSpace, { someOtherFlag: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await visitorPlatform.resolvePlatformConfig(), { richTextEditor: true, someOtherFlag: 'x' });

  // Setting the SAME key again overwrites just that key.
  await setPlatformConfig(adminSpace, { richTextEditor: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await visitorPlatform.resolvePlatformConfig(), { richTextEditor: false, someOtherFlag: 'x' });
});
