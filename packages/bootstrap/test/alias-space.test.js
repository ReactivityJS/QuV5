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
import { createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
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

const noteKind = defineKind('alias-space-test-note', {
  fields: { text: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'members' },
});

test('bootstrapAliasSpace(): the "join" hook lets the alias write an ordinary acl.write: "members" Kind too', async () => {
  const alice = await actor();
  const hub = createSharedInProcessHub();
  const registry = new AdapterRegistry();
  registerMemoryAdapters(registry);

  const relay = createRelayForwarder({
    hub,
    members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }],
    resolveKindSchema: () => noteKind,
    storage: createMemoryStore(),
  });

  const { space: realSpace } = await bootstrapSpace({
    registry,
    identity: alice,
    transport: { adapter: 'in-process', hub, peerId: 'alice-real-4' },
    members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }],
  });

  // The "join" hook: whatever a deployment's own relay-membership mechanism is (here, directly
  // calling the test relay's own addMember() - @qu/app-shell's real deployment would call
  // joinSpace({name, identity: alias}) against its relay's POST /join instead, see docs/
  // routing-anonymity.md) - its return value becomes the alias Space's own `members` list.
  const { space: aliasSpace, identity: aliasIdentity } = await bootstrapAliasSpace(
    realSpace,
    'members-mode-space',
    { registry, transport: { adapter: 'in-process', hub, peerId: 'alice-alias-4' } },
    {
      join: async (alias) => {
        relay.addMember({ pub: alias.signingPub, xPub: alias.xPublicKey });
        return [
          { pub: alice.signingPub, xPub: alice.xPublicKey },
          { pub: alias.signingPub, xPub: alias.xPublicKey },
        ];
      },
    }
  );

  // The alias, now a real relay-side member, writes an ordinary 'members'-ACL Node - accepted by
  // the relay (an UNJOINED alias's write would be silently rejected instead) and readable by
  // alice's REAL identity (also a member) once it syncs - proving both the relay-side and the
  // encryption-recipient sides of anonymous 'members'-mode writing work end to end.
  const node = await aliasSpace.createNode(noteKind, { text: 'anon members-mode write' }, { id: 'members-mode-note' });
  await node.field('text').set('anon members-mode write');

  const deadline = Date.now() + 2000;
  const { node: realNode } = await realSpace.useNode('members-mode-note', noteKind);
  while ((await realNode.field('text').get()) !== 'anon members-mode write' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(await realNode.field('text').get(), 'anon members-mode write');
  assert.notDeepEqual(aliasIdentity.signingPub, alice.signingPub);
});
