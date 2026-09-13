/**
 * bootstrapAliasSpace() — composes @qu/space-core's publishAlias() with
 * bootstrapSpace() (see ../src/alias-space.js's own doc comment for the
 * "dead drop" design this answers). The alias<->real resolution mechanics
 * themselves are already proven in @qu/space-core's alias.test.js; this
 * file proves the COMPOSITION: a different identity is derived and used,
 * the registry entry lands on the REAL space, and the resulting alias
 * Space is independently usable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, aliasRegistryKind, aliasRegistryNodeId } from '@qu/space-core';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { bootstrapSpace } from '../src/bootstrap-space.js';
import { bootstrapAliasSpace } from '../src/alias-space.js';
import { registerMemoryAdapters, createSharedInProcessHub } from '../src/adapters/memory.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

const postKind = defineKind('alias-space-test-post', {
  fields: { body: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'owner' },
});

test('bootstrapAliasSpace(): derives a DIFFERENT identity, usable as an independent Space', async () => {
  const alice = await actor();
  const hub = createSharedInProcessHub();
  const registry = new AdapterRegistry();
  registerMemoryAdapters(registry);

  const { space: realSpace, identity: realIdentity } = await bootstrapSpace({
    registry,
    identity: alice,
    transport: { adapter: 'in-process', hub, peerId: 'alice-real' },
    storage: { adapter: 'memory' },
  });

  const { space: aliasSpace, identity: aliasIdentity } = await bootstrapAliasSpace(realSpace, 'my-space', {
    registry,
    transport: { adapter: 'in-process', hub, peerId: 'alice-alias' },
  });

  assert.notDeepEqual(aliasIdentity.signingPub, realIdentity.signingPub);

  // The alias is a fully independent identity - it can own its own 'owner'-ACL content, with zero
  // relay-side setup (self-certifying), exactly like any other identity.
  const post = await aliasSpace.createNode(postKind, { body: 'hallo, anonym' });
  assert.equal(await post.field('body').get(), 'hallo, anonym');
});

test('bootstrapAliasSpace(): publishes the registry entry on the REAL space (so a fellow member can later resolve alias -> real)', async () => {
  const alice = await actor();
  const hub = createSharedInProcessHub();
  const registry = new AdapterRegistry();
  registerMemoryAdapters(registry);

  const { space: realSpace } = await bootstrapSpace({
    registry,
    identity: alice,
    transport: { adapter: 'in-process', hub, peerId: 'alice-real-2' },
  });

  const { identity: aliasIdentity } = await bootstrapAliasSpace(realSpace, 'another-space', {
    registry,
    transport: { adapter: 'in-process', hub, peerId: 'alice-alias-2' },
  });

  const registryNode = realSpace.getNode(aliasRegistryNodeId(alice.signingPub));
  assert.ok(registryNode, 'the real space should have the registry Node attached after bootstrapAliasSpace()');
  assert.equal(await registryNode.field('aliasPub').get(), QuCrypto.toBase64(aliasIdentity.signingPub));
  assert.equal(registryNode.kind, aliasRegistryKind.kind);
});

test('bootstrapAliasSpace(): an "identity" passed in config is ignored - the derived alias always wins', async () => {
  const alice = await actor();
  const impostor = await actor();
  const hub = createSharedInProcessHub();
  const registry = new AdapterRegistry();
  registerMemoryAdapters(registry);

  const { space: realSpace } = await bootstrapSpace({
    registry,
    identity: alice,
    transport: { adapter: 'in-process', hub, peerId: 'alice-real-3' },
  });

  const { identity: aliasIdentity } = await bootstrapAliasSpace(realSpace, 'yet-another-space', {
    registry,
    identity: impostor, // must be ignored.
    transport: { adapter: 'in-process', hub, peerId: 'alice-alias-3' },
  });

  assert.notDeepEqual(aliasIdentity.signingPub, impostor.signingPub);
});
