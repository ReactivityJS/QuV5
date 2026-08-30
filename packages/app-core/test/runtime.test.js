import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { AppRuntime } from '../src/runtime.js';
import { createApp, createTemplate, createStyle, createPage } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function setupSpace(identity) {
  const hub = createInProcessHub();
  const members = [{ pub: identity.signingPub, xPub: identity.xPublicKey }];
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: identity.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  const transport = new InProcessTransport(hub, 'peer');
  await transport.connect();
  return new Space({ identity, members, transport });
}

test('resolveRoute() assembles manifest + page + its own template + the manifest theme style', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: 'layout/main', theme: 'global' });
  await createTemplate(space, { name: 'layout/main', html: '<qu-slot name="content"></qu-slot>' });
  await createStyle(space, { name: 'global', css: 'body{margin:0}' });
  await createPage(space, { route: '/hello', title: 'Hallo', template: 'layout/main', content: '<p>Hi</p>' });

  const runtime = new AppRuntime(space, { appAdminPub: admin.signingPub });
  const plan = await runtime.resolveRoute('/hello');

  assert.equal(plan.manifest.name, 'Demo');
  assert.equal(plan.page.title, 'Hallo');
  assert.equal(plan.templateHtml, '<qu-slot name="content"></qu-slot>');
  assert.equal(plan.css, 'body{margin:0}');
});

test('resolveRoute() falls back to the manifest rootTemplate when a page declares none', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: 'layout/main' });
  await createTemplate(space, { name: 'layout/main', html: '<qu-slot name="content"></qu-slot>' });
  await createPage(space, { route: '/', title: 'Start', content: '<p>Start</p>' }); // no template declared

  const runtime = new AppRuntime(space, { appAdminPub: admin.signingPub });
  const plan = await runtime.resolveRoute('/', { timeout: 300 });
  assert.equal(plan.templateHtml, '<qu-slot name="content"></qu-slot>');
});

test('resolveRoute() returns a null page for an unpublished route - the caller\'s cue to render a fallback', async () => {
  const admin = await actor();
  const space = await setupSpace(admin);
  await createApp(space, { name: 'Demo', rootTemplate: 'layout/main' });

  const runtime = new AppRuntime(space, { appAdminPub: admin.signingPub });
  const plan = await runtime.resolveRoute('/nope', { timeout: 50 });
  assert.equal(plan.page, null);
});
