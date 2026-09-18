/**
 * END-TO-END: proves `bootstrapSpace()` + the memory adapter pack
 * (`../src/adapters/memory.js`) actually produce a WORKING `Space` - not
 * just the right shaped object - by syncing a real write between two
 * independently bootstrapped peers through a shared in-process "relay".
 * Mirrors the pattern `@qu/app-core`'s own `runtime.test.js` already uses
 * for a hand-wired `Space`; this file's whole point is showing the exact
 * same end state is reachable from a declarative `{adapter: '...'}` config
 * instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { bootstrapSpace } from '../src/bootstrap-space.js';
import { registerMemoryAdapters, createSharedInProcessHub } from '../src/adapters/memory.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

const noteKind = defineKind('bootstrap-test-note', {
  fields: { text: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'members' },
});

test('bootstrapSpace(): {adapter: "memory"}/{adapter: "in-process"} config resolves through a registry into a real, syncing Space', async () => {
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  const hub = createSharedInProcessHub();
  // This test's relay only ever mirrors ONE Kind, so it can resolve any nodeId to it directly -
  // a real relay's own resolveKindSchema(nodeId) instead looks nodeId up against whatever Kinds its
  // app registers (see e.g. @qu/app-core's createAppResolveKindSchema()).
  createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind, storage: createMemoryStore() });

  const registry = new AdapterRegistry();
  registerMemoryAdapters(registry);

  const { space: aliceSpace, bus: aliceBus } = await bootstrapSpace({
    registry,
    identity: alice,
    transport: { adapter: 'in-process', hub, peerId: 'alice' },
    storage: { adapter: 'memory' },
    members,
  });
  const { space: bobSpace } = await bootstrapSpace({
    registry,
    identity: bob,
    transport: { adapter: 'in-process', hub, peerId: 'bob' },
    members,
  });

  assert.ok(aliceBus, 'bootstrapSpace() defaults to a real EventBus when "bus" is omitted');
  assert.ok(aliceSpace instanceof Space);
  assert.ok(bobSpace instanceof Space);

  const node = await aliceSpace.createNode(noteKind, { text: 'hallo von alice' }, { id: 'shared-note' });
  await node.field('text').set('hallo von alice');

  const { node: bobNode } = await bobSpace.useNode('shared-note', noteKind);
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 50 && (await bobNode.field('text').get()) !== 'hallo von alice'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  assert.equal(await bobNode.field('text').get(), 'hallo von alice');
});

test('bootstrapSpace(): an already-constructed instance (no "adapter" key) is passed straight through, no registry needed', async () => {
  const identity = await actor();
  let connected = false;
  const fakeTransport = {
    async connect() {
      connected = true;
    },
    send() {},
    onMessage() {},
  };

  const { space, transport } = await bootstrapSpace({ identity, transport: fakeTransport, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }] });
  assert.equal(transport, fakeTransport);
  assert.ok(connected, 'bootstrapSpace() calls transport.connect() automatically');
  assert.ok(space instanceof Space);
});

test('bootstrapSpace(): missing "identity" or "transport" fails fast with a clear error', async () => {
  const identity = await actor();
  await assert.rejects(() => bootstrapSpace({ transport: { async connect() {}, send() {}, onMessage() {} } }), /"identity" is required/);
  await assert.rejects(() => bootstrapSpace({ identity }), /"transport" is required/);
});

test('bootstrapSpace(): an {adapter} config without a registry fails fast, naming the slot', async () => {
  const identity = await actor();
  await assert.rejects(() => bootstrapSpace({ identity, transport: { adapter: 'ws-client', url: 'ws://x' } }), /"transport" names an adapter \("ws-client"\) but no "registry" was given/);
});

test('bootstrapSpace(): an incomplete transport (missing a required method) fails fast via the Transport contract, never reaching Space', async () => {
  const identity = await actor();
  await assert.rejects(
    () => bootstrapSpace({ identity, transport: { connect: async () => {}, send: () => {} /* onMessage missing */ } }),
    /missing required method\(s\): onMessage/
  );
});

test('bootstrapSpace(): bus: null opts out of the default auto-created EventBus', async () => {
  const identity = await actor();
  const { space, bus } = await bootstrapSpace({
    identity,
    transport: { async connect() {}, send() {}, onMessage() {} },
    members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }],
    bus: null,
  });
  assert.equal(bus, null);
  assert.equal(space.bus, null);
});
