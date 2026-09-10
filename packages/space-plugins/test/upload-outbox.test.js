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
import { createMemoryStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import { UploadOutbox, uploadOutboxKind } from '../src/upload-outbox.js';
import { markFileReceived, watchFileReceipts } from '../src/delivery-status.js';

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
  // enqueue() resolves once locally saved/queued, NOT once uploaded (see that method's own doc
  // comment on why it's fire-and-forget) - the actual attempt is still in flight at this point.
  await waitUntil(async () => (await outbox.statusOf(id))?.status === 'done');
  assert.equal(localStore.has(id), false); // done - the local copy was cleaned up.
  const status = await outbox.statusOf(id);
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
  await waitUntil(async () => (await outbox.statusOf(id))?.status === 'failed');
  let status = await outbox.statusOf(id);
  assert.equal(status.error, 'network down');
  assert.equal(localStore.has(id), true); // never dropped - still retryable.

  await outbox.retry(id); // also fire-and-forget - see retry()'s own doc comment.
  await waitUntil(async () => (await outbox.statusOf(id))?.status === 'done');
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

test('watch() reactively reports a file\'s status changes, no polling', async () => {
  const alice = await actor();
  const space = new Space({ identity: alice, members: [], transport: silentTransport() });
  let resolveUpload;
  const outbox = new UploadOutbox(space, memoryLocalStore(), () => new Promise((resolve) => (resolveUpload = resolve)));

  const seen = [];
  const enqueuePromise = outbox.enqueue({ name: 'slow.bin', size: 1, mimeType: 'application/octet-stream' }, 'x');
  await new Promise((resolve) => setTimeout(resolve, 10)); // let enqueue() reach 'uploading' and register the record before watch() reads it back.
  const id = (await outbox.list())[0].id;
  const unwatch = await outbox.watch(id, (record) => seen.push(record?.status));

  resolveUpload();
  await enqueuePromise;
  await waitUntil(() => seen.includes('done'));
  assert.deepEqual(seen[0], 'uploading'); // the immediate callback on watch() itself reported the current status.
  unwatch();
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

test('a "done" record advances to "synced" once a real relay ack\'s the metadata write, when the outbox is given a bus', async () => {
  const alice = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, resolveKindSchema: () => uploadOutboxKind, storage: createMemoryStore() });

  const transport = new InProcessTransport(hub, 'alice');
  await transport.connect();
  const bus = new EventBus();
  const space = new Space({ identity: alice, members, transport, bus });

  const outbox = new UploadOutbox(space, memoryLocalStore(), async () => {}, bus);
  const id = await outbox.enqueue({ name: 'relay-checked.png', size: 5, mimeType: 'image/png' }, 'bytes');

  const seen = [];
  await outbox.watch(id, (record) => seen.push(record?.status));
  await waitUntil(async () => (await outbox.statusOf(id))?.status === 'synced');
  assert.deepEqual(seen.slice(0, 3), ['pending', 'uploading', 'done']); // 'synced' arrives strictly after 'done', not instead of it.
});

test('without a bus, a "done" record stays "done" (never advances to "synced")', async () => {
  const alice = await actor();
  const space = new Space({ identity: alice, members: [], transport: silentTransport() });
  const outbox = new UploadOutbox(space, memoryLocalStore(), async () => {}); // no bus passed
  const id = await outbox.enqueue({ name: 'no-bus.png', size: 5, mimeType: 'image/png' }, 'bytes');
  await waitUntil(async () => (await outbox.statusOf(id))?.status === 'done');
  await new Promise((resolve) => setTimeout(resolve, 30)); // give a hypothetical stray transition a chance to (wrongly) happen.
  assert.equal((await outbox.statusOf(id)).status, 'done');
});

test('markFileReceived()/watchFileReceipts() let a recipient confirm receipt of a specific uploaded file', async () => {
  const alice = await actor(); // uploader
  const bob = await actor(); // recipient
  const [aliceTransport, bobTransport] = pairTransports();
  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  // readReceiptKind's `marks` field is 'encrypted' (see delivery-status.js) - bob (the one WRITING
  // his own receipt) must have alice as a member so his encrypted write actually decrypts for her.
  const bobSpace = new Space({ identity: bob, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: bobTransport });

  const outbox = new UploadOutbox(aliceSpace, memoryLocalStore(), async () => {});
  const fileId = await outbox.enqueue({ name: 'for-bob.png', size: 3, mimeType: 'image/png' }, 'x');
  await waitUntil(async () => (await outbox.statusOf(fileId))?.status === 'done');

  // bob watches BEFORE marking - no relay/storage catch-up in this bare peer-to-peer harness.
  await watchFileReceipts(aliceSpace, bob.signingPub); // alice pre-subscribes so her later read below isn't the FIRST subscribe.
  await markFileReceived(bobSpace, fileId);
  await waitUntil(async () => (await watchFileReceipts(aliceSpace, bob.signingPub)).marks[fileId] !== undefined);
  const { marks } = await watchFileReceipts(aliceSpace, bob.signingPub);
  assert.ok(marks[fileId].at > 0);
});
