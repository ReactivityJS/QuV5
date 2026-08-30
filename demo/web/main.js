/**
 * BROWSER DEMO CLIENT — the browser counterpart to `demo/chat.mjs`, served
 * by `demo/relay.mjs` at `/` (bundled by esbuild into `bundle.js` at relay
 * startup - see that file's own doc comment). Same mechanism, same Kind-
 * Schema, same room - a browser tab and a CLI `demo:alice`/`demo:bob`
 * client can chat with each other, live, once both are members of this
 * relay's Space.
 *
 * Unlike the CLI demo (which persists an identity as a local file, shared
 * ahead of time via `demo/relay.mjs`'s own identity directory scan), a
 * browser tab GENERATES ITS OWN keypair the first time it loads (Web
 * Crypto - `QuCrypto.generateKeypair()`, the exact same primitive
 * everything else in Qu V5 uses), keeps it in `localStorage` (this
 * browser/profile only, never sent anywhere), and registers only the
 * PUBLIC halves with the relay via `POST /join` (see relay.mjs's own doc
 * comment on that endpoint) - the relay is never handed anything
 * decryptable, same guarantee as every other member.
 */
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import { EventBus, createDebugLogger } from '@qu/events';

const ROOM = 'demo-room';
// MUST match demo/chat.mjs's and demo/relay.mjs's own defineKind() call - all three need the identical Kind-Schema shape.
const chatKind = defineKind('demo-chat', { fields: { messages: 'list' }, notifyTopics: ['message', 'mention'] });

const el = {
  setup: document.getElementById('setup'),
  nameInput: document.getElementById('name-input'),
  joinButton: document.getElementById('join-button'),
  status: document.getElementById('status'),
  chat: document.getElementById('chat'),
  you: document.getElementById('you'),
  members: document.getElementById('members'),
  messages: document.getElementById('messages'),
  composeForm: document.getElementById('compose-form'),
  composeInput: document.getElementById('compose-input'),
  notifyButton: document.getElementById('notify-button'),
  debugToggle: document.getElementById('debug-toggle'),
  debugLog: document.getElementById('debug-log'),
};

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
}

// --- Identity: generate once per browser/profile, persist in localStorage. Never sent anywhere but the PUBLIC halves. ---
async function loadOrCreateIdentity(name) {
  const key = `quv5-demo-identity:${name}`;
  const raw = localStorage.getItem(key);
  if (raw) {
    const obj = JSON.parse(raw);
    return {
      name,
      signingKey: QuCrypto.fromBase64(obj.signingKey),
      signingPub: QuCrypto.fromBase64(obj.signingPub),
      xPrivateKey: QuCrypto.fromBase64(obj.xPrivateKey),
      xPublicKey: QuCrypto.fromBase64(obj.xPublicKey),
    };
  }
  const kp = await QuCrypto.generateKeypair();
  const identity = { name, signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  localStorage.setItem(
    key,
    JSON.stringify({
      signingKey: QuCrypto.toBase64(identity.signingKey),
      signingPub: QuCrypto.toBase64(identity.signingPub),
      xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
      xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
    })
  );
  return identity;
}

function renderMembers(members, myFingerprint) {
  el.members.innerHTML = '';
  for (const m of members) {
    const li = document.createElement('li');
    li.textContent = `${m.name}  [${m.fingerprint}]${m.fingerprint === myFingerprint ? ' (you)' : ''}`;
    el.members.appendChild(li);
  }
}

function appendMessage({ from, fingerprint, text, ts }, myFingerprint) {
  const div = document.createElement('div');
  div.className = 'message' + (fingerprint === myFingerprint ? ' own' : '');
  const time = new Date(ts).toLocaleTimeString();
  div.innerHTML = `<span class="meta">${time}  ${from} [${fingerprint}]</span><span class="text"></span>`;
  div.querySelector('.text').textContent = text; // textContent, not innerHTML, for the message body - never trust remote text as markup.
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
}

/**
 * The delivery decision this whole project's granular-events design was
 * built for: online AND foreground -> nothing extra needed (the message
 * already rendered live, see the .observe() handler below); backgrounded/
 * hidden tab with permission granted -> a real OS-level browser
 * Notification; anything else -> an in-page toast. This handler alone
 * decides the channel - `Space`/`EventBus` know nothing about any of it.
 */
function notifyHandler(payload, ctx) {
  const [, , topic] = ctx.topic.split('.'); // 'notification.demo-chat.mention' -> 'mention'
  const title = `Qu V5 — ${topic}`;
  const body = `von ${payload.authorPub.slice(0, 16)}…`;
  if (document.visibilityState !== 'visible' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body });
  } else {
    showToast(`${title}: ${body}`);
  }
}

function showToast(text) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

async function main() {
  el.notifyButton.addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      setStatus('Browser-Notifications werden hier nicht unterstützt.', true);
      return;
    }
    const permission = await Notification.requestPermission();
    setStatus(`Notification permission: ${permission}`);
  });

  el.joinButton.addEventListener('click', async () => {
    const name = el.nameInput.value.trim();
    if (!name) return;
    el.joinButton.disabled = true;
    try {
      await join(name);
    } catch (err) {
      setStatus(`Fehler: ${err.message}`, true);
      el.joinButton.disabled = false;
    }
  });
}

async function join(name) {
  setStatus('Generiere/lade Identität…');
  const identity = await loadOrCreateIdentity(name);
  const myFingerprint = await QuCrypto.fingerprint(identity.signingPub);

  setStatus('Melde mich beim Relay an…');
  const joinRes = await fetch('/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      pub: QuCrypto.toBase64(identity.signingPub),
      xPub: QuCrypto.toBase64(identity.xPublicKey),
    }),
  });
  if (!joinRes.ok) throw new Error(`/join failed: ${joinRes.status} ${await joinRes.text()}`);

  const membersRes = await fetch('/members.json');
  const rawMembers = await membersRes.json();
  const members = await Promise.all(
    rawMembers.map(async (m) => ({
      name: m.name,
      pub: QuCrypto.fromBase64(m.pub),
      pubB64: m.pub, // kept alongside the decoded bytes - see the member-poll's own dedup comment below for why this must be compared by pubkey, never by name.
      xPub: QuCrypto.fromBase64(m.xPub),
      fingerprint: await QuCrypto.fingerprint(QuCrypto.fromBase64(m.pub)),
    }))
  );

  el.setup.hidden = true;
  el.chat.hidden = false;
  el.you.textContent = `${name}  [${myFingerprint}]`;
  renderMembers(members, myFingerprint);

  setStatus('Verbinde per WebSocket…');
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const transport = new WsClientTransport(`${wsProtocol}//${location.host}`);
  await transport.connect();
  setStatus(`Verbunden. Raum: "${ROOM}".`);

  const bus = new EventBus();
  bus.on('notification.**', notifyHandler);

  let stopDebugLogger = null;
  el.debugToggle.addEventListener('change', () => {
    if (el.debugToggle.checked) {
      el.debugLog.hidden = false;
      stopDebugLogger = createDebugLogger(bus, {
        log: (line, payload) => {
          const p = document.createElement('div');
          p.textContent = `${new Date().toLocaleTimeString()}  ${line}  ${JSON.stringify(payload)}`;
          el.debugLog.appendChild(p);
          el.debugLog.scrollTop = el.debugLog.scrollHeight;
        },
      });
    } else {
      stopDebugLogger?.();
      el.debugLog.hidden = true;
      el.debugLog.innerHTML = '';
    }
  });

  const space = new Space({ identity, members: members.map(({ pub, xPub }) => ({ pub, xPub })), transport, bus });
  const node = space.subscribeNode(ROOM, chatKind);

  // REACTIVE MEMBERSHIP, NOT POLLED: a browser tab that's already connected still learns about
  // someone joining later - the relay broadcasts {type:'member-joined', ...} over this SAME
  // WebSocket connection the moment it happens (see @qu/space-transport's relay.js `addMember()`),
  // and `space` has already run its OWN addMember() by the time this fires (see @qu/space-core's
  // Space doc comment on the `space.member.joined` topic) - this handler only needs to update the
  // UI's own member list, the crypto/ACL side is already done.
  bus.on('space.member.joined', async (payload) => {
    // Dedup by PUBKEY, never by name - the CLI demo pre-seeds "alice"/"bob" identities, and a
    // browser tab defaults to those same display names for interop testing, so two members can
    // legitimately share a name while being cryptographically distinct. Comparing by name here
    // would silently drop a same-named member's real entry from the UI.
    if (members.some((known) => known.pubB64 === payload.pub)) return;
    const pub = QuCrypto.fromBase64(payload.pub);
    const xPub = QuCrypto.fromBase64(payload.xPub);
    const fingerprint = await QuCrypto.fingerprint(pub);
    members.push({ name: payload.name ?? '?', pub, pubB64: payload.pub, xPub, fingerprint });
    renderMembers(members, myFingerprint);
  });

  let printed = 0;
  let printing = Promise.resolve();
  function schedulePrint() {
    printing = printing.then(async () => {
      const all = await node.field('messages').toArray();
      for (; printed < all.length; printed++) {
        const m = all[printed];
        if (m === undefined) continue; // ciphertext we're not a recipient of - shouldn't happen, we're always a member here.
        appendMessage(m, myFingerprint);
      }
    });
  }
  node.field('messages').observe(schedulePrint);
  schedulePrint();

  el.composeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.composeInput.value.trim();
    if (!text) return;
    el.composeInput.value = '';
    const mentioned = text.match(/^@(\S+)/)?.[1];
    const mentionedMember = mentioned && members.find((m) => m.name === mentioned);
    const notify = mentionedMember ? { topic: 'mention', to: [QuCrypto.toBase64(mentionedMember.pub)] } : { topic: 'message' };
    await node.field('messages').push({ from: name, fingerprint: myFingerprint, text, ts: Date.now() }, { notify });
  });
}

main().catch((err) => {
  console.error(err);
  setStatus(`Fehler: ${err.message}`, true);
});
