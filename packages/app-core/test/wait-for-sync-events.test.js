/**
 * SUBSCRIBE STATT POLLING — proves `resolver.js`'s `waitFor()` and
 * `dev.js`'s `waitForSync()` actually take the EVENT-DRIVEN path (real
 * `Space.bus` subscriptions on `space.node.<id>.changed`/`.sync-ack`, no
 * `setInterval`-style poll loop) when a `bus` is configured - the shape
 * `@qu/app-shell`'s `shell.js` always builds in production - not just the
 * pre-existing polling fallback every OTHER test in this package still
 * exercises (no test file here was changed to construct a bus-less Space
 * on purpose - that fallback path stays covered exactly as before).
 *
 * Two real (in-process relay, real network round-trip) peers throughout -
 * same reason `live-app-resolver.test.js` needs one for the settle-margin
 * race this reuses unchanged: a same-identity, same-Space resolve can
 * never exercise "an in-flight write from someone else."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { EventBus } from '@qu/events';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createApp, createPage, editPage, publishRoute } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { deriveContentNodeId } from '../src/content-id.js';
import { pageKind } from '../src/kinds.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

test('resolvePage() with a bus-equipped Space resolves a page a DIFFERENT peer just published, via the event-driven path', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [
    { pub: admin.signingPub, xPub: admin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'admin');
  await adminTransport.connect();
  const adminSpace = new Space({ identity: admin, members, transport: adminTransport });
  await createApp(adminSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createPage(adminSpace, { route: '/hello', title: 'Hello', content: '<p>hi</p>' });
  await publishRoute(adminSpace, { route: '/hello', title: 'Hello' });

  const visitorTransport = new InProcessTransport(hub, 'visitor');
  await visitorTransport.connect();
  const bus = new EventBus();
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport, bus });
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });

  const page = await resolver.resolvePage('/hello', { timeout: 2000 });
  assert.ok(page, 'the event-driven waitFor() should still resolve an already-published page');
  assert.equal(page.title, 'Hello');
  assert.equal(page.content, '<p>hi</p>');
});

test('resolvePage() with a bus-equipped Space resolves null for a genuinely never-published route, well within the configured timeout (the settle margin, not the full deadline)', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [
    { pub: admin.signingPub, xPub: admin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'admin2');
  await adminTransport.connect();
  const adminSpace = new Space({ identity: admin, members, transport: adminTransport });
  await createApp(adminSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });

  const visitorTransport = new InProcessTransport(hub, 'visitor2');
  await visitorTransport.connect();
  const bus = new EventBus();
  const visitorSpace = new Space({ identity: visitor, members, transport: visitorTransport, bus });
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });

  const startedAt = Date.now();
  const page = await resolver.resolvePage('/never-published', { timeout: 4000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(page, null);
  // Well under the full 4000ms timeout - the sync-ack + settle fast-path, not "burned the whole
  // deadline" (a generous margin over the 150ms default `settle` for in-process relay latency and
  // CI jitter, still far tighter than the configured timeout - this is the assertion that actually
  // distinguishes the event-driven path from a regression back to plain polling-to-timeout).
  assert.ok(elapsed < 2000, `expected the sync-ack fast-path to resolve well under the 4000ms timeout, took ${elapsed}ms`);
});

test('editPage() with a bus-equipped Space succeeds against a page synced moments earlier - the event-driven waitForSync(), not a timeout race', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const setupTransport = new InProcessTransport(hub, 'admin-setup');
  await setupTransport.connect();
  const setupSpace = new Space({ identity: admin, members, transport: setupTransport });
  await createApp(setupSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createPage(setupSpace, { route: '/hello', title: 'Hello', content: '<p>v1</p>' });

  // A FRESH Space/connection for the edit - the exact "resolved on one connection, edited moments
  // later on a fresh one" shape architecture.md §7's own documented production bug hit, just with a
  // real `bus` wired this time instead of relying purely on the plain poll-to-timeout fallback.
  const editTransport = new InProcessTransport(hub, 'admin-edit');
  await editTransport.connect();
  const bus = new EventBus();
  const editSpace = new Space({ identity: admin, members, transport: editTransport, bus });
  const id = await deriveContentNodeId(admin.signingPub, pageKind.kind, '/hello');

  // Wait for the relay's own `write-ack` before verifying - a fresh `useNode()`/`resolvePage()`
  // right after `editPage()` returns would race a SEPARATE, already-documented issue
  // (architecture.md §7's own "does not exist (or has not synced)" bug: `useNode()`'s ref-counted
  // teardown-on-release can tear down and re-subscribe from the relay's mirror BEFORE the edit's own
  // envelope has actually reached it) - not what THIS test is about, so side-step it by confirming
  // the write is durably acked first, exactly what a real save flow's own `verifyWritesAcked()`
  // (`@qu/app-shell`) already does for the identical reason.
  const acked = await new Promise((resolve) => {
    const off = bus.on(`space.node.${id}.write-ack`, () => {
      off();
      resolve(true);
    });
    editPage(editSpace, { route: '/hello', content: '<p>v2</p>', timeout: 3000 }).catch(() => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  assert.ok(acked, 'the edit should have been acked by the relay');

  const resolver = new ContentResolver(editSpace, { appAdminPub: admin.signingPub });
  const page = await resolver.resolvePage('/hello', { timeout: 2000 });
  assert.equal(page.content, '<p>v2</p>');
});
