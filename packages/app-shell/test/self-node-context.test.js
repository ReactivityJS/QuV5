/**
 * SELF-NODE CONTEXT (Phase 5) — proves the full chain end to end: a Page's
 * own content can declare `<qu-view self field="title">` (or `<qu-bind
 * self field="...">`) WITHOUT knowing this page's own content-addressed
 * node id - `resolver.js`'s `resolvePage()` returns `{nodeId, kindSchema}`
 * alongside the plain fields, `boot.js` sets `mountEl.quSelfNodeId`/
 * `.quSelfKind` on every render (`context.js`'s own doc comment), and
 * `@qu/space-components`'s `resolveNodeRef()` resolves the `self`
 * attribute against that ancestor context - genuinely live (updates the
 * rendered DOM the instant the field changes, no navigation/re-render
 * needed), the same "declarative reactivity, no app-specific JS" promise
 * the rest of the framework already makes for Views/registered sections.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createPage, editPage, publishRoute, createAppResolveKindSchema } from '@qu/app-core';
import { startApp } from '../src/boot.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('<qu-view self field="title"> in a Page\'s own content binds to THIS page - no node id known or typed anywhere - and stays live across an edit', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const transport = new InProcessTransport(hub, 'admin');
  await transport.connect();
  const space = new Space({ identity: admin, members, transport });
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createPage(space, { route: '/hello', title: 'V1 Title', content: '<h1><qu-view self field="title"></qu-view></h1>' });
  await publishRoute(space, { route: '/hello', title: 'V1 Title' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/hello' });
  const mountEl = window.document.querySelector('qu-app-shell');
  // `qu-view.js`/`elements.js` bind to whichever `HTMLElement`/`customElements` were global at
  // MODULE-EVALUATION time (`class QuView extends HTMLElement`, `customElements.define()` both run
  // at the top level) - set THIS test's own window's globals first, then dynamic-import the
  // registration side effect, exactly the ordering `shell.js`'s own real-browser
  // `import '@qu/space-components/elements'` gets for free (there, `window` already IS the global).
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.customElements = window.customElements;
  globalThis.Node = window.Node;
  await import('@qu/space-components/elements');

  startApp({ space, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('qu-view'));
  await waitUntil(() => mountEl.querySelector('qu-view')?.textContent === 'V1 Title');
  assert.ok(mountEl.quSelfNodeId, 'boot.js should have set a self-node id for this page render');

  await editPage(space, { route: '/hello', title: 'V2 Title', timeout: 2000 });
  await waitUntil(() => mountEl.querySelector('qu-view')?.textContent === 'V2 Title');
});
