/**
 * INSTALL APP BUNDLE — proves `installAppBundle()` (a declarative
 * `{manifest, templates, styles, pages, routes}` object - "eine App in ein
 * Package packen") installs exactly what the equivalent sequence of
 * individual `createApp()`/`createTemplate()`/... calls would, readable
 * back through `AppRuntime` exactly like any other app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { AppRuntime } from '../src/runtime.js';
import { installAppBundle } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

const HELLO_BUNDLE = {
  manifest: { name: 'Hello Bundle App', rootTemplate: 'layout/main', defaultRoute: '/', theme: 'global' },
  templates: [{ name: 'layout/main', html: '<header>Hello Bundle</header><qu-slot name="content"></qu-slot>' }],
  styles: [{ name: 'global', css: 'body{margin:0}' }],
  pages: [
    { route: '/', title: 'Start', template: 'layout/main', content: '<p>aus einem Bundle installiert</p>' },
    { route: '/about', title: 'About', template: 'layout/main', content: '<p>about page</p>' },
  ],
  routes: [
    { route: '/', title: 'Start' },
    { route: '/about', title: 'About' },
  ],
};

test('installAppBundle() installs a whole app from one declarative object, readable back through AppRuntime', async () => {
  const appAdmin = await actor();
  const visitor = await actor();
  const members = [
    { pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: appAdmin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'admin');
  await adminTransport.connect();
  const adminSpace = new Space({ identity: appAdmin, members, transport: adminTransport });

  await installAppBundle(adminSpace, HELLO_BUNDLE);

  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport });
  const runtime = new AppRuntime(visitorSpace, { appAdminPub: appAdmin.signingPub });

  const home = await runtime.resolveRoute('/');
  assert.equal(home.manifest.name, 'Hello Bundle App');
  assert.equal(home.page.content, '<p>aus einem Bundle installiert</p>');
  assert.equal(home.templateHtml, '<header>Hello Bundle</header><qu-slot name="content"></qu-slot>');
  assert.equal(home.css, 'body{margin:0}');

  const about = await runtime.resolveRoute('/about');
  assert.equal(about.page.title, 'About');

  const routes = await runtime.resolveRoutes();
  assert.deepEqual(
    routes.map((r) => r.route).sort(),
    ['/', '/about']
  );
});
