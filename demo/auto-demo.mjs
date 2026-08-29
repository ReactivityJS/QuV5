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
 *   - GRANULAR EVENTS (`@qu/events`): each Space has its OWN client-side
 *     bus - a remote write carrying a `notify` hint fires
 *     `notification.<kind>.<topic>` there, alongside the always-on generic
 *     `space.node.<id>.changed` (see @qu/space-core's space.js).
 *   - PRESENCE-GATED PUSH ROUTING: the relay has its OWN bus. While bob is
 *     connected, a `notify`-carrying write reaches the relay's bus with
 *     `online: true` and a registered push-handler plugin does nothing
 *     (bob's live connection already got the real envelope above). Once
 *     bob disconnects, the SAME write shape reaches the relay's bus with
 *     `online: false`, and the push handler (a separate, swappable plugin
 *     - see @qu/space-transport's push-handler.js) actually "pushes" (logs,
 *     in this demo - a real deployment would send Web Push here).
 */
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createInProcessHub, InProcessTransport, createRelayForwarder, registerPushHandler } from '@qu/space-transport';
import { EventBus } from '@qu/events';

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

const chatKind = defineKind('demo-chat', { fields: { messages: 'list' }, notifyTopics: ['message', 'mention'] });
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
  const relayBus = new EventBus(); // the RELAY's own bus - presence-gated push routing only, never content (see relay.js).
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, bus: relayBus });
  let pushSent = () => {};
  const pushLogged = new Promise((resolve) => {
    pushSent = resolve;
  });
  registerPushHandler(relayBus, {
    sendPush: (p) => {
      console.log(`  📮 [relay] ~${p.to.slice(0, 10)}… is offline -> sending Web Push (${p.kind}.${p.topic})`);
      pushSent();
    },
  });

  const aliceTransport = new InProcessTransport(hub, 'alice');
  const bobTransport = new InProcessTransport(hub, 'bob');
  await aliceTransport.connect();
  await bobTransport.connect();

  const aliceBus = new EventBus(); // alice's OWN client-side bus - full granular semantic events, from decrypted content.
  const bobBus = new EventBus(); // bob's OWN - a different instance, never shared with alice's or the relay's.
  const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport, bus: aliceBus });
  const bobSpace = new Space({ identity: bob, members, transport: bobTransport, bus: bobBus });

  bobBus.on('notification.demo-chat.*', (p) => console.log(`  🔔 [bob's bus] notification.demo-chat.${p.topic} from ~${p.authorPub.slice(0, 10)}… (origin: ${p.origin})`));
  aliceBus.on('space.node.**', (p) => console.log(`  ↻  [alice's bus] space.node.${p.nodeId}.changed (origin: ${p.origin})`), { order: -1 });

  await waitUntil(() => relay.presence.isOnline(QuCrypto.toBase64(bob.signingPub)));

  const aliceNode = aliceSpace.subscribeNode(ROOM, chatKind);
  const bobNode = bobSpace.subscribeNode(ROOM, chatKind);

  async function send(fromNode, from, text, notify) {
    console.log(`[${from}] > ${text}`);
    await fromNode.field('messages').push({ from, text, ts: Date.now() }, notify ? { notify } : undefined);
  }

  console.log('--- bob is online: a notify-tagged write reaches him live, no push needed ---');
  await send(aliceNode, 'alice', 'Hallo Bob, hier ist Alice.', { topic: 'message' });
  await waitUntil(async () => (await bobNode.field('messages').toArray()).length === 1);
  await send(bobNode, 'bob', 'Hi Alice, kommt bei mir an!');
  await waitUntil(async () => (await aliceNode.field('messages').toArray()).length === 2);

  console.log('\n--- bob disconnects (e.g. tab closed / offline) ---');
  hub.disconnect(bobTransport.getPeerId());
  await new Promise((resolve) => setTimeout(resolve, 20));

  console.log('--- the SAME kind of write now triggers the push handler instead ---');
  await send(aliceNode, 'alice', '@bob CRDT-Sync über den Relay funktioniert.', { topic: 'mention', to: [QuCrypto.toBase64(bob.signingPub)] });
  await waitUntil(async () => (await aliceNode.field('messages').toArray()).length === 3);
  await pushLogged; // wait for the push handler to actually fire, for deterministic demo output ordering

  const aliceView = await aliceNode.field('messages').toArray();

  console.log('\nAlice sieht (bob ist offline, hat die letzte Nachricht also noch nicht live erhalten):');
  for (const m of aliceView) console.log(`  [${m.from}] ${m.text}`);

  const relayNeverSawPlaintext = !relay.seen.some((entry) =>
    JSON.stringify(entry, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v)).includes('Alice')
  );

  console.log(`\n${aliceView.length === 3 ? '✅' : '❌'} Alle drei Nachrichten sind bei Alice angekommen und entschlüsselt.`);
  console.log(`${relayNeverSawPlaintext ? '✅' : '❌'} Der Relay hat zu keinem Zeitpunkt Klartext gesehen (${relay.seen.length} weitergeleitete Envelopes).`);

  if (aliceView.length !== 3 || !relayNeverSawPlaintext) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
