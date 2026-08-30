/**
 * UNDECRYPTABLE HISTORY — a real, previously-uncaught bug this Task fixes:
 * a `'members'`-mode, `visibility: 'encrypted'` Kind's history sealed
 * BEFORE some identity became a Space member is - by design - never
 * decryptable by that identity (`openUpdate()` throws, see envelope.js's
 * own doc comment: it was never in the writer's `recipientXPubKeys` at
 * write time, no later event can retroactively add it as a recipient of
 * an ALREADY-SEALED envelope). That is expected and correct. What was NOT
 * correct: `Space._handleIncoming()`/`_hydrateFromStorage()` let
 * `openUpdate()`'s exception escape UNCAUGHT - an unhandled promise
 * rejection on every such envelope (which crashes a real Node.js process
 * by default, Node >=15 - a very plausible read on "incoming messages
 * just silently stop rendering, one-sidedly," if a real deployment's
 * relay ever replays history from before a peer joined, e.g. after a
 * relay restart or a stale on-disk mirror).
 *
 * This is a related but SEPARATE fact from Yjs' own strict per-author
 * clock ordering (see grant.js's "WRITE-BEFORE-GRANT IS A TRAP" doc
 * comment): once one update from an author is never integrated into a
 * peer's local doc, no LATER update from that same author's same local
 * `Y.Doc` can integrate there either - this fix stops the CRASH, it does
 * not (cannot) retroactively let a peer decrypt history it was never a
 * recipient of. The two tests below prove each half separately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '../src/index.js';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const chatKind = defineKind('chat', { fields: { messages: { shape: 'list' } } }); // default visibility: 'encrypted' - the case that can throw.

test('a late-joining member does not crash the process when the relay replays history sealed before they were a recipient', async () => {
  const alice = await actor();
  const bob = await actor();

  const hub = createInProcessHub();
  const relayMembers = [{ pub: alice.signingPub, xPub: alice.xPublicKey }]; // bob not yet known to the relay either.
  const relay = createRelayForwarder({ hub, members: relayMembers, resolveKindSchema: () => chatKind, storage: createMemoryStore() });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  await aliceTransport.connect();
  // alice's own Space also doesn't know about bob yet - her write below encrypts ONLY for herself.
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport });
  const aliceNode = aliceSpace.subscribeNode('room', chatKind);
  await aliceNode.field('messages').push('sealed before bob was a member');
  await new Promise((resolve) => setTimeout(resolve, 30));

  let unhandled = null;
  const onUnhandledRejection = (err) => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    // bob now connects and subscribes - the relay replays the ABOVE envelope to him, which he
    // cannot decrypt (he was never a recipient). Before this fix, this threw uncaught.
    relay.addMember({ pub: bob.signingPub, xPub: bob.xPublicKey });
    const bobTransport = new InProcessTransport(hub, 'bob');
    await bobTransport.connect();
    const bobBus = { calls: [], emit: async (topic, payload) => bobBus.calls.push({ topic, payload }) };
    const bobSpace = new Space({
      identity: bob,
      members: [
        { pub: alice.signingPub, xPub: alice.xPublicKey },
        { pub: bob.signingPub, xPub: bob.xPublicKey },
      ],
      transport: bobTransport,
      bus: bobBus,
    });
    const bobNode = bobSpace.subscribeNode('room', chatKind);
    await waitUntil(() => bobBus.calls.some((c) => c.topic === 'debug.space.write.remote.undecryptable'));

    assert.equal(unhandled, null, 'openUpdate() failing for a non-recipient must not become an unhandled promise rejection');
    assert.equal(bobNode.field('messages').length, 0); // never applied - correctly so, he wasn't a recipient of it.
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('loadNode() skips an undecryptable envelope in local storage instead of aborting the rest of the hydration loop', async () => {
  const alice = await actor();
  const bob = await actor();
  const aliceTransport = soloTransport();

  const memoryStore = (() => {
    const log = new Map();
    return {
      async append(nodeId, envelope) {
        const list = log.get(nodeId) ?? [];
        list.push(envelope);
        log.set(nodeId, list);
      },
      async load(nodeId) {
        return [...(log.get(nodeId) ?? [])];
      },
    };
  })();

  // alice writes ONE envelope encrypted only for herself, directly into the shared store bob will
  // later read from - simulating a relay-mirrored/pre-existing envelope bob was never a recipient of.
  const aliceSpace = new Space({ identity: alice, members: [{ pub: alice.signingPub, xPub: alice.xPublicKey }], transport: aliceTransport, storage: memoryStore });
  const node = await aliceSpace.createNode(chatKind, {}, { id: 'room-gap' });
  await node.field('messages').push('alice-only');
  await new Promise((resolve) => setTimeout(resolve, 30));

  const bobTransport = soloTransport();
  const bobSpace = new Space({
    identity: bob,
    members: [
      { pub: alice.signingPub, xPub: alice.xPublicKey },
      { pub: bob.signingPub, xPub: bob.xPublicKey },
    ],
    transport: bobTransport,
    storage: memoryStore,
  });

  // Must not throw - before this fix, openUpdate() failing inside _hydrateFromStorage()'s loop
  // propagated straight out of loadNode() itself.
  await assert.doesNotReject(() => bobSpace.loadNode('room-gap', chatKind));
});

/** A transport that goes nowhere - these two tests only need each Space to talk to its OWN local `storage`, never to each other. */
function soloTransport() {
  return { async connect() {}, send: () => {}, onMessage: () => {} };
}
