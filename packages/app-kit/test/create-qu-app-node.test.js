/**
 * createQuApp() (Node entry, `../src/node.js`) — same composition proof as
 * the browser entry's own test file, minus `mount`/`webrtc` (unsupported
 * here - proven to throw loudly instead of silently no-op'ing) and with
 * "ensureUserProfile" defaulting OFF instead of on. Plain `node:test`, no
 * jsdom - this entry never touches a DOM global.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, userKind, userNodeId } from '@qu/space-core';
import { createRelayForwarder, createInProcessHub } from '@qu/space-transport';
import { createQuApp } from '../src/node.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

const noteKind = defineKind('app-kit-node-test-note', {
  fields: { title: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'members' },
});

test('createQuApp() (node): {relay:{hub}} + memory identity (the default here) produces a real, working Space', async () => {
  const alice = await actor();
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => noteKind });

  const app = await createQuApp({ relay: { hub, peerId: 'alice-node' }, identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }] });
  const note = await app.space.createNode(noteKind, { title: 'from node' });
  assert.equal(await note.field('title').get(), 'from node');
});

test('createQuApp() (node): "identity" defaults to \'memory\' when omitted', async () => {
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [], resolveKindSchema: () => null });
  const app = await createQuApp({ relay: { hub, peerId: 'default-identity' } });
  assert.ok(app.identity.signingPub instanceof Uint8Array);
});

test('createQuApp() (node): "ensureUserProfile" defaults to false here (unlike the browser entry)', async () => {
  const alice = await actor();
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], resolveKindSchema: () => userKind });

  const app = await createQuApp({ relay: { hub, peerId: 'alice-node-profile' }, identity: alice });
  const nodeId = await userNodeId(alice.signingPub);
  assert.equal(app.space.getNode(nodeId), undefined);
});

test('createQuApp() (node): "mount" is not supported - throws loudly rather than silently doing nothing', async () => {
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [], resolveKindSchema: () => null });
  await assert.rejects(() => createQuApp({ relay: { hub, peerId: 'no-mount' }, mount: '#app' }), /"mount".*not supported/);
});

test('createQuApp() (node): "webrtc" is not supported - throws loudly rather than silently doing nothing', async () => {
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members: [], resolveKindSchema: () => null });
  await assert.rejects(() => createQuApp({ relay: { hub, peerId: 'no-webrtc' }, webrtc: { iceServers: [] } }), /"webrtc".*not supported/);
});
