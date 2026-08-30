/**
 * UPLOAD OUTBOX — see upload-outbox.js's own doc comment. Proves the local
 * save -> pending -> uploading -> done/failed lifecycle, retry, and that
 * status is visible to a fellow Space member who subscribes (a remote-sync
 * status icon's data source).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { UploadOutbox, uploadOutboxKind } from '../src/upload-outbox.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function silentTransport() {
  return { sent: [], send(data) { this.sent.push(data); }, sendTo(_p, data) { this.sent.push(data); }, onMessage() {}, getPeerId: () => 'silent' };
}

function pairTransports() {
  let aOnMessage = null;
  let bOnMessage = null;
  const a = { async connect() {}, send(data) { queueMicrotask(() => bOnMessage?.({ data })); }, onMessage(cb) { aOnMessage = cb; } };
  const b = { async connect() {}, send(data) { queueMicrotask(() => aOnMessage?.({ data })); }, onMessage(cb) { bOnMessage = cb; } };
  return [a, b];
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

function memoryLocalStore() {
  const blobs = new Map();
  return {
    async save(id, blob) {
      blobs.set(id, blob);
    },
    async load(id) {
      return blobs.get(id);
    },
    async remove(id) {
      blobs.delete(id);
    },
    has: (id) => blobs.has(id),
  };
}

test('enqueue() saves locally, then transitions pending -> uploading -> done, and removes the local copy once done', async () => {
  const alice = await actor();
  const space = new Space({ identity: alice, members: [], transport: silentTransport() });
  const localStore = memoryLocalStore();
  const uploaded = [];
  const outbox = new UploadOutbox(space, localStore, async (record, blob) => {
    uploaded.push({ record, blob });
  });

  const id = await outbox.enqueue({ name: 'cat.png', size: 1234, mimeType: 'image/png' }, 'fake-bytes');
  assert.equal(localStore.has(id), false); // upload() resolved synchronously in this test - already cleaned up.
  const status = await outbox.statusOf(id);
  assert.equal(status.status, 'done');
  assert.equal(status.name, 'cat.png');
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].blob, 'fake-bytes');
});

test('a throwing upload() leaves the record "failed" (with the error message) and keeps the local blob for retry()', async () => {
  const alice = await actor();
  const space = new Space({ identity: alice, members: [], transport: silentTransport() });
  const localStore = memoryLocalStore();
  let attempts = 0;
  const outbox = new UploadOutbox(space, localStore, async () => {
    attempts++;
    if (attempts === 1) throw new Error('network down');
  });

  const id = await outbox.enqueue({ name: 'doc.pdf', size: 99, mimeType: 'application/pdf' }, 'bytes');
  let status = await outbox.statusOf(id);
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'network down');
  assert.equal(localStore.has(id), true); // never dropped - still retryable.

  await outbox.retry(id);
  status = await outbox.statusOf(id);
  assert.equal(status.status, 'done');
  assert.equal(attempts, 2);
});

test('list() returns every queued file\'s current record', async () => {
  const alice = await actor();
  const space = new Space({ identity: alice, members: [], transport: silentTransport() });
  const outbox = new UploadOutbox(space, memoryLocalStore(), async () => {});
  await outbox.enqueue({ name: 'a.txt', size: 1, mimeType: 'text/plain' }, 'a');
  await outbox.enqueue({ name: 'b.txt', size: 2, mimeType: 'text/plain' }, 'b');

  const all = await outbox.list();
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((r) => r.name)), new Set(['a.txt', 'b.txt']));
});

test('upload status is visible to a fellow Space member who subscribes to the uploader\'s outbox Node', async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });

  // uploadOutboxKind's `records` field is 'public' visibility (see that file's own doc comment on
  // why) - bob needs no Space-membership relationship to alice at all, just to subscribe before
  // her first write in this bare peer-to-peer harness (no relay/storage catch-up here).
  const outboxNodeId = await deriveOwnerNodeId(alice.signingPub, uploadOutboxKind.kind);
  const bobView = bobSpace.subscribeNode(outboxNodeId, uploadOutboxKind);

  const outbox = new UploadOutbox(aliceSpace, memoryLocalStore(), async () => {});
  await outbox.enqueue({ name: 'shared.png', size: 10, mimeType: 'image/png' }, 'x');

  await waitUntil(async () => {
    const records = (await bobView.field('records').get()) ?? {};
    return Object.values(records).some((r) => r.name === 'shared.png' && r.status === 'done');
  });
});
