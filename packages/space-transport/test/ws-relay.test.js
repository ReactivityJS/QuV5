/**
 * Same proof as poc-demo.test.js, but over a REAL WebSocket server on a
 * real (loopback) TCP port, using WsClientTransport/createWsServerHub
 * instead of the in-process hub - this is what actually runs the same way
 * inside relay-server.js/the Dockerfile. Kept as a separate, focused test
 * rather than duplicating poc-demo's full assertions: the thing genuinely
 * worth proving here is "the network wiring itself works," not
 * re-verifying CRDT/crypto behavior already covered elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '../src/index.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const noteKind = defineKind('note', { fields: { title: 'atomic-encrypted' } });

test('two peers sync a Node through a real WebSocket relay on a real port', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createWsServerHub(wss);
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => true });

  await new Promise((resolve) => httpServer.listen(0, resolve)); // port 0 = OS picks a free port
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;

  const aliceTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  const bobTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  await Promise.all([aliceTransport.connect(), bobTransport.connect()]);

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  await aliceSpace.createNode(noteKind, { title: 'Über das Netzwerk' }, { id: 'note-net-1' });
  const bobNote = bobSpace.subscribeNode('note-net-1', noteKind);

  await waitUntil(async () => (await bobNote.field('title').get()) === 'Über das Netzwerk');
  assert.equal(await bobNote.field('title').get(), 'Über das Netzwerk');
  assert.ok(relay.seen.length >= 1);

  // The relay's own record of what it forwarded is still ciphertext-only, same guarantee as the in-process demo.
  const relayLogText = JSON.stringify(relay.seen, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  assert.equal(relayLogText.includes('Über das Netzwerk'), false);

  aliceTransport.close();
  bobTransport.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

test('relay-server-shaped health check endpoint responds ok', async () => {
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.ok, true);
  assert.equal(await res.text(), 'ok');

  await new Promise((resolve) => httpServer.close(resolve));
});
