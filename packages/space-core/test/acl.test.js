/**
 * NODE-LEVEL ACL ENFORCEMENT ('owner'/'named' modes) - proves the two new
 * `acl.write` modes actually gate writes end-to-end through `Space`, with
 * ZERO relay involved (see space.js's own `_isAuthorizedWriter()` doc
 * comment) - `deriveOwnerNodeId()` (kind-schema.js) and `grant`
 * messages (grant.js) are exercised exactly as a real two-peer sync would
 * hit them, using the same peer<->peer fake-transport harness space.test.js
 * already uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, deriveOwnerNodeId } from '../src/kind-schema.js';
import { Space } from '../src/space.js';

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

test('deriveOwnerNodeId() is a pure, deterministic function of (ownerPub, kind) - not a registry lookup', async () => {
  const alice = await actor();
  const idA1 = await deriveOwnerNodeId(alice.signingPub, 'profile');
  const idA2 = await deriveOwnerNodeId(alice.signingPub, 'profile');
  assert.equal(idA1, idA2);
  assert.ok(idA1.startsWith('~'));

  const idOtherKind = await deriveOwnerNodeId(alice.signingPub, 'blog');
  assert.notEqual(idA1, idOtherKind); // same owner, different kind -> different Node id.

  const bob = await actor();
  const idBob = await deriveOwnerNodeId(bob.signingPub, 'profile');
  assert.notEqual(idA1, idBob); // different owner, same kind -> different Node id.
});

test("createNode() on an 'owner'-ACL kind auto-derives the self-certifying nodeId, ignoring any explicit {id}", async () => {
  const alice = await actor();
  const [aliceTransport] = pairTransports();
  const profileKind = defineKind('profile', { fields: { alias: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'owner' } });
  const space = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });

  const node = await space.createNode(profileKind, { alias: 'alice' }, { id: 'this-should-be-ignored' });
  const expectedId = await deriveOwnerNodeId(alice.signingPub, 'profile');
  assert.equal(node.id, expectedId);
  assert.notEqual(node.id, 'this-should-be-ignored');
});

test("'owner'-ACL: the derived owner may write; a different peer's write to the SAME nodeId is rejected and never applied", async () => {
  const alice = await actor();
  const mallory = await actor();
  const [aliceTransport, malloryTransport] = pairTransports();
  const profileKind = defineKind('profile', { fields: { alias: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'owner' } });

  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });
  const aliceNode = await aliceSpace.createNode(profileKind, { alias: 'alice' });

  const mallorySpace = new Space({ identity: mallory, members: [], transport: malloryTransport });
  const malloryNode = mallorySpace.subscribeNode(aliceNode.id, profileKind);

  // mallory forges a write to alice's own owner-node id - her signature is real (it's HER key),
  // but she is not the pubkey that nodeId cryptographically commits to.
  await malloryNode.field('alias').set('hacked-by-mallory');

  await new Promise((resolve) => setTimeout(resolve, 30)); // give a wrongly-accepted write a chance to land
  assert.equal(await aliceNode.field('alias').get(), 'alice'); // unchanged - mallory's write was dropped before touching the CRDT.
});

test("'named'-ACL: a non-granted writer's update is rejected and never applied", async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  const docKind = defineKind('doc', { fields: { title: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'named' } });

  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });

  const nodeId = await deriveOwnerNodeId(alice.signingPub, 'doc');
  const bobNode = bobSpace.subscribeNode(nodeId, docKind);
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  await bobNode.field('title').set('not allowed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await aliceNode.field('title').get(), 'v1');
});

test("'named'-ACL: a writer GRANTED BEFORE their first write is accepted", async () => {
  const alice = await actor();
  const bob = await actor();
  const [aliceTransport, bobTransport] = pairTransports();
  const docKind = defineKind('doc', { fields: { title: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'named' } });

  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });

  // The self-certifying nodeId is a PURE function of (ownerPub, kind) - bob can compute it and
  // subscribe up front, no round-trip to alice needed (see kind-schema.js's own doc comment).
  // Subscribing BEFORE alice creates the Node also means bob's copy converges live with alice's
  // initial write, rather than racing a real catch-up mechanism this bare peer<->peer harness
  // (no relay/mirror in the loop, unlike @qu/space-transport's own tests) doesn't provide.
  const nodeId = await deriveOwnerNodeId(alice.signingPub, 'doc');
  const bobNode = bobSpace.subscribeNode(nodeId, docKind);
  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' });
  await waitUntil(async () => (await bobNode.field('title').get()) === 'v1');

  // Alice (the real owner - the only identity capable of producing a signature verifyGrant()
  // accepts for this nodeId) authorizes bob BEFORE he ever attempts a write. This ordering
  // matters for a reason that has nothing to do with this ACL check: Yjs itself applies each
  // author's updates as a strictly ordered per-author sequence (see grant.js's own doc comment,
  // "WRITE-BEFORE-GRANT IS A TRAP") - a writer who is rejected once can never have a LATER update
  // from that same local Y.Doc accepted by that same peer either, grant or no grant.
  await aliceSpace.grantWriter(nodeId, 'doc', bob.signingPub);

  await bobNode.field('title').set('now allowed');
  await waitUntil(async () => (await aliceNode.field('title').get()) === 'now allowed');
});

test("'named'-ACL: a grant message forged by a non-owner is rejected by verifyGrant() and never authorizes anything", async () => {
  const alice = await actor();
  const bob = await actor();
  const mallory = await actor(); // not the owner of aliceNode - tries to grant bob write access anyway.
  const [aliceTransport, bobTransport] = pairTransports();
  const docKind = defineKind('doc', { fields: { title: { shape: 'atomic', visibility: 'public' } }, acl: { write: 'named' } });

  const aliceSpace = new Space({ identity: alice, members: [], transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members: [], transport: bobTransport });

  const aliceNode = await aliceSpace.createNode(docKind, { title: 'v1' });
  const bobNode = bobSpace.subscribeNode(aliceNode.id, docKind);

  // mallory can sign a well-formed-LOOKING grant message, but never with alice's key -
  // grantWriter() is only ever called against one's OWN identity, so we build the forged
  // message by hand, the way a malicious relay/peer forwarding garbage would.
  const { signGrant } = await import('../src/grant.js');
  const forgedGrant = await signGrant({ nodeId: aliceNode.id, kind: 'doc', granteePub: bob.signingPub }, mallory);
  await aliceSpace._applyGrant(forgedGrant); // simulates this arriving over the wire, same path _handleIncoming() uses.

  await bobNode.field('title').set('should still be rejected');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await aliceNode.field('title').get(), 'v1');
});
