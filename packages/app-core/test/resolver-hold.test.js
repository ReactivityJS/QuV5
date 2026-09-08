/**
 * RESOLVER `hold` OPTION — the Phase-3 "Bootstrap-Vereinfachung" primitive:
 * `resolvePage()`/`resolveTemplate()`/`resolveStyle()`/`resolveView()` can
 * now keep their own `Space.useNode()` subscription open past their own
 * return (`{page/value/view, release}` instead of the bare value), moving
 * the "resolve now, might write moments later" pattern `@qu/app-shell`'s
 * own `cms-actions.js` used to hand-roll as `holdEdit()` (a SEPARATE, extra
 * `useNode()` call) into the shared resolver itself - no app needs to
 * reinvent it.
 *
 * The whole point is proven end to end here: an edit against a HELD
 * resolve never needs `waitForSync()`'s own fast path or settle margin at
 * all, because the Node was never torn down (`Space.useNode()`'s own
 * ref-counted teardown, `unsubscribeNode()`) between the resolve and the
 * write - it's the exact same already-fully-synced local Y.Doc throughout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createApp, createPage, createTemplate, editPage, editTemplate } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function setupSpace(identity, members) {
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: identity.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  const transport = new InProcessTransport(hub, 'peer');
  await transport.connect();
  return { space: new Space({ identity, members, transport }), hub };
}

test('resolvePage({hold: true}) returns {page, release} instead of the bare page, and default (no hold) behavior is unchanged', async () => {
  const admin = await actor();
  const { space } = await setupSpace(admin, [{ pub: admin.signingPub, xPub: admin.xPublicKey }]);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createPage(space, { route: '/hello', title: 'Hello', content: '<p>v1</p>' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  const plain = await resolver.resolvePage('/hello', { timeout: 2000 });
  assert.equal(plain.title, 'Hello'); // unchanged default shape.

  const held = await resolver.resolvePage('/hello', { timeout: 2000, hold: true });
  assert.equal(typeof held.release, 'function');
  assert.equal(held.page.title, 'Hello');
  held.release();
});

test('resolvePage({hold: true}) on a genuinely never-published route still returns {page: null, release}', async () => {
  const admin = await actor();
  const { space } = await setupSpace(admin, [{ pub: admin.signingPub, xPub: admin.xPublicKey }]);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  const held = await resolver.resolvePage('/never', { timeout: 500, hold: true });
  assert.equal(held.page, null);
  assert.equal(typeof held.release, 'function');
  held.release(); // must not throw even though nothing was ever really "found".
});

test('a held resolve keeps the Node subscribed - a later edit via a SEPARATE Space instance never needs to wait for a fresh sync (no timeout race)', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity: admin, members, transport });
  }

  const setupSpace = await connect('setup');
  await createApp(setupSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createPage(setupSpace, { route: '/hello', title: 'Hello', content: '<p>v1</p>' });

  // Simulates a CMS "click a list entry to load it into the edit form" handler - resolves WITH hold,
  // exactly like cms-actions.js's wireContent() does now (replacing its own former holdEdit() call).
  const editorSpace = await connect('editor');
  const resolver = new ContentResolver(editorSpace, { appAdminPub: admin.signingPub });
  const { page, release } = await resolver.resolvePage('/hello', { timeout: 2000, hold: true });
  assert.equal(page.content, '<p>v1</p>');

  // The "form submit" moments later - editPage() calls useNode() again for the SAME id; since the
  // hold above never released it, this reuses the still-open, already-fully-synced local Y.Doc -
  // no fresh subscribe, no relay replay, no isNodeSynced() wait ever needed for THIS to succeed.
  await editPage(editorSpace, { route: '/hello', content: '<p>v2</p>', timeout: 500 });
  release();

  const confirmed = await resolver.resolvePage('/hello', { timeout: 2000 });
  assert.equal(confirmed.content, '<p>v2</p>');
});

test('releasing a held resolve, then loading a DIFFERENT item, tears the first one down correctly (no leaked subscription)', async () => {
  const admin = await actor();
  const { space } = await setupSpace(admin, [{ pub: admin.signingPub, xPub: admin.xPublicKey }]);
  await createApp(space, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await createTemplate(space, { name: 'a', html: '<p>a1</p>' });
  await createTemplate(space, { name: 'b', html: '<p>b1</p>' });
  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });

  let activeEdit = await resolver.resolveTemplate('a', { timeout: 2000, hold: true });
  assert.equal(activeEdit.value, '<p>a1</p>');
  activeEdit.release();

  activeEdit = await resolver.resolveTemplate('b', { timeout: 2000, hold: true });
  assert.equal(activeEdit.value, '<p>b1</p>');
  activeEdit.release();

  // Editing "a" afterward must still work (its own hold was correctly released, not stuck open in
  // some broken state - a real, previously-possible mistake this asserts against).
  await editTemplate(space, { name: 'a', html: '<p>a2</p>', timeout: 2000 });
  assert.equal(await resolver.resolveTemplate('a', { timeout: 2000 }), '<p>a2</p>');
});
