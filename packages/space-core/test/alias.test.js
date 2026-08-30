/**
 * SPACE-SCOPED ALIAS IDENTITIES — see alias.js's own doc comment for the
 * full design. Proves, at the space-core level (no relay needed - a
 * bare peer<->peer harness, same as acl.test.js):
 *   1. deriveAliasIdentity() is deterministic per (identity, spaceId) and
 *      unrelated across different spaceIds.
 *   2. An alias is a REAL, independently usable identity - it can own an
 *      'owner'-ACL Node, and a peer with no knowledge of the mapping sees
 *      only the alias pubkey as author.
 *   3. publishAlias() + AliasRegistry: a Space member who subscribes to
 *      the registry Node resolves alias -> real; one who never does
 *      (an "outsider" relative to that specific registry entry) cannot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { Space } from '../src/space.js';
import { EventBus } from '@qu/events';
import { deriveAliasIdentity, aliasRegistryKind, aliasRegistryNodeId, publishAlias, AliasRegistry } from '../src/alias.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function pairTransports() {
  let aOnMessage = null;
  let bOnMessage = null;
  const a = {
    async connect() {},
    send(data) {
      queueMicrotask(() => bOnMessage?.({ data }));
    },
    onMessage(cb) {
      aOnMessage = cb;
    },
  };
  const b = {
    async connect() {},
    send(data) {
      queueMicrotask(() => aOnMessage?.({ data }));
    },
    onMessage(cb) {
      bOnMessage = cb;
    },
  };
  return [a, b];
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('deriveAliasIdentity() is deterministic per (identity, spaceId), and unrelated across different spaceIds', async () => {
  const alice = await actor();
  const alias1a = await deriveAliasIdentity(alice, 'space-1');
  const alias1b = await deriveAliasIdentity(alice, 'space-1');
  assert.deepEqual(alias1a.signingPub, alias1b.signingPub); // same identity, same space -> same alias, every time.
  assert.deepEqual(alias1a.xPublicKey, alias1b.xPublicKey);

  const alias2 = await deriveAliasIdentity(alice, 'space-2');
  assert.notDeepEqual(alias1a.signingPub, alias2.signingPub); // different space -> unrelated alias.

  const bob = await actor();
  const bobAlias1 = await deriveAliasIdentity(bob, 'space-1');
  assert.notDeepEqual(alias1a.signingPub, bobAlias1.signingPub); // different real identity -> unrelated alias, even in the SAME space.
});

test('an alias is a real, independent identity: it can own an owner-ACL Node, verifiable with zero knowledge of who really controls it', async () => {
  const alice = await actor();
  const aliasIdentity = await deriveAliasIdentity(alice, 'my-space');
  const postKind = defineKind('post', { fields: { body: { shape: 'text', visibility: 'public' } }, acl: { write: 'owner' } });

  const [aliceTransport, readerTransport] = pairTransports();
  const aliasSpace = new Space({ identity: aliasIdentity, members: [], transport: aliceTransport });
  const post = await aliasSpace.createNode(postKind, {});
  post.field('body').insert(0, 'Anonymous-ish post');

  // A reader who never learned the alias->real mapping subscribes and reads the content just
  // fine (it's 'public' visibility) - but the only author identity they can ever observe is the
  // ALIAS pubkey, structurally - alice's real pubkey never appears anywhere in this envelope.
  const readerSpace = new Space({ identity: alice, members: [], transport: readerTransport });
  const readerNode = readerSpace.subscribeNode(post.id, postKind);
  await waitUntil(() => readerNode.field('body').get() === 'Anonymous-ish post');

  assert.deepEqual(readerNode.meta.get('ownerPub'), aliasIdentity.signingPub);
  assert.notDeepEqual(readerNode.meta.get('ownerPub'), alice.signingPub);
});

test('publishAlias() + AliasRegistry: a subscribed Space member resolves alias -> real; a non-subscribed one cannot', async () => {
  const alice = await actor();
  const bob = await actor();
  const carol = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];

  // A tiny 3-peer star, alice in the middle relaying raw messages to both others - good enough to
  // prove encryption-scoped resolution without needing a full relay.
  const aliceBobLink = pairTransports();
  const aliceCarolLink = pairTransports();
  const aliceBus = new EventBus();
  const aliceSpace = new Space({
    identity: alice,
    members,
    transport: {
      async connect() {},
      send(data) {
        aliceBobLink[0].send(data);
        aliceCarolLink[0].send(data);
      },
      onMessage(cb) {
        aliceBobLink[0].onMessage(cb);
        aliceCarolLink[0].onMessage(cb);
      },
    },
    bus: aliceBus,
  });
  const bobBus = new EventBus();
  const bobSpace = new Space({ identity: bob, members, transport: aliceBobLink[1], bus: bobBus });
  const carolBus = new EventBus();
  const carolSpace = new Space({ identity: carol, members, transport: aliceCarolLink[1], bus: carolBus });

  // bob subscribes to alice's (not-yet-published) registry entry BEFORE she publishes it - this is
  // a bare peer<->peer harness with no relay/mirror in the loop (see e.g. dynamic-membership.test.js's
  // own reordering for the exact same reason), so a subscribe AFTER the fact would have no catch-up
  // path to fall back on. The nodeId is a pure function of alice's pubkey, so bob can know it upfront.
  const registryNodeId = aliasRegistryNodeId(alice.signingPub);
  const bobRegistry = new AliasRegistry(bobSpace, bobBus);
  bobSpace.subscribeNode(registryNodeId, aliasRegistryKind);
  const carolRegistry = new AliasRegistry(carolSpace, carolBus);
  // carol deliberately never subscribes to alice's registry Node - she stays an "outsider" to this one fact.

  const spaceId = 'shared-space';
  const alias = await publishAlias(aliceSpace, spaceId);
  await waitUntil(async () => (await aliceSpace.getNode(registryNodeId).field('aliasPub').get()) === QuCrypto.toBase64(alias.signingPub));

  const aliasPubB64 = QuCrypto.toBase64(alias.signingPub);
  await waitUntil(() => bobRegistry.resolve(aliasPubB64) === QuCrypto.toBase64(alice.signingPub));

  await new Promise((resolve) => setTimeout(resolve, 30)); // give carol's (absent) subscription a chance to matter, if it were going to
  assert.equal(carolRegistry.resolve(aliasPubB64), undefined);
});
