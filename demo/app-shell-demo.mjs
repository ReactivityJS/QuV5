#!/usr/bin/env node
/**
 * APP SHELL DEMO — `npm run demo:app-shell`. The Phase-1 proof of concept
 * from docs/app-shell-arbeitsauftrag.md §32: a generic App Shell
 * (`@qu/app-shell`'s `startApp()`) loads an ENTIRE application - manifest,
 * routes, a template with slots, pages, and a stylesheet - purely from Qu
 * content, never from anything hardcoded in the Shell or the Relay. Same
 * "one process, zero setup, exits non-zero on mismatch" posture
 * `auto-demo.mjs` already established for the core framework - this is
 * that same idea one layer up, for the App Runtime.
 *
 * What it proves, end to end:
 *   - An "app-admin" identity bootstraps an empty Space into a working app
 *     using ONLY `@qu/app-core`'s Dev API (`createApp`/`createTemplate`/
 *     `createStyle`/`createPage`/`publishRoute`) - docs §25's "leere Shell
 *     -> Admin/Dev Console -> fertige Anwendung".
 *   - A completely separate "visitor" identity - never handed a single
 *     Node id directly, only the app-admin's PUBKEY - resolves and renders
 *     the SAME app through a real (in-process) relay
 *     (`createAppResolveKindSchema()`'s ACL wiring, docs §19-21).
 *   - `#/`-hash routing actually switches pages, each pulling its OWN
 *     template + content + the app's theme stylesheet from the Space
 *     (docs §6-11).
 *   - An unpublished route renders the framework's own "not found"
 *     fallback content instead of failing (docs §16).
 *   - Content sourced from the Space is sanitized before it ever reaches
 *     the DOM - a `<script>` smuggled into a page's content never survives
 *     into the rendered output (docs §17).
 */
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createTemplate, createStyle, createPage, publishRoute, createAppResolveKindSchema } from '@qu/app-core';
import { startApp } from '@qu/app-shell';

async function actor(name) {
  const kp = await QuCrypto.generateKeypair();
  const fingerprint = await QuCrypto.fingerprint(kp.publicKey);
  return { name, fingerprint, signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

async function main() {
  const appAdmin = await actor('app-admin');
  const visitor = await actor('visitor');
  const members = [
    { pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];

  console.log('Qu V5 — App Shell demo: an entire app, loaded purely from Qu content\n');
  console.log(`  app-admin  fingerprint: ${appAdmin.fingerprint}`);
  console.log(`  visitor    fingerprint: ${visitor.fingerprint}\n`);

  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: appAdmin.signingPub });
  const relay = createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'app-admin');
  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await adminTransport.connect();
  await visitorTransport.connect();

  const adminSpace = new Space({ identity: appAdmin, members, transport: adminTransport });
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport });

  console.log('--- app-admin bootstraps an empty Space into a working app (Dev API, docs §25) ---');
  await createApp(adminSpace, { name: 'Qu Demo App', rootTemplate: 'layout/main', defaultRoute: '/', theme: 'global' });
  await createTemplate(adminSpace, {
    name: 'layout/main',
    html: '<header>Qu Demo App</header><main><qu-slot name="content"></qu-slot></main><footer>gebaut aus Qu Content</footer>',
  });
  await createStyle(adminSpace, { name: 'global', css: 'body { font-family: sans-serif; margin: 2rem; }' });
  await createPage(adminSpace, { route: '/', title: 'Start', template: 'layout/main', content: '<p>Willkommen in der Qu App Shell.</p>' });
  await createPage(adminSpace, {
    route: '/hello',
    title: 'Hallo',
    template: 'layout/main',
    // a smuggled <script> - proves sanitizeHtml() strips it before it ever reaches the DOM (docs §17).
    content: '<p>Hallo aus dem Space!</p><script>globalThis.__hacked = true;</script>',
  });
  await publishRoute(adminSpace, { route: '/', title: 'Start' });
  await publishRoute(adminSpace, { route: '/hello', title: 'Hallo' });
  console.log('  Manifest, Route-Registry, 1 Template, 1 Style, 2 Pages veröffentlicht.\n');

  console.log('--- visitor boots the App Shell, knowing only app-admin\'s pubkey ---');
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://demo.test/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startApp({ space: visitorSpace, appAdminPub: appAdmin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.innerHTML.includes('Willkommen'));
  console.log(`  #/ gerendert. document.title = "${window.document.title}"`);
  console.log(`  ${mountEl.innerHTML}\n`);
  const rootOk = window.document.title === 'Start' && mountEl.innerHTML.includes('<header>Qu Demo App</header>');

  console.log('--- #/hello: content is loaded live from a DIFFERENT Page/Template resolution ---');
  router.navigate('/hello');
  await waitUntil(() => mountEl.innerHTML.includes('Hallo aus dem Space!'));
  console.log(`  #/hello gerendert. document.title = "${window.document.title}"`);
  const scriptStripped = !mountEl.innerHTML.includes('<script');
  console.log(`  ${scriptStripped ? '✅' : '❌'} Das eingeschleuste <script> wurde von @qu/app-renderer's sanitizeHtml() entfernt, bevor es ins DOM gelangte.\n`);

  console.log('--- #/does-not-exist: an unpublished route renders the framework fallback, not a crash ---');
  router.navigate('/does-not-exist');
  await waitUntil(() => mountEl.innerHTML.includes('404'));
  const notFoundOk = window.document.head.querySelector('style[data-qu-style="qu-app-theme"]') !== null;
  console.log(`  #/does-not-exist gerendert (404), Theme-Style weiterhin injiziert: ${notFoundOk}\n`);

  console.log(`(Der Relay hat ${relay.seen.length} Envelopes weitergeleitet/gespiegelt - qu-page.content ist bewusst 'visibility: public', der Relay sieht hier also Klartext-HTML, sperrt aber weiterhin per ACL, wer schreiben darf - siehe kinds.js.)`);

  router.stop();

  const ok = rootOk && scriptStripped && notFoundOk;
  console.log(`\n${ok ? '✅ App Shell Demo erfolgreich.' : '❌ App Shell Demo fehlgeschlagen.'}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
