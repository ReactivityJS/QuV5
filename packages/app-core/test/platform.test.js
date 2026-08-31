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
import { createApp, createTemplate, createPage, registerApp } from '../src/dev.js';
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

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({
    appAdminPubs: [forumAdmin.signingPub, calendarAdmin.signingPub],
    relayAdminPub: relayAdmin.signingPub,
  });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
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

  const platform = new PlatformRuntime(visitorSpace, { relayAdminPub: relayAdmin.signingPub });

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
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ relayAdminPub: relayAdmin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const relayAdminTransport = new InProcessTransport(hub, 'relay-admin');
  await relayAdminTransport.connect();
  const relayAdminSpace = new Space({ identity: relayAdmin, members, transport: relayAdminTransport });
  await registerApp(relayAdminSpace, { prefix: 'forum', appAdminPub: appAdmin.signingPub, name: 'Forum' });

  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport });
  const platform = new PlatformRuntime(visitorSpace, { relayAdminPub: relayAdmin.signingPub });

  const match = await platform.resolveForPath('/forum/topic/123');
  assert.equal(match.prefix, 'forum');
  assert.equal(match.subPath, '/topic/123');
});
