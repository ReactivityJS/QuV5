/**
 * RECONNECT/RESYNC — proves Space's own half of reconnect handling (see
 * space.js's "RESYNC ON RECONNECT" doc comment): whatever the transport
 * reports through `onStatusChange()`, a Space reacts to `'connected'`/
 * `'reconnected'` by re-sending `hello` and re-subscribing every currently
 * attached Node - the actual mechanism that turns "the socket reopened"
 * into "we're caught up again," not just "we can send bytes again."
 *
 * Uses a minimal fake transport (not @qu/space-transport's real
 * WsClientTransport/InProcessTransport) so this stays a pure unit test of
 * Space's own reaction to the transport contract, independent of what
 * fires it in practice - a real end-to-end reconnect-over-a-dropped-socket
 * test lives in @qu/space-transport's own test suite instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, defineKind } from '../src/index.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function fakeTransport() {
  const sent = [];
  let onMessage = null;
  let onStatusChange = null;
  return {
    sent,
    send: (data) => sent.push(data),
    sendTo: (_peerId, data) => sent.push(data),
    onMessage: (cb) => (onMessage = cb),
    onStatusChange: (cb) => (onStatusChange = cb),
    getPeerId: () => 'fake-peer',
    emitStatus: (status) => onStatusChange?.(status),
    deliver: (data) => onMessage?.({ data, peerId: 'relay' }),
  };
}

const noteKind = defineKind('reconnect-note', { fields: { title: { shape: 'atomic' } } });

test('on transport status "connected", Space re-sends hello', async () => {
  const alice = await actor();
  const transport = fakeTransport();
  new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport });

  transport.sent.length = 0; // clear the constructor's own initial hello.
  transport.emitStatus({ status: 'connected' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(transport.sent.some((m) => m.type === 'hello'));
});

test('on transport status "reconnected", Space re-sends hello AND re-subscribes every attached Node', async () => {
  const alice = await actor();
  const transport = fakeTransport();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport });
  space.subscribeNode('node-a', noteKind);
  space.subscribeNode('node-b', noteKind);

  transport.sent.length = 0;
  transport.emitStatus({ status: 'reconnected' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(transport.sent.some((m) => m.type === 'hello'));
  const subscribedIds = transport.sent.filter((m) => m.type === 'subscribe').map((m) => m.nodeId);
  assert.deepEqual(new Set(subscribedIds), new Set(['node-a', 'node-b']));
});

test('a "disconnected"/"reconnecting" status does NOT trigger hello/subscribe resends', async () => {
  const alice = await actor();
  const transport = fakeTransport();
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport });
  space.subscribeNode('node-c', noteKind);
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the constructor's own hello + subscribeNode()'s own fire-and-forget signing finish landing in `sent` before clearing it below.

  transport.sent.length = 0;
  transport.emitStatus({ status: 'disconnected' });
  transport.emitStatus({ status: 'reconnecting', attempt: 1, delay: 500 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(transport.sent.length, 0);
});

test('space.status.changed fires on the bus for every transport status transition', async () => {
  const alice = await actor();
  const transport = fakeTransport();
  const statuses = [];
  const bus = { emit: async (topic, payload) => topic === 'space.status.changed' && statuses.push(payload.status) };
  new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport, bus });

  transport.emitStatus({ status: 'disconnected' });
  transport.emitStatus({ status: 'reconnecting', attempt: 1, delay: 500 });
  transport.emitStatus({ status: 'reconnected' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(statuses, ['disconnected', 'reconnecting', 'reconnected']);
});

test('a transport with no onStatusChange (e.g. InProcessTransport) does not break Space construction', async () => {
  const alice = await actor();
  const sent = [];
  const bareTransport = { send: (d) => sent.push(d), sendTo: (_p, d) => sent.push(d), onMessage: () => {}, getPeerId: () => 'x' };
  assert.doesNotThrow(() => new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: bareTransport }));
});
