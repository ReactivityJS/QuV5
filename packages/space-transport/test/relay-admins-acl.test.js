/**
 * NODE-LEVEL ACL ENFORCEMENT, RELAY-SIDE ('relay-admins' mode) - the
 * @qu/space-transport counterpart to @qu/space-core's own acl.test.js:
 * proves `relay.js`'s `buildWriteAcl()`/`handleSubscribe()` enforce
 * `acl.write: 'relay-admins'` (kind-schema.js's own doc comment on the
 * mode) correctly through a real relay - a configured relay-admin may
 * write, a Space member who ISN'T a configured relay-admin may not (even
 * though `'members'`-mode would have let them), and reading/subscribing
 * never requires membership at all (any visitor can resolve
 * `@qu/app-core`'s `qu-platform-apps`, the reference use of this mode,
 * without joining anything).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createMemoryStore } from '@qu/space-storage';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '../src/index.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const registryKind = Object.freeze({
  ...defineKind('registry', { fields: { entries: { shape: 'list', visibility: 'public' } }, acl: { write: 'relay-admins' } }),
  metaVisibility: 'public', // same publicMeta()-style override @qu/app-core's platformAppsKind uses - see kinds.js's own doc comment.
});
const FIXED_ID = '~fixed-registry-anchor'; // 'relay-admins' Node ids carry no ownership meaning (kind-schema.js's own doc comment) - any stable string works.

test("relay: 'relay-admins'-ACL - a configured relay-admin's write is accepted; a Space member who is NOT a configured relay-admin is rejected", async () => {
  const relayAdmin = await actor();
  const ordinaryMember = await actor();
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }, { pub: ordinaryMember.signingPub, xPub: ordinaryMember.xPublicKey }];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const rejections = [];
  const { EventBus } = await import('@qu/events');
  const bus = new EventBus();
  bus.on('debug.relay.write.rejected', (p) => rejections.push(p));
  const relay = createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema: () => registryKind, bus, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const adminSpace = await connect(relayAdmin, 'relay-admin');
  const memberSpace = await connect(ordinaryMember, 'ordinary-member');

  const adminNode = await adminSpace.createNode(registryKind, {}, { id: FIXED_ID });
  await adminNode.field('entries').push({ from: 'relay-admin' });
  await waitUntil(() => relay.seen.some((e) => e.nodeId === FIXED_ID));

  const memberNode = memberSpace.subscribeNode(FIXED_ID, registryKind);
  await waitUntil(async () => (await memberNode.field('entries').toArray()).length === 1);

  // ordinaryMember IS a Space member (the OLD 'members'-mode would have accepted this write) but is
  // NOT a configured relay-admin - the relay must reject it regardless.
  await memberNode.field('entries').push({ from: 'ordinary-member' });
  await waitUntil(() => rejections.some((r) => r.nodeId === FIXED_ID));
  assert.equal((await adminNode.field('entries').toArray()).length, 1, 'the unauthorized write never actually landed');
});

test("relay: 'relay-admins'-ACL - subscribing/reading needs no Space membership at all", async () => {
  const relayAdmin = await actor();
  const outsider = await actor(); // never in `members` at all.
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema: () => registryKind, storage: createMemoryStore() });

  const adminTransport = new InProcessTransport(hub, 'relay-admin');
  await adminTransport.connect();
  const adminSpace = new Space({ identity: relayAdmin, members, relayAdmins, transport: adminTransport });
  const adminNode = await adminSpace.createNode(registryKind, {}, { id: FIXED_ID });
  await adminNode.field('entries').push({ from: 'relay-admin' });

  const outsiderTransport = new InProcessTransport(hub, 'outsider');
  await outsiderTransport.connect();
  // outsider is in NEITHER `members` NOR the relay's own write-ACL sense of "a relay-admin" - it
  // just needs to know WHICH pubkeys count as relay-admins to independently verify their writes
  // (this Space's own `_isAuthorizedWriter()`, never just trusting the relay - the same public
  // info `GET /relay-admins.json` publishes for exactly this purpose, see relay-server.js's own doc
  // comment), same as it would need to know `members` to verify a `'members'`-ACL write.
  const outsiderSpace = new Space({ identity: outsider, members: [], relayAdmins, transport: outsiderTransport });
  const outsiderNode = outsiderSpace.subscribeNode(FIXED_ID, registryKind);
  await waitUntil(async () => (await outsiderNode.field('entries').toArray()).length === 1);
});
