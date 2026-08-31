/**
 * NODE-LEVEL ACL ENFORCEMENT ('content' mode) - `'named'`'s many-per-owner
 * counterpart (kind-schema.js's own "THE 'content' ACL mode" doc comment):
 * real, per-Node, grant-derived write-ACL for a Kind with many Nodes per
 * owner (a page per route, a template per name, ...), closing the gap
 * `acl.test.js` doesn't cover - `'members'`-mode content-addressed Kinds
 * (`@qu/app-core`'s old `qu-page`/`qu-template`/`qu-style`) let ANY Space
 * member write ANY Node, regardless of who "owns" its content-addressed
 * id. Same peer<->peer fake-transport harness `acl.test.js` already uses,
 * ZERO relay involved.
 *
 * Two-peer tests below populate real `members` lists (unlike `acl.test.js`'s
 * `'owner'`/`'named'` tests, which get away with `members: []`): `'content'`
 * mode's `metaVisibility` defaults to `'encrypted'` (kind-schema.js, same
 * default `'members'` mode already had) - decrypting it needs a real
 * recipient xPub on both sides, not just a self-certifying id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, deriveContentNodeId } from '../src/kind-schema.js';
import { Space } from '../src/space.js';
import { signGrant } from '../src/grant.js';

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

const docKind = defineKind('doc', { fields: { title: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'content' } });

test('deriveContentNodeId() is a pure, deterministic function of (ownerPub, kind, path) - different path/kind/owner all yield different ids', async () => {
  const alice = await actor();
  const id1 = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const id2 = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  assert.equal(id1, id2);
  assert.ok(id1.startsWith('~content:'));

  const idOtherPath = await deriveContentNodeId(alice.signingPub, 'doc', '/world');
  assert.notEqual(id1, idOtherPath);

  const bob = await actor();
  const idBob = await deriveContentNodeId(bob.signingPub, 'doc', '/hello');
  assert.notEqual(id1, idBob);
});

test("createNode() on a 'content'-ACL kind requires path, derives the id itself, and self-grants so the creator can write immediately", async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const space = new Space({ identity: alice, members: [], transport: aliceTransport });

  await assert.rejects(() => space.createNode(docKind, { title: 'v1' }), /path.*required/);

  const node = await space.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  const expectedId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  assert.equal(node.id, expectedId);
  assert.equal(await node.field('title').get(), 'v1');

  // The creator can keep writing without ever calling grantWriter() themselves - createNode()
  // already issued the self-grant.
  await node.field('title').set('v2');
  assert.equal(await node.field('title').get(), 'v2');
});

test("'content'-ACL: a DIFFERENT owner's write to alice's own content-addressed node is rejected - unlike the old 'members'-mode behavior, owning the CONTENT (not just being a Space member) is what matters", async () => {
  const alice = await actor();
  const mallory = await actor();
  const [aliceTransport, malloryTransport] = pairTransports();

  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: mallory.signingPub, xPub: mallory.xPublicKey }], transport: aliceTransport });
  // mallory IS a Space member (would have been enough under the old flat 'members'-ACL) but has no
  // grant for THIS Node. Subscribes BEFORE alice creates it - the self-certifying id is a pure
  // function of (ownerPub, kind, path), computable up front - so her copy converges live with
  // alice's initial write, rather than racing a real catch-up mechanism this bare peer<->peer
  // harness (no relay/replay in the loop) doesn't provide (same pattern acl.test.js's own
  // 'named'-ACL tests use).
  const mallorySpace = new Space({ identity: mallory, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: mallory.signingPub, xPub: mallory.xPublicKey }], transport: malloryTransport });
  const nodeId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const malloryNode = mallorySpace.subscribeNode(nodeId, docKind);
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  await waitUntil(async () => (await malloryNode.field('title').get()) === 'v1');

  await malloryNode.field('title').set('hacked-by-mallory');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await aliceNode.field('title').get(), 'v1'); // unchanged - mallory's write was dropped.
});

test("'content'-ACL: a writer explicitly granted (with the matching path) BEFORE their first write is accepted", async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();

  const spaceMembers = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const aliceSpace = new Space({ identity: alice, members: spaceMembers, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const nodeId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const bobNode = bobSpace.subscribeNode(nodeId, docKind);
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  await aliceSpace.grantWriter(aliceNode.id, 'doc', bob.signingPub, { path: '/hello' });

  await bobNode.field('title').set('edited by bob, with permission');
  await waitUntil(async () => (await aliceNode.field('title').get()) === 'edited by bob, with permission');
});

test("'content'-ACL: a grant with the WRONG path is rejected by verifyGrant() (it recomputes a different, non-matching nodeId)", async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();

  const spaceMembers = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const aliceSpace = new Space({ identity: alice, members: spaceMembers, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const nodeId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const bobNode = bobSpace.subscribeNode(nodeId, docKind);
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  // alice tries to grant bob write access to /hello but mistypes the path - the resulting message
  // doesn't self-certify against aliceNode.id at all, so verifyGrant() (used by _applyGrant()) drops it.
  await aliceSpace.grantWriter(aliceNode.id, 'doc', bob.signingPub, { path: '/wrong-path' });

  await bobNode.field('title').set('should still be rejected');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await aliceNode.field('title').get(), 'v1');
});

test("'content'-ACL: a grant forged by a non-owner is rejected and never authorizes anything", async () => {
  const alice = await actor();
  const bob = await actor();
  const mallory = await actor();
  const [aliceTransport, bobTransport] = pairTransports();

  const spaceMembers = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const aliceSpace = new Space({ identity: alice, members: spaceMembers, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const nodeId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const bobNode = bobSpace.subscribeNode(nodeId, docKind);
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' }, { path: '/hello' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  const forgedGrant = await signGrant({ nodeId: aliceNode.id, kind: 'doc', granteePub: bob.signingPub, path: '/hello' }, mallory);
  await aliceSpace._applyGrant(forgedGrant);

  await bobNode.field('title').set('should still be rejected');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await aliceNode.field('title').get(), 'v1');
});

test("'content'-ACL: two different paths under the SAME owner are independent Nodes with independent grants", async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();

  const spaceMembers = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const aliceSpace = new Space({ identity: alice, members: spaceMembers, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: spaceMembers, transport: bobTransport });

  const helloId = await deriveContentNodeId(alice.signingPub, 'doc', '/hello');
  const worldId = await deriveContentNodeId(alice.signingPub, 'doc', '/world');
  const bobHello = bobSpace.subscribeNode(helloId, docKind);
  const bobWorld = bobSpace.subscribeNode(worldId, docKind);

  const helloNode = await aliceSpace.createNode(docKind, { title: 'hello v1' }, { path: '/hello' });
  const worldNode = await aliceSpace.createNode(docKind, { title: 'world v1' }, { path: '/world' });
  assert.notEqual(helloNode.id, worldNode.id);

  await waitUntil(async () => (await bobHello.field('title').get()) === 'hello v1');
  await waitUntil(async () => (await bobWorld.field('title').get()) === 'world v1');

  // bob is granted write access to /hello only.
  await aliceSpace.grantWriter(helloNode.id, 'doc', bob.signingPub, { path: '/hello' });

  await bobHello.field('title').set('hello v2, edited by bob');
  await waitUntil(async () => (await helloNode.field('title').get()) === 'hello v2, edited by bob');

  await bobWorld.field('title').set('should be rejected - no grant for /world');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await worldNode.field('title').get(), 'world v1');
});
