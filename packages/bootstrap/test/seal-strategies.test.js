/**
 * The `'sealStrategy'` slot (`../src/seal-strategies.js`) + `bootstrapSpace()`
 * wiring - proves the registry-resolved strategy actually reaches `Space`
 * and changes real write behavior, not just that the adapter NAMES resolve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, sealStrategies } from '@qu/space-core';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { bootstrapSpace } from '../src/bootstrap-space.js';
import { registerSealStrategyAdapters } from '../src/seal-strategies.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function fakeTransport() {
  return { async connect() {}, send() {}, onMessage() {} };
}

test('registerSealStrategyAdapters(): registers "none" and "pad-to-members", resolving to the real functions', async () => {
  const registry = new AdapterRegistry();
  registerSealStrategyAdapters(registry);
  assert.equal(await registry.create('sealStrategy', 'none'), sealStrategies.none);
  assert.equal(await registry.create('sealStrategy', 'pad-to-members'), sealStrategies.padToMembers);
});

test('bootstrapSpace(): {adapter: "pad-to-members"} reaches Space - a narrowed write pads "to" to the full member list', async () => {
  const alice = await actor();
  const bob = await actor();
  const carol = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];

  const sentEnvelopes = [];
  const transport = {
    async connect() {},
    send(data) {
      sentEnvelopes.push(data);
    },
    onMessage() {},
  };

  const registry = new AdapterRegistry();
  registerSealStrategyAdapters(registry);

  const { space } = await bootstrapSpace({
    registry,
    identity: alice,
    transport,
    members,
    sealStrategy: { adapter: 'pad-to-members' },
  });

  const noteKind = defineKind('bootstrap-seal-strategy-test-note', {
    fields: { text: { shape: 'atomic', visibility: 'encrypted' } },
    acl: { write: 'members' },
  });
  const node = await space.createNode(noteKind, {}, { id: 'note' });
  await node.field('text').set('only for bob', { recipients: [bob.xPublicKey] });

  const deadline = Date.now() + 1000;
  while (sentEnvelopes.filter((m) => m.envelope?.to?.length).length < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const narrowedWrite = sentEnvelopes.filter((m) => m.envelope?.to?.length).at(-1);
  assert.equal(narrowedWrite.envelope.to.length, 3); // padded to the FULL membership, not just the 2 real recipients.
});

test('bootstrapSpace(): omitting sealStrategy is unchanged - Space gets its own default (no padding)', async () => {
  const alice = await actor();
  const { space } = await bootstrapSpace({ identity: alice, transport: fakeTransport(), members: [] });
  // No direct getter for Space's internal strategy - proven behaviorally elsewhere
  // (seal-strategy-integration.test.js in @qu/space-core); here we only confirm bootstrapSpace()
  // doesn't throw/require a registry when sealStrategy is omitted entirely.
  assert.ok(space);
});
