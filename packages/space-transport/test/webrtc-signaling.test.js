/**
 * wrapWithSignaling() — proves the wrapper's own contract (webrtc-signaling.js's
 * doc comment): transparent to a real `Space` (ordinary sync keeps working,
 * unmodified) while `rtc-signal` messages are intercepted and routed to
 * `onSignal()` listeners instead, never reaching Space's own handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '../src/index.js';
import { wrapWithSignaling } from '../src/webrtc-signaling.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('wrapWithSignaling(): the wrapper itself satisfies the Transport contract', () => {
  const inner = new InProcessTransport(createInProcessHub(), 'x');
  const wrapped = wrapWithSignaling(inner);
  assert.equal(typeof wrapped.connect, 'function');
  assert.equal(typeof wrapped.send, 'function');
  assert.equal(typeof wrapped.onMessage, 'function');
  assert.equal(typeof wrapped.sendSignal, 'function');
  assert.equal(typeof wrapped.onSignal, 'function');
});

test('wrapWithSignaling(): only exposes an OPTIONAL Transport method (onStatusChange/getPeerId/close) if the wrapped transport itself has one', () => {
  const inProcess = new InProcessTransport(createInProcessHub(), 'x'); // has getPeerId, NOT onStatusChange/close.
  const wrappedInProcess = wrapWithSignaling(inProcess);
  assert.equal(typeof wrappedInProcess.getPeerId, 'function');
  assert.equal(wrappedInProcess.onStatusChange, undefined);
  assert.equal(wrappedInProcess.close, undefined);

  const fullStub = { connect: async () => {}, send: () => {}, onMessage: () => {}, onStatusChange: () => {}, getPeerId: () => 'x', close: () => {} };
  const wrappedFull = wrapWithSignaling(fullStub);
  assert.equal(typeof wrappedFull.onStatusChange, 'function');
  assert.equal(typeof wrappedFull.close, 'function');
});

test('wrapWithSignaling(): a real Space works completely normally over a wrapped transport (ordinary sync unaffected)', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const noteKind = defineKind('webrtc-signaling-test-note', { fields: { body: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'members' } });
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind });

  const aliceTransport = wrapWithSignaling(new InProcessTransport(hub, 'alice'));
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });

  const bobTransport = wrapWithSignaling(new InProcessTransport(hub, 'bob'));
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  const node = await aliceSpace.createNode(noteKind, { body: 'hello' }, { id: 'shared-note' });
  const { node: bobNode } = await bobSpace.useNode('shared-note', noteKind);
  await waitUntil(async () => (await bobNode.field('body').get()) === 'hello');
  assert.equal(await node.field('body').get(), 'hello');
});

test('wrapWithSignaling(): rtc-signal messages are intercepted - Space\'s own handler never sees them', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = wrapWithSignaling(new InProcessTransport(hub, 'alice'));
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport }); // sends its own 'hello' on construction.
  const bobTransport = wrapWithSignaling(new InProcessTransport(hub, 'bob'));
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  void aliceSpace; // constructed only for its side-effecting 'hello' - not otherwise used in this test.
  void bobSpace;

  await waitUntil(() => presence.isOnline(QuCrypto.toBase64(alice.signingPub)) && presence.isOnline(QuCrypto.toBase64(bob.signingPub)));

  const signals = [];
  const unsubscribe = bobTransport.onSignal((payload) => signals.push(payload));
  aliceTransport.sendSignal(QuCrypto.toBase64(bob.signingPub), { sdp: 'offer' });

  await waitUntil(() => signals.length > 0);
  assert.deepEqual(signals[0], { from: QuCrypto.toBase64(alice.signingPub), signal: { sdp: 'offer' } });
  unsubscribe();
});

test('wrapWithSignaling(): onSignal() supports multiple independent listeners, each individually unsubscribable', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = wrapWithSignaling(new InProcessTransport(hub, 'alice'));
  await aliceTransport.connect();
  new Space({ identity: alice, members, transport: aliceTransport });
  const bobTransport = wrapWithSignaling(new InProcessTransport(hub, 'bob'));
  await bobTransport.connect();
  new Space({ identity: bob, members, transport: bobTransport });
  await waitUntil(() => presence.isOnline(QuCrypto.toBase64(alice.signingPub)) && presence.isOnline(QuCrypto.toBase64(bob.signingPub)));

  let countA = 0;
  let countB = 0;
  const unsubA = bobTransport.onSignal(() => countA++);
  const unsubB = bobTransport.onSignal(() => countB++);

  aliceTransport.sendSignal(QuCrypto.toBase64(bob.signingPub), { n: 1 });
  await waitUntil(() => countA === 1 && countB === 1);

  unsubA();
  aliceTransport.sendSignal(QuCrypto.toBase64(bob.signingPub), { n: 2 });
  await waitUntil(() => countB === 2);
  assert.equal(countA, 1, 'unsubscribed listener stopped receiving new signals');

  unsubB();
});
