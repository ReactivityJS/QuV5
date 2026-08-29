/**
 * THE SCENARIO THE RELAY EXISTS FOR: Client A writes while B isn't even
 * connected yet, then A goes fully offline (socket closed) BEFORE B ever
 * connects. B still gets A's data, because the relay mirrored it - the
 * relay is a peer with its own storage, not just a live pass-through pipe.
 * Runs over a real WebSocket server/port, the same code path
 * relay-server.js/the Dockerfile run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createDurableStore, createFileStore } from '@qu/space-storage';
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

const noteKind = defineKind('note', { fields: { title: 'atomic-encrypted', body: 'text' } });

test('B receives A\'s data from the relay\'s mirror even though A is offline by the time B connects', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const relayMirror = createDurableStore(); // the relay's OWN mirror - not either peer's.
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createWsServerHub(wss);
  createRelayForwarder({ hub, members, resolveKindSchema: () => true, storage: relayMirror });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `ws://127.0.0.1:${httpServer.address().port}`;

  // --- Alice: writes, then goes fully offline ---
  const aliceTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const aliceNote = await aliceSpace.createNode(noteKind, { title: 'Reisenotizen' }, { id: 'note-offline-1' });
  aliceNote.field('body').insert(0, 'Tag 1: Ankunft.');
  await waitUntil(() => relayMirror._backingStore.get('note-offline-1')?.length >= 3); // meta+title+body all mirrored

  aliceTransport.close();
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the close actually land server-side

  // --- Bob connects LATER, once Alice is provably gone ---
  const bobTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  const bobNote = bobSpace.subscribeNode('note-offline-1', noteKind);

  await waitUntil(async () => (await bobNote.field('title').get()) === 'Reisenotizen');
  assert.equal(await bobNote.field('title').get(), 'Reisenotizen');
  assert.equal(bobNote.field('body').get(), 'Tag 1: Ankunft.');

  bobTransport.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

test('a relay with no storage adapter (pure live pass-through) does not answer subscribe requests - documents the tradeoff', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createWsServerHub(wss);
  createRelayForwarder({ hub, members, resolveKindSchema: () => true }); // no `storage` - live-only relay, by choice.
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `ws://127.0.0.1:${httpServer.address().port}`;

  const aliceTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  await aliceTransport.connect();
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  await aliceSpace.createNode(noteKind, { title: 'nur live' }, { id: 'note-live-only' });
  aliceTransport.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const bobTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
  await bobTransport.connect();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
  const bobNote = bobSpace.subscribeNode('note-live-only', noteKind);

  await assert.rejects(() => waitUntil(async () => (await bobNote.field('title').get()) === 'nur live', { timeout: 300 }));

  bobTransport.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

test('the exact relay-server.js shape (real disk file store, relay process restarted) still delivers A\'s data to a later-joining B', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'qu-space-relay-'));
  try {
    const alice = await actor();
    const bob = await actor();
    const members = [
      { pub: alice.signingPub, xPub: alice.xPublicKey },
      { pub: bob.signingPub, xPub: bob.xPublicKey },
    ];

    // --- "First boot" of the relay: Alice writes, then both the relay process and Alice go away. ---
    {
      const httpServer = createServer();
      const wss = new WebSocketServer({ server: httpServer });
      const hub = createWsServerHub(wss);
      createRelayForwarder({ hub, members, resolveKindSchema: () => true, storage: createFileStore(dataDir) });
      await new Promise((resolve) => httpServer.listen(0, resolve));
      const url = `ws://127.0.0.1:${httpServer.address().port}`;

      const aliceTransport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
      await aliceTransport.connect();
      const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
      await aliceSpace.createNode(noteKind, { title: 'Vor dem Neustart' }, { id: 'note-restart-1' });

      await new Promise((resolve) => setTimeout(resolve, 50)); // let the mirror write actually land on disk
      aliceTransport.close();
      await new Promise((resolve) => httpServer.close(resolve)); // the relay process itself "exits"
    }

    // --- "Second boot": a brand new relay process, same data directory, nobody from the first boot is around. ---
    const httpServer2 = createServer();
    const wss2 = new WebSocketServer({ server: httpServer2 });
    const hub2 = createWsServerHub(wss2);
    createRelayForwarder({ hub: hub2, members, resolveKindSchema: () => true, storage: createFileStore(dataDir) });
    await new Promise((resolve) => httpServer2.listen(0, resolve));
    const url2 = `ws://127.0.0.1:${httpServer2.address().port}`;

    const bobTransport = new WsClientTransport(url2, { WebSocketImpl: WebSocket });
    await bobTransport.connect();
    const bobSpace = new Space({ identity: bob, members, transport: bobTransport });
    const bobNote = bobSpace.subscribeNode('note-restart-1', noteKind);

    await waitUntil(async () => (await bobNote.field('title').get()) === 'Vor dem Neustart');
    assert.equal(await bobNote.field('title').get(), 'Vor dem Neustart');

    bobTransport.close();
    await new Promise((resolve) => httpServer2.close(resolve));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
