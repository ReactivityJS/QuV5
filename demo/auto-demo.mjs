#!/usr/bin/env node
/**
 * AUTO DEMO — `npm run demo`. Zero setup, one process: simulates two peers
 * ("alice" and "bob") exchanging chat messages through an in-process relay,
 * using the exact same @qu/space-core/@qu/space-transport code path the
 * real, two-terminal `chat.mjs` demo uses over a real WebSocket relay (see
 * `demo/README.md`). This script exists so the build is provably testable
 * with a single command, no relay process or second terminal required.
 *
 * What it proves, end to end:
 *   - Two independently-generated identities (Ed25519+X25519 keypairs)
 *     exchange signed, encrypted messages through a relay that verifies
 *     signatures but never decrypts anything.
 *   - Each peer is identified by its Qu pubkey fingerprint
 *     (`QuCrypto.fingerprint()`), not a raw key or a trusted username.
 *   - Messages converge: both peers end up with the identical, decrypted
 *     message list.
 */
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '@qu/space-transport';

async function actor(name) {
  const kp = await QuCrypto.generateKeypair();
  const fingerprint = await QuCrypto.fingerprint(kp.publicKey);
  return { name, fingerprint, signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

const chatKind = defineKind('demo-chat', { fields: { messages: 'list' } });
const ROOM = 'auto-demo-room';

async function main() {
  const alice = await actor('alice');
  const bob = await actor('bob');
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];

  console.log('Qu V5 — Yjs-native text exchange demo (in-process, no setup)\n');
  console.log(`  alice  fingerprint: ${alice.fingerprint}`);
  console.log(`  bob    fingerprint: ${bob.fingerprint}\n`);

  const hub = createInProcessHub();
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => true });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();

  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

  const aliceNode = aliceSpace.subscribeNode(ROOM, chatKind);
  const bobNode = bobSpace.subscribeNode(ROOM, chatKind);

  async function send(fromNode, from, text) {
    console.log(`[${from}] > ${text}`);
    await fromNode.field('messages').push({ from, text, ts: Date.now() });
  }

  await send(aliceNode, 'alice', 'Hallo Bob, hier ist Alice.');
  await waitUntil(async () => (await bobNode.field('messages').toArray()).length === 1);
  await send(bobNode, 'bob', 'Hi Alice, kommt bei mir an!');
  await waitUntil(async () => (await aliceNode.field('messages').toArray()).length === 2);
  await send(aliceNode, 'alice', 'CRDT-Sync über den Relay funktioniert.');
  await waitUntil(async () => (await bobNode.field('messages').toArray()).length === 3);

  const aliceView = await aliceNode.field('messages').toArray();
  const bobView = await bobNode.field('messages').toArray();

  console.log('\nAlice sieht:');
  for (const m of aliceView) console.log(`  [${m.from}] ${m.text}`);
  console.log('\nBob sieht:');
  for (const m of bobView) console.log(`  [${m.from}] ${m.text}`);

  const converged = JSON.stringify(aliceView) === JSON.stringify(bobView);
  const relayNeverSawPlaintext = !relay.seen.some((entry) =>
    JSON.stringify(entry, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v)).includes('Alice')
  );

  console.log(`\n${converged ? '✅' : '❌'} Alice und Bob sehen identische, entschlüsselte Nachrichten.`);
  console.log(`${relayNeverSawPlaintext ? '✅' : '❌'} Der Relay hat zu keinem Zeitpunkt Klartext gesehen (${relay.seen.length} weitergeleitete Envelopes).`);

  if (!converged || !relayNeverSawPlaintext) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
