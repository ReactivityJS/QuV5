/**
 * WIRE EFFICIENCY — proves both halves actually work, not just that they
 * were configured:
 *   1. encodeForWire()/decodeFromWire() (see @qu/space-core's wire-codec.js)
 *      already produces base64 for every Uint8Array field, never a JSON
 *      array of integers - the bigger of the two wins, and unconditional.
 *   2. A real WebSocket connection to a relay actually NEGOTIATES
 *      `permessage-deflate` when the server opts in (see relay-server.js/
 *      demo/relay.mjs's own `new WebSocketServer({..., perMessageDeflate:
 *      true})`) - `ws`'s client side already offers it by default, but the
 *      server has to accept, or nothing is actually compressed on the wire
 *      despite the option being set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { encodeForWire, decodeFromWire } from '@qu/space-core';
import { createWsServerHub } from '../src/index.js';

test('encodeForWire() produces base64 for Uint8Array fields, never a JSON array of per-byte integers', () => {
  const bytes = new Uint8Array(64).fill(7);
  const envelope = { pub: bytes, nested: { ct: bytes }, list: [bytes] };
  const onWire = JSON.stringify(encodeForWire(envelope));

  assert.equal(onWire.includes('"0":7'), false); // the old, wasteful per-byte-indexed-object shape a bare JSON.stringify(Uint8Array) would produce.
  assert.match(onWire, /"__u8":"[A-Za-z0-9+/=]+"/); // a genuine base64 string instead.

  // Same 64 bytes, encoded the OLD way (what a bare JSON.stringify(Uint8Array) actually produces -
  // a byte-indexed plain object, "0":7,"1":7,... - see wire-codec.js's own doc comment on why that
  // needed fixing in the first place) vs. base64 - base64 wins by roughly 4-6x on raw size.
  const naiveJson = JSON.stringify(bytes);
  const base64Json = JSON.stringify(encodeForWire(bytes));
  assert.ok(base64Json.length < naiveJson.length / 4);

  assert.deepEqual(decodeFromWire(JSON.parse(onWire)), envelope);
});

test('a real WebSocket connection to a relay negotiates permessage-deflate when the server opts in', async () => {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  createWsServerHub(wss); // wires up connection handling - this test only cares about the handshake, not routing.
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    client.on('open', resolve);
    client.on('error', reject);
  });

  assert.match(client.extensions, /permessage-deflate/); // actually negotiated, not just offered - a mismatched server would leave this empty.

  client.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

test('a relay built WITHOUT perMessageDeflate does NOT negotiate compression - the option is what makes the difference, not `ws` itself', async () => {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer }); // deliberately no perMessageDeflate - the pre-Task-9 shape.
  createWsServerHub(wss);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    client.on('open', resolve);
    client.on('error', reject);
  });

  assert.equal(client.extensions, ''); // the client offered it (ws defaults to true client-side), but the server never accepted.

  client.close();
  await new Promise((resolve) => httpServer.close(resolve));
});
