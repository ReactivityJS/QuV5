/**
 * createQuApp() (browser entry, `../src/browser.js`) — proves the actual
 * WIRING is correct: a real, syncing `Space` comes out the other end of
 * one call, `mount`/`kinds` land on the right DOM properties, `webrtc` is
 * present ONLY when asked for, and every advanced escape hatch
 * (`registry`/`transport`/an already-built `identity`) still works. Does
 * NOT re-test `bootstrapSpace()`/`createWebRTCPeer()`'s own internal
 * correctness - those already have their own full suites
 * (`@qu/bootstrap`'s/`@qu/space-transport`'s own tests) - this file's whole
 * job is "did createQuApp() compose them correctly."
 *
 * jsdom set up BEFORE importing `browser.js` (its own top-level
 * `import '@qu/space-components/elements'` checks `typeof customElements`
 * at MODULE LOAD time - `class QuView extends HTMLElement` needs a real
 * `HTMLElement` global to exist already), same ordering
 * `space-components/test/qu-view.test.js` already establishes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><body><div id="app"></div></body>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.customElements = window.customElements;
globalThis.Node = window.Node;

const { QuCrypto } = await import('@qu/core');
const { defineKind, userKind, userNodeId } = await import('@qu/space-core');
const { createRelayForwarder, createInProcessHub } = await import('@qu/space-transport');
const { AdapterRegistry } = await import('@qu/bootstrap');
const { createQuApp } = await import('../src/browser.js');

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

const noteKind = defineKind('app-kit-test-note', {
  fields: { title: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'members' },
});

function relayFor(members, hub = createInProcessHub()) {
  createRelayForwarder({
    hub,
    members,
    resolveKindSchema: (nodeId, claimedPub) => (nodeId === noteKind.kind || claimedPub ? noteKind : null),
  });
  return hub;
}

test('createQuApp(): {relay:{hub}} + memory identity produces a real, working Space (no mount, no webrtc - a minimal app)', async () => {
  const alice = await actor();
  const hub = relayFor([{ pub: alice.signingPub, xPub: alice.xPublicKey }]);

  const app = await createQuApp({ relay: { hub, peerId: 'alice' }, identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }] });

  assert.ok(app.space);
  assert.deepEqual(app.identity.signingPub, alice.signingPub);
  assert.ok(app.registry);
  assert.equal('webrtc' in app, false, 'no "webrtc" option given -> the instance genuinely has no "webrtc" key at all, not merely undefined');

  const note = await app.space.createNode(noteKind, { title: 'hello' });
  assert.equal(await note.field('title').get(), 'hello');
});

test('createQuApp(): "mount" sets .quSpace/.quKinds on the given element (CSS selector or Element)', async () => {
  const alice = await actor();
  const hub = relayFor([{ pub: alice.signingPub, xPub: alice.xPublicKey }]);
  const kinds = { note: noteKind };

  const app = await createQuApp({
    relay: { hub, peerId: 'alice-mount' },
    identity: alice,
    members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }],
    kinds,
    mount: '#app',
  });

  const el = document.querySelector('#app');
  assert.equal(el.quSpace, app.space);
  assert.equal(el.quKinds, kinds);
});

test('createQuApp(): "mount" also accepts an already-resolved Element directly', async () => {
  const alice = await actor();
  const hub = relayFor([{ pub: alice.signingPub, xPub: alice.xPublicKey }]);
  const el = document.createElement('div');

  const app = await createQuApp({ relay: { hub, peerId: 'alice-el' }, identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], mount: el });
  assert.equal(el.quSpace, app.space);
});

test('createQuApp(): a "mount" selector that resolves to nothing throws loudly, not a silent no-op', async () => {
  const alice = await actor();
  const hub = relayFor([{ pub: alice.signingPub, xPub: alice.xPublicKey }]);
  await assert.rejects(
    () => createQuApp({ relay: { hub, peerId: 'alice-badmount' }, identity: alice, mount: '#does-not-exist' }),
    /did not resolve to an element/
  );
});

test('createQuApp(): "webrtc" is present ONLY when requested, with a working connect() surface', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = relayFor(members);

  const app = await createQuApp({ relay: { hub, peerId: 'alice-rtc' }, identity: alice, members, webrtc: { iceServers: [] } });
  assert.equal(typeof app.webrtc.connect, 'function');
});

test('createQuApp(): "ensureUserProfile" defaults to true - a qu-user profile exists after bootstrap with no extra call', async () => {
  const alice = await actor();
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => userKind });

  const app = await createQuApp({ relay: { hub, peerId: 'alice-profile' }, identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }] });
  const nodeId = await userNodeId(alice.signingPub);
  assert.ok(app.space.getNode(nodeId), 'a qu-user Node exists without the caller calling ensureUserProfile() itself');
});

test('createQuApp(): "ensureUserProfile: false" opts out of the default-on profile creation', async () => {
  const alice = await actor();
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => userKind });

  const app = await createQuApp({ relay: { hub, peerId: 'alice-noprofile' }, identity: alice, ensureUserProfile: false });
  const nodeId = await userNodeId(alice.signingPub);
  assert.equal(app.space.getNode(nodeId), undefined);
});

test('createQuApp(): escape hatches - a pre-built AdapterRegistry and an already-built identity object both work', async () => {
  const alice = await actor();
  const hub = relayFor([{ pub: alice.signingPub, xPub: alice.xPublicKey }]);
  const registry = new AdapterRegistry();

  const app = await createQuApp({ registry, relay: { hub, peerId: 'alice-registry' }, identity: alice });
  assert.equal(app.registry, registry, 'the SAME registry instance is used, not silently replaced');
});

test('createQuApp(): missing "relay" (and no advanced "transport") throws loudly', async () => {
  // identity: 'memory' - isolates this test to the "relay" check itself; the default
  // identity: 'local-storage' would fail earlier here for an unrelated reason (jsdom has no real
  // localStorage global, unlike an actual browser) - not what this test is about.
  await assert.rejects(() => createQuApp({ identity: 'memory' }), /"relay".*"transport".*required/);
});
