/**
 * RECONNECT OVER A REAL DROPPED SOCKET — end to end proof of
 * ws-client-transport.js's own reconnect mechanism PLUS space.js's resync
 * wiring together: killing the relay's TCP listener out from under an
 * already-connected client, restarting it on the SAME port, and checking
 * the client (a) reports the full connected -> disconnected -> reconnecting
 * -> reconnected lifecycle, and (b) actually catches up on a write the
 * relay mirrored while the client was offline - the "resync," not just
 * "resume being able to send bytes," half of the requirement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createMemoryStore } from '@qu/space-storage';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '../src/index.js';

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

const noteKind = defineKind('reconnect-note', { fields: { title: { shape: 'atomic' } } });

function startRelay(port, members, storage) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, storage });
  return new Promise((resolve) => httpServer.listen(port, () => resolve({ httpServer, wss, relay })));
}

test('a client reconnects after the relay is killed and restarted on the same port, then resyncs a Node it missed', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const storage = createMemoryStore();

  const { httpServer: server1, wss: wss1 } = await startRelay(0, members, storage);
  const port = server1.address().port;
  const url = `ws://127.0.0.1:${port}`;

  const bobTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket, minReconnectDelay: 50, maxReconnectDelay: 200 });
  await bobTransport.connect();
  // Space's OWN constructor claims the transport's single onStatusChange() slot (see space.js's
  // "RESYNC ON RECONNECT" wiring) - observing status from here on has to go through the bus'
  // `space.status.changed`, not a second direct onStatusChange() registration, which would just
  // silently overwrite Space's own.
  const statuses = [];
  const bus = { emit: async (topic, payload) => topic === 'space.status.changed' && statuses.push(payload.status) };
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, bus });
  const bobNode = bobSpace.subscribeNode('note-reconnect-1', noteKind);
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the subscribe land before the relay dies.

  // Kill the relay out from under bob's still-open client socket - httpServer.close() alone only
  // stops accepting NEW connections, so the already-open WebSocket also needs forcing shut.
  for (const client of wss1.clients) client.terminate();
  await new Promise((resolve) => server1.close(resolve));
  await waitUntil(() => statuses.includes('disconnected'));
  await waitUntil(() => statuses.includes('reconnecting'));

  // Meanwhile, alice (a fresh connection to a freshly restarted relay on the SAME port) writes to
  // the Node bob is subscribed to - bob is offline for this write, so this is exactly the "missed
  // it while disconnected" case resync has to cover.
  const { httpServer: server2 } = await startRelay(port, members, storage);
  const aliceTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  await aliceSpace.createNode(noteKind, { title: 'missed while offline' }, { id: 'note-reconnect-1' });
  await new Promise((resolve) => setTimeout(resolve, 50)); // let alice's write land in the (new, same-port) relay's mirror.

  await waitUntil(() => statuses.includes('reconnected'), { timeout: 5000 });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'missed while offline', { timeout: 5000 });

  bobTransport.close();
  aliceTransport.close();
  await new Promise((resolve) => server2.close(resolve));
});
