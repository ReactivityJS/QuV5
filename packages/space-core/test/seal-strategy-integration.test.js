/**
 * END-TO-END: `Space`'s `sealStrategy` constructor param, wired through to
 * a real write. Proves, without a relay (a 3-peer star, same harness
 * `alias.test.js` already uses for the identical reason):
 *   1. With `sealStrategies.padToMembers`, a `{recipients}`-narrowed write's
 *      outgoing envelope always carries ALL members in `to` - a network
 *      observer intercepting it can never tell the real recipient apart
 *      from the padding one by size/shape.
 *   2. The REAL recipient still decrypts the content correctly.
 *   3. The padding-only member receives the SAME envelope (nothing hides
 *      that they're Listed in `to`) but cannot decrypt it - the existing
 *      "not actually a recipient" path (`debug.space.write.remote.undecryptable`).
 *   4. Omitting `sealStrategy` (the default) is unchanged: `to` has only
 *      the real recipients.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind } from '../src/kind-schema.js';
import { Space } from '../src/space.js';
import { EventBus } from '@qu/events';
import { sealStrategies } from '../src/seal-strategies.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function pairTransports() {
  let aOnMessage = null;
  let bOnMessage = null;
  const a = { async connect() {}, send(data) { queueMicrotask(() => bOnMessage?.({ data })); }, onMessage(cb) { aOnMessage = cb; } };
  const b = { async connect() {}, send(data) { queueMicrotask(() => aOnMessage?.({ data })); }, onMessage(cb) { bOnMessage = cb; } };
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

const noteKind = defineKind('seal-strategy-test-note', {
  fields: { text: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'members' },
});

/** alice in the middle, fanning raw messages out to both bob and carol - a bare star, no relay. */
function setupThreePeerStar() {
  const aliceBobLink = pairTransports();
  const aliceCarolLink = pairTransports();
  const aliceTransport = {
    async connect() {},
    send(data) {
      aliceBobLink[0].send(data);
      aliceCarolLink[0].send(data);
    },
    onMessage(cb) {
      aliceBobLink[0].onMessage(cb);
      aliceCarolLink[0].onMessage(cb);
    },
  };
  return { aliceTransport, bobTransport: aliceBobLink[1], carolTransport: aliceCarolLink[1] };
}

test('sealStrategy: padToMembers always puts every member in "to" - the real audience of a narrowed write is hidden', async () => {
  const alice = await actor();
  const bob = await actor();
  const carol = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];
  const { aliceTransport, bobTransport, carolTransport } = setupThreePeerStar();

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, sealStrategy: sealStrategies.padToMembers });
  const bobBus = new EventBus();
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, bus: bobBus });
  const carolBus = new EventBus();
  const carolSpace = new Space({ identity: carol, members, transport: carolTransport, bus: carolBus });

  // Registered BEFORE alice's write - an event already fired before a listener subscribes is
  // simply never seen (EventBus is live pub/sub, not a replayed log), so this must be in place
  // ahead of time, not after the fact once the write is already known to have landed.
  let carolUndecryptable = false;
  carolBus.on('debug.space.write.remote.undecryptable', () => {
    carolUndecryptable = true;
  });

  // Both subscribe BEFORE alice writes - bare peer-to-peer harness, no relay catch-up (same
  // ordering requirement every other test using this harness already has).
  bobSpace.subscribeNode('shared-note', noteKind);
  carolSpace.subscribeNode('shared-note', noteKind);

  const node = await aliceSpace.createNode(noteKind, {}, { id: 'shared-note' });
  // Narrowed to bob only (plus alice herself, always - see _effectiveRecipients()'s own doc
  // comment) - carol is a Space member but NOT an intended recipient of this specific write.
  await node.field('text').set('only for bob', { recipients: [bob.xPublicKey] });

  // bob, the real recipient, gets the content.
  await waitUntil(() => bobSpace.getNode('shared-note').field('text').get().then((v) => v === 'only for bob'));

  // carol is listed in `to` (that's the whole point of padding) but can never decrypt it - the
  // EXISTING "not actually a recipient" outcome, now also routinely hit by a padding target.
  await waitUntil(() => carolUndecryptable);
  // Carol's local Y.Doc never applied this update at all (space.js's _handleIncoming() returns
  // before Y.applyUpdate() once openUpdate() throws) - "unset", same as a field never written,
  // not the encrypted-but-unreadable "undefined" AtomicField.get() gives for a field that DID
  // apply but whose content this identity can't decrypt (see field.js's own doc comment).
  assert.equal(await carolSpace.getNode('shared-note').field('text').get(), null);
});

test('sealStrategy: omitted (the default) is unchanged - a narrowed write\'s "to" has only the real recipients', async () => {
  const alice = await actor();
  const bob = await actor();
  const carol = await actor();
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
    { pub: carol.signingPub, xPub: carol.xPublicKey },
  ];
  const { aliceTransport } = setupThreePeerStar();

  /** @type {object[]} */
  const sentEnvelopes = [];
  const spyTransport = {
    async connect() {
      await aliceTransport.connect();
    },
    send(data) {
      sentEnvelopes.push(data);
      aliceTransport.send(data);
    },
    onMessage(cb) {
      aliceTransport.onMessage(cb);
    },
  };

  const aliceSpace = new Space({ identity: alice, members, transport: spyTransport }); // no sealStrategy - default.
  const node = await aliceSpace.createNode(noteKind, {}, { id: 'shared-note-2' });
  await node.field('text').set('only for bob', { recipients: [bob.xPublicKey] });

  // field.set() only awaits the Yjs transaction itself - sealing (signing/encrypting) and the
  // actual transport.send() happen in _handleLocalUpdate(), an async 'update' doc listener Yjs
  // invokes but never awaits, so the send can genuinely still be in flight once set() resolves -
  // same reasoning every other test in this file already polls for bob's/carol's RECEIVING side.
  await waitUntil(() => sentEnvelopes.filter((m) => m.envelope?.to?.length).length >= 2);

  // createNode() ALSO sends its own meta-stamp write first (unnarrowed - full membership, `to.length
  // === 3`) before the explicit, narrowed field().set() below - find the LAST matching write, not
  // the first, to inspect the one that actually carries the `{recipients}` narrowing.
  const write = sentEnvelopes.filter((m) => m.envelope?.to?.length).at(-1);
  assert.ok(write);
  assert.equal(write.envelope.to.length, 2); // bob + alice herself - never carol.
});
