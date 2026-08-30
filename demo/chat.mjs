#!/usr/bin/env node
/**
 * DEMO CHAT CLIENT — `npm run demo:alice` / `npm run demo:bob` (or
 * `node demo/chat.mjs <name>` for any other identity). Connects to a real
 * `demo/relay.mjs` over WebSocket, joins a shared chat room (a
 * `@qu/space-core` Node with one Yjs-native `list` field), and lets you
 * type lines that sync live to every other connected client - each
 * message tagged with the sender's Qu pubkey fingerprint
 * (`QuCrypto.fingerprint()`), not just a self-reported name.
 *
 * A line starting with `@<name>` (a known member) attaches a `notify:
 * {topic: 'mention', to: [<name>'s pubkey]}` hint to the push - see
 * `@qu/space-core`'s envelope.js for what that hint is (a small,
 * deliberately UNENCRYPTED routing field, signed but not secret) and
 * `relay.mjs`, which routes it to a "would send Web Push" log when the
 * mentioned member isn't currently connected. Any other line attaches
 * `{topic: 'message'}` (broadcast to every other member, no explicit
 * `to`) - still enough for the relay to route push-vs-not per recipient.
 *
 * Usage: node demo/chat.mjs <name> [--relay ws://localhost:8081] [--room demo-room] [--dir demo/.identities]
 */
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { ensureIdentity, loadMembers, fingerprintOf, DEFAULT_IDENTITY_DIR } from './lib/identity.mjs';

function parseArgs(argv) {
  const [name, ...rest] = argv;
  const opts = { name, relay: 'ws://localhost:8081', room: 'demo-room', dir: DEFAULT_IDENTITY_DIR };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--relay') opts.relay = rest[++i];
    else if (rest[i] === '--room') opts.room = rest[++i];
    else if (rest[i] === '--dir') opts.dir = rest[++i];
  }
  return opts;
}

// MUST match relay.mjs's own defineKind() call - both processes need the identical Kind-Schema shape.
const chatKind = defineKind('demo-chat', { fields: { messages: { shape: 'list' } }, notifyTopics: ['message', 'mention'] });

async function main() {
  const { name, relay, room, dir } = parseArgs(process.argv.slice(2));
  if (!name) {
    console.error('Usage: node demo/chat.mjs <name> [--relay ws://host:port] [--room name] [--dir path]');
    process.exit(1);
  }

  const identity = await ensureIdentity(name, dir);
  const myFingerprint = await fingerprintOf(identity);
  const members = await loadMembers(dir);

  console.log(`Qu V5 — demo chat: connecting as "${name}"  [${myFingerprint}]`);
  console.log(`Known members (${members.length}): ${members.map((m) => m.name).join(', ') || '(none yet)'}`);
  if (!members.some((m) => m.name === name)) {
    console.warn(`Warning: "${name}" isn't in the member list loaded from ${dir} - restart demo:relay after adding new identities.`);
  }

  const transport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await transport.connect();
  console.log(`Connected to relay at ${relay}. Room: "${room}". Type a message and press Enter (Ctrl+C to quit).\n`);

  const space = new Space({ identity, members, transport });
  const node = space.subscribeNode(room, chatKind);

  let printed = 0;
  let printing = Promise.resolve();
  function schedulePrint() {
    printing = printing.then(async () => {
      const all = await node.field('messages').toArray();
      for (; printed < all.length; printed++) {
        const m = all[printed];
        if (m === undefined) continue; // ciphertext we're not a recipient of (shouldn't happen - we're always a member here)
        const who = m.fingerprint === myFingerprint ? 'you' : `${m.from} [${m.fingerprint}]`;
        console.log(`${new Date(m.ts).toLocaleTimeString()}  ${who}:  ${m.text}`);
      }
    });
  }

  node.field('messages').observe(schedulePrint);
  schedulePrint(); // print any history already mirrored by the relay before we connected

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return;
    const mentioned = text.match(/^@(\S+)/)?.[1];
    const mentionedMember = mentioned && members.find((m) => m.name === mentioned);
    const notify = mentionedMember
      ? { topic: 'mention', to: [QuCrypto.toBase64(mentionedMember.pub)] }
      : { topic: 'message' };
    await node.field('messages').push({ from: name, fingerprint: myFingerprint, text, ts: Date.now() }, { notify });
  });
  rl.on('close', () => {
    transport.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
