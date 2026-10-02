/**
 * CHAT ACTIONS — the real messenger's own interactivity, wired into
 * `bundle.js`'s static `chat-shell` chrome. See that file's own top doc
 * comment for why this app's content is never a CMS Page, and
 * `@qu/app-core`'s `messenger.js` for the full data-model "why" (unified
 * 1:1/group model, contacts-first discovery, the compaction fix for a
 * member added to an active group chat, deliberately no retroactive
 * history).
 *
 * ROUTING: this app's own `subPath` (threaded through `wireInstalledApps()`
 * since the subPath-threading fix this app motivated - `apps/README.md`'s
 * own `wire` doc comment) is a plain client-side pattern this file parses
 * itself, `/room/<roomId>` - `encodeRoomId()`/`parseRoomSubPath()` below.
 * `roomId` is NEVER a `chatKind` Node id - that would leak an undecodable
 * opaque hash; it is `base64url(groupOwnerPub) + '.' + groupName`, trivially
 * reversible, exactly what `chatNodeId()` already derives FROM. Navigating
 * between rooms sets `location.hash` directly (`navigateWithinApp()`) -
 * the exact same mechanism `@qu/app-core`'s `HashRouter.navigate()` uses,
 * just computed locally since this file has no `Router` instance of its
 * own (only ever `{mountEl, doc, space, subPath}}`, the same contract every
 * other discovered `/apps/*` app's own `wire()` gets).
 *
 * TICKS/TYPING/ONLINE use ONLY already-generic, already-built primitives
 * (`@qu/space-plugins`'s `markRead()`/`markDelivered()`/`ReadReceiptWatcher`,
 * `@qu/space-core`'s `setTyping()`/`PresenceWatcher`/`LivePresenceWatcher`/
 * `declareOnlineVisibility()`) - `messenger.js`'s own top doc comment on why
 * no wrapper exists there. v1 SIMPLIFICATION (documented, not a bug):
 * delivered+read are marked TOGETHER, only while a room is actually open in
 * this tab - a genuine "delivered while the app was closed" distinction
 * needs a background sync listener this Stufe deliberately doesn't build
 * yet. A group chat's own tick only turns blue once EVERY other member has
 * read it (no per-member read-detail view yet, unlike Signal's own).
 */
import { QuCrypto } from '@qu/core';
import {
  chatKind,
  chatNodeId,
  getOrCreateDirectChat,
  createGroupChat,
  sendMessage,
  listContacts,
  addContact,
  recordConversation,
  listConversations,
  conversationsKind,
  ContentResolver,
} from '@qu/app-core';
import { setTyping, PresenceWatcher, LivePresenceWatcher, declareOnlineVisibility, presenceKind, userKind, userNodeId } from '@qu/space-core';
// Narrow subpath, never `@qu/space-plugins`'s package root concern here - this file is itself part
// of the browser bundle graph (see the ORIGINAL v1 actions.js's own doc comment on this trap for any
// `/apps/*` app's code); `@qu/space-plugins` IS browser-safe (no node: imports at all), so the plain
// package import is fine, unlike `@qu/app-shell`'s own root.
import { markRead, markDelivered, ReadReceiptWatcher, readReceiptKind } from '@qu/space-plugins';

/** `roomId` for `{groupOwnerPub, groupName}` - see this file's own top doc comment. @param {Uint8Array} groupOwnerPub @param {string} groupName @returns {string} */
function encodeRoomId(groupOwnerPub, groupName) {
  return `${QuCrypto.toBase64Url(groupOwnerPub)}.${groupName}`;
}

/** @param {string} roomId @returns {{groupOwnerPub: Uint8Array, groupName: string}|null} `null` if malformed. */
function decodeRoomId(roomId) {
  const i = roomId.indexOf('.');
  if (i < 1) return null;
  try {
    return { groupOwnerPub: QuCrypto.fromBase64Url(roomId.slice(0, i)), groupName: roomId.slice(i + 1) };
  } catch {
    return null;
  }
}

/** @param {string|null|undefined} subPath @returns {{groupOwnerPub: Uint8Array, groupName: string}|null} */
function parseRoomSubPath(subPath) {
  const m = /^\/room\/([^/]+)\/?$/.exec(subPath ?? '');
  return m ? decodeRoomId(decodeURIComponent(m[1])) : null;
}

/** Same `location.hash` normalization `HashRouter.current()` uses - duplicated here (a few lines) rather than instantiating a whole `Router` just to read the current route. @param {Window} win @returns {string} */
function currentRoute(win) {
  const hash = win.location.hash ?? '';
  const route = hash.startsWith('#') ? hash.slice(1) : hash;
  return route.startsWith('/') ? route : `/${route}`;
}

/** Navigates to `newSubPath` WITHIN this same app instance, preserving whatever prefix (`#/<prefix>/`, `#/admin/<prefix>/`, `#/<prefix>/u/me/`, ...) got us here - computed by stripping the CURRENT `subPath` suffix off the current full route, exactly the inverse of how `boot.js` built `subPath` in the first place. @param {Window} win @param {string|null|undefined} subPath - this render's OWN subPath, as given to `wireChat()`. @param {string} newSubPath */
function navigateWithinApp(win, subPath, newSubPath) {
  const full = currentRoute(win);
  const suffix = subPath ?? '';
  const prefix = suffix && full.endsWith(suffix) ? full.slice(0, full.length - suffix.length) : full.replace(/\/room\/[^/]*\/?$/, '/');
  win.location.hash = prefix + newSubPath;
}

/** @param {string} pubB64 @returns {string} a short, human-glanceable form - never the full key in a list row. */
function shortPub(pubB64) {
  return `${pubB64.slice(0, 6)}…${pubB64.slice(-4)}`;
}

function aliasFor(contacts, pubB64) {
  return contacts.find((c) => c.pub === pubB64)?.alias ?? null;
}

/** `ContentResolver.resolveGroup()`'s own `members` are RAW `Uint8Array` pubkeys (its own doc comment: "decoded back to raw bytes - the exact shape `createPrivatePage()`'s own `recipients` param expects") - everything ELSE in this file (contacts, `myPubB64`, `ReadReceiptWatcher`/`PresenceWatcher`'s own map keys) works in base64 strings, so every read of a group's members goes through this first. @param {{members: Array<{pub: Uint8Array, xPub: Uint8Array}>}} group @returns {string[]} */
function memberPubs(group) {
  return group.members.map((m) => QuCrypto.toBase64(m.pub));
}

/** Display title for a conversation entry (`listConversations()`'s own shape) - the OTHER party's contact alias (if known) for a 1:1, else a short pubkey; the group's own `title` for a group. */
function conversationTitle(entry, contacts) {
  if (entry.kind === 'group') return entry.title ?? 'Gruppe';
  return (entry.peerPub && aliasFor(contacts, entry.peerPub)) ?? (entry.peerPub ? shortPub(entry.peerPub) : 'Chat');
}

const presenceDeclared = new WeakSet();

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, subPath?: string}} params */
export async function wireChat({ mountEl, doc, space, subPath }) {
  const appEl = mountEl.querySelector('[data-qu-chat-app]');
  if (!appEl) return; // not this app's own chrome - correct no-op, same posture every other reference app's wire() already has.

  // A contacts-first messenger's own default: visible online status to whoever already knows your
  // pubkey (your contacts) is the expected UX (Signal/WhatsApp both default this way) - declared
  // once per Space (an idempotent no-op to repeat, but no reason to re-sign+resend on every render).
  if (space.bus && !presenceDeclared.has(space)) {
    presenceDeclared.add(space);
    declareOnlineVisibility(space, 'public').catch(() => {}); // best-effort - a watcher simply sees "unknown" if this never lands.
  }

  if (!appEl.dataset.quChatWired) {
    appEl.dataset.quChatWired = '1';
    appEl._quChat = createChatController({ appEl, doc, space });
    await appEl._quChat.wireChrome();
  }

  await appEl._quChat.showForSubPath(subPath);
}

/**
 * Everything this app's chrome needs to stay alive across re-renders lives
 * on ONE controller object, stashed on `appEl._quChat` (`wireChat()`'s own
 * idempotency guard) - watchers (`ReadReceiptWatcher`/`PresenceWatcher`/
 * `LivePresenceWatcher`) are relatively cheap but NOT free to recreate on
 * every render (`useNode()`'s own warm-cache posture elsewhere in this
 * framework), so this file builds them once per mount, not once per route
 * change.
 */
function createChatController({ appEl, doc, space }) {
  const myPubB64 = QuCrypto.toBase64(space.identity.signingPub);
  const readWatcher = space.bus ? new ReadReceiptWatcher(space, space.bus) : null;
  const presenceWatcher = space.bus ? new PresenceWatcher(space, space.bus) : null;
  const liveWatcher = space.bus ? new LivePresenceWatcher(space, space.bus) : null;
  const watchedPubs = new Set();
  function watchPeer(pubB64) {
    if (watchedPubs.has(pubB64)) return;
    watchedPubs.add(pubB64);
    const pub = QuCrypto.fromBase64(pubB64);
    readWatcher?.watch(pub);
    presenceWatcher?.watch(pub);
    liveWatcher?.watch(pub);
  }

  let currentRoom = null; // {groupOwnerPub, groupName, roomId} - the OPEN room, or null.
  let typingTimer = null;
  let messagesOff = null; // unobserve() for the currently-open room's messages field.

  const sidebarEl = appEl.querySelector('[data-qu-chat-conversations]');
  const mainEl = appEl.querySelector('[data-qu-chat-main]');

  async function renderConversationList() {
    const [conversations, contacts] = await Promise.all([listConversations(space), listContacts(space)]);
    sidebarEl.innerHTML = '';
    const sorted = [...conversations].sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    for (const entry of sorted) {
      const roomId = encodeRoomId(QuCrypto.fromBase64(entry.groupOwnerPub), entry.groupName);
      const li = doc.createElement('li');
      li.setAttribute('data-qu-chat-conversation', roomId);
      const a = doc.createElement('a');
      a.href = '#';
      a.textContent = conversationTitle(entry, contacts);
      if (entry.kind === '1:1' && entry.peerPub) {
        watchPeer(entry.peerPub);
        const dot = doc.createElement('span');
        dot.setAttribute('data-qu-chat-online-dot', '');
        dot.textContent = liveWatcher?.isOnline(entry.peerPub) ? ' ●' : '';
        a.appendChild(dot);
      }
      a.addEventListener('click', (event) => {
        event.preventDefault();
        navigateWithinApp(doc.defaultView, appEl.dataset.quChatSubPath ?? '', `/room/${encodeURIComponent(roomId)}`);
      });
      li.appendChild(a);
      sidebarEl.appendChild(li);
    }
  }

  function wireNewChatPanel() {
    const panel = appEl.querySelector('[data-qu-chat-new-panel]');
    const toggleBtn = appEl.querySelector('[data-qu-chat-new-toggle]');
    toggleBtn?.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderContactsPicker();
    });

    const status = appEl.querySelector('[data-qu-chat-new-status]');
    const setStatus = (text) => {
      if (status) status.textContent = text;
    };

    appEl.querySelector('[data-qu-chat-contact-add]')?.addEventListener('click', async () => {
      const pubInput = appEl.querySelector('[data-qu-chat-contact-pub]');
      const aliasInput = appEl.querySelector('[data-qu-chat-contact-alias]');
      setStatus('');
      try {
        const pub = QuCrypto.fromBase64(pubInput.value.trim());
        const alias = aliasInput.value.trim() || null;
        // A contact's `xPub` (the X25519 encryption key, DIFFERENT from their Ed25519 signing
        // pubkey pasted above) is resolved via `@qu/space-core`'s own self-certifying User-Node
        // (`userKind.epub` - "the discoverability half of 'always public'", that file's own top doc
        // comment) - never guessed/reused from the signing pubkey, which would silently seal every
        // message for a key this contact never holds the private half of (a real bug an earlier
        // draft of this file had: messages sent that way are permanently undecryptable by the
        // recipient, failing completely silently - no error, no rejection, just nothing ever
        // arrives). `ensureUserProfile()` publishes this automatically on every real boot
        // (`@qu/app-shell`'s own `shell.js`) - a pubkey with no published profile yet genuinely
        // cannot be added as a contact, a correct (if blunt) failure, not a silent one.
        const { node, release } = await space.useNode(await userNodeId(pub), userKind);
        // `'public'`-visibility field, needs no decrypt-and-retry - same `isSet()`-then-`isNodeSynced()`
        // "not yet arrived vs. genuinely never published" wait `@qu/space-core`'s `user.js`'s own
        // `waitUntilSet()` already uses internally (not exported, so replicated here in a few lines).
        const epubField = node.field('epub');
        const deadline = Date.now() + 1500;
        while (!epubField.isSet() && !space.isNodeSynced(await userNodeId(pub)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const epub = await epubField.get();
        release();
        if (!epub) throw new Error('Für diesen Pubkey wurde noch kein Profil veröffentlicht (epub unbekannt) - Kontakt kann noch nicht hinzugefügt werden.');
        await addContact(space, { pub, xPub: QuCrypto.fromBase64(epub), alias });
        pubInput.value = '';
        aliasInput.value = '';
        setStatus('Kontakt gespeichert.');
        await renderContactsPicker();
      } catch (err) {
        setStatus(`Fehler: ${err.message}`);
      }
    });

    appEl.querySelector('[data-qu-chat-group-create]')?.addEventListener('click', async () => {
      setStatus('');
      try {
        const nameInput = appEl.querySelector('[data-qu-chat-group-name]');
        const name = nameInput.value.trim();
        if (!name) throw new Error('Bitte einen Gruppennamen angeben.');
        const checked = [...appEl.querySelectorAll('[data-qu-chat-group-member-checkbox]:checked')];
        if (checked.length === 0) throw new Error('Bitte mindestens einen Kontakt auswählen.');
        const members = checked.map((cb) => ({ pub: QuCrypto.fromBase64(cb.value), xPub: QuCrypto.fromBase64(cb.dataset.xpub) }));
        const { groupOwnerPub, groupName } = await createGroupChat(space, { name, members });
        await recordConversation(space, { groupOwnerPub, groupName, kind: 'group', title: name });
        nameInput.value = '';
        setStatus('Gruppe erstellt.');
        panel.hidden = true;
        await renderConversationList();
        navigateWithinApp(doc.defaultView, appEl.dataset.quChatSubPath ?? '', `/room/${encodeURIComponent(encodeRoomId(groupOwnerPub, groupName))}`);
      } catch (err) {
        setStatus(`Fehler: ${err.message}`);
      }
    });
  }

  async function renderContactsPicker() {
    const contacts = await listContacts(space);
    const listEl = appEl.querySelector('[data-qu-chat-contacts]');
    const membersEl = appEl.querySelector('[data-qu-chat-group-members]');
    if (listEl) {
      listEl.innerHTML = '';
      for (const c of contacts) {
        const li = doc.createElement('li');
        const a = doc.createElement('a');
        a.href = '#';
        a.textContent = c.alias ?? shortPub(c.pub);
        a.addEventListener('click', async (event) => {
          event.preventDefault();
          const peer = { pub: QuCrypto.fromBase64(c.pub), xPub: QuCrypto.fromBase64(c.xPub) };
          const { groupOwnerPub, groupName } = await getOrCreateDirectChat(space, peer);
          await recordConversation(space, { groupOwnerPub, groupName, kind: '1:1', peerPub: c.pub });
          appEl.querySelector('[data-qu-chat-new-panel]').hidden = true;
          await renderConversationList();
          navigateWithinApp(doc.defaultView, appEl.dataset.quChatSubPath ?? '', `/room/${encodeURIComponent(encodeRoomId(groupOwnerPub, groupName))}`);
        });
        li.appendChild(a);
        listEl.appendChild(li);
      }
    }
    if (membersEl) {
      membersEl.innerHTML = '';
      for (const c of contacts) {
        const label = doc.createElement('label');
        const cb = doc.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('data-qu-chat-group-member-checkbox', '');
        cb.value = c.pub;
        cb.dataset.xpub = c.xPub;
        label.appendChild(cb);
        label.appendChild(doc.createTextNode(c.alias ?? shortPub(c.pub)));
        membersEl.appendChild(label);
      }
    }
  }

  async function wireChrome() {
    wireNewChatPanel();
    await renderConversationList();
    space.bus?.on('space.node.*.changed', (payload) => {
      if (payload.kind === conversationsKind.kind) renderConversationList();
      if (payload.kind === presenceKind.kind) updateTypingIndicator();
      if (payload.kind === readReceiptKind.kind) refreshTicks();
    });
    space.bus?.on('space.presence.live.changed', () => renderConversationList());
  }

  function closeRoom() {
    messagesOff?.();
    messagesOff = null;
    currentRoom = null;
  }

  /** Lightweight, standalone refresh of JUST the "X schreibt…" indicator - deliberately NOT a full `renderMessages()` (that would rebuild the composer on every peer keystroke, wiping focus/draft churn `renderMessages()`'s own comment already guards against for message arrivals; typing changes far more often, so this stays a surgical DOM patch instead). Called both right after a room opens and reactively off `space.bus`'s own `qu-presence` changes (`wireChrome()` below) - PresenceWatcher's own cache updates on that same event, so reading it synchronously right after is always current. */
  function updateTypingIndicator() {
    if (!currentRoom) return;
    const header = mainEl.querySelector('[data-qu-chat-thread-header]');
    if (!header) return;
    header.querySelector('[data-qu-chat-typing]')?.remove();
    if (currentRoom.otherPubs?.length === 1) {
      const typing = presenceWatcher?.of(currentRoom.otherPubs[0]);
      if (typing?.typingIn === currentRoom.chatId && Date.now() - (typing.typingAt ?? 0) < 6000) {
        const span = doc.createElement('span');
        span.setAttribute('data-qu-chat-typing', '');
        span.textContent = ' schreibt…';
        header.appendChild(span);
      }
    }
  }

  /** Surgical re-paint of every own-message tick's color/text - same "don't rebuild the composer" reasoning `updateTypingIndicator()`'s own doc comment gives, here for read-receipt changes instead of presence ones. Reads `currentRoom.messages`/`currentRoom.otherPubs` (set by the last `renderMessages()`), so a stray event before any room has ever rendered is a correct no-op. */
  function refreshTicks() {
    if (!currentRoom?.messages) return;
    const otherPubs = currentRoom.otherPubs ?? [];
    currentRoom.messages.forEach((message, index) => {
      if (!message) return;
      const tick = mainEl.querySelector(`[data-qu-chat-message="${message.id}"] [data-qu-chat-tick]`);
      if (!tick) return;
      const deliveredByAll = otherPubs.length > 0 && otherPubs.every((p) => (readWatcher?.deliveredUpToFor(p, currentRoom.chatId) ?? -1) >= index);
      const readByAll = otherPubs.length > 0 && otherPubs.every((p) => (readWatcher?.upToFor(p, currentRoom.chatId) ?? -1) >= index);
      tick.textContent = readByAll ? ' ✓✓' : deliveredByAll ? ' ✓✓' : ' ✓';
      tick.style.color = readByAll ? '#4fc3f7' : '#999';
    });
  }

  async function renderMessages(node, group, title, isGroup) {
    const members = memberPubs(group);
    for (const pubB64 of members) if (pubB64 !== myPubB64) watchPeer(pubB64);
    const otherPubs = members.filter((p) => p !== myPubB64);

    const messages = await node.field('messages').toArray();
    // A message/tick arriving live rebuilds this whole pane (simplest correct option for v1 - no
    // incremental DOM patching) - preserve whatever the user was mid-typing (and focus) across that
    // rebuild, or every incoming message would silently wipe an unsent draft out from under them.
    const previousInput = mainEl.querySelector('[data-qu-chat-input]');
    const draftText = previousInput?.value ?? '';
    const hadFocus = doc.activeElement === previousInput;
    mainEl.innerHTML = '';
    const header = doc.createElement('div');
    header.setAttribute('data-qu-chat-thread-header', '');
    header.textContent = title;
    mainEl.appendChild(header);
    currentRoom.otherPubs = otherPubs;
    currentRoom.messages = messages;
    updateTypingIndicator();

    const list = doc.createElement('div');
    list.setAttribute('data-qu-chat-messages', '');
    messages.forEach((message, index) => {
      if (!message) return; // undecryptable (history from before this identity joined a group) - see this file's own top doc comment.
      const row = doc.createElement('p');
      row.setAttribute('data-qu-chat-message', message.id ?? String(index));
      const mine = message.from === myPubB64;
      row.setAttribute('data-qu-chat-mine', String(mine));
      // A group member's own DISPLAY name (beyond a short pubkey) needs a profile/alias lookup
      // this Stufe deliberately doesn't build yet - see messenger.js's own top doc comment on scope.
      const sender = mine ? 'Ich' : shortPub(message.from ?? '');
      row.textContent = `${sender}: ${message.text ?? ''} `;
      const time = doc.createElement('small');
      time.textContent = message.sentAt ? new Date(message.sentAt).toLocaleTimeString() : '';
      row.appendChild(time);
      if (mine) {
        const tick = doc.createElement('span');
        tick.setAttribute('data-qu-chat-tick', '');
        row.appendChild(tick);
      }
      list.appendChild(row);
    });
    mainEl.appendChild(list);
    list.scrollTop = list.scrollHeight;
    refreshTicks();

    const composer = doc.createElement('form');
    composer.setAttribute('data-qu-chat-composer', '');
    composer.innerHTML = '<input type="text" data-qu-chat-input placeholder="Nachricht…" autocomplete="off"><button type="submit">Senden</button>';
    mainEl.appendChild(composer);
    const input = composer.querySelector('[data-qu-chat-input]');
    input.value = draftText;
    if (hadFocus) input.focus();
    input.addEventListener('input', () => {
      setTyping(space, currentRoom.chatId, true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => setTyping(space, currentRoom.chatId, false), 3000);
    });
    composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      clearTimeout(typingTimer);
      setTyping(space, currentRoom.chatId, false);
      await sendMessage(space, { groupOwnerPub: currentRoom.groupOwnerPub, groupName: currentRoom.groupName }, { text });
      await recordConversation(space, { groupOwnerPub: currentRoom.groupOwnerPub, groupName: currentRoom.groupName, kind: isGroup ? 'group' : '1:1', peerPub: otherPubs[0] ?? null, lastMessageAt: Date.now() });
    });

    if (messages.length > 0) {
      const lastIndex = messages.length - 1;
      await markDelivered(space, currentRoom.chatId, lastIndex);
      await markRead(space, currentRoom.chatId, lastIndex);
    }
  }

  async function openRoom({ groupOwnerPub, groupName, roomId }) {
    closeRoom();
    currentRoom = { groupOwnerPub, groupName, roomId, chatId: await chatNodeId(groupOwnerPub, groupName) };
    const resolver = new ContentResolver(space, { appAdminPub: groupOwnerPub });
    const group = await resolver.resolveGroup(groupName, { ownerPub: groupOwnerPub, timeout: 2000 });
    if (!group) {
      mainEl.innerHTML = '<p data-qu-chat-empty>Diese Unterhaltung ist noch nicht synchronisiert oder existiert nicht.</p>';
      return;
    }
    const contacts = await listContacts(space);
    const otherPubs = memberPubs(group).filter((p) => p !== myPubB64);
    const id = currentRoom.chatId;
    const node = space.getNode(id) ?? (await space.useNode(id, chatKind, { groupRef: { groupOwnerPub, groupName } })).node;
    // `chatKind.name` (never member count) is the data model's OWN "is this a group" signal -
    // always `null` for a 1:1 (`getOrCreateDirectChat()`'s own doc comment), always set for a group
    // (`createGroupChat()`'s own `name` param) - member count alone would misclassify a genuine
    // 2-person GROUP (nothing stops one, `createGroupChat()`'s own doc comment) as a 1:1.
    const chatName = await node.field('name').get();
    const isGroup = chatName !== null;
    const title = isGroup ? chatName : (aliasFor(contacts, otherPubs[0]) ?? shortPub(otherPubs[0] ?? ''));
    await renderMessages(node, group, title, isGroup);
    messagesOff = node.field('messages').observe(() => {
      if (currentRoom?.roomId === roomId) renderMessages(node, group, title, isGroup);
    });
  }

  async function showForSubPath(subPath) {
    appEl.dataset.quChatSubPath = subPath ?? '';
    const room = parseRoomSubPath(subPath);
    if (!room) {
      closeRoom();
      mainEl.innerHTML = '<p data-qu-chat-empty>Wähle links eine Unterhaltung oder starte eine neue.</p>';
      return;
    }
    const roomId = encodeRoomId(room.groupOwnerPub, room.groupName);
    if (currentRoom?.roomId === roomId) return; // already open - a re-render for an unrelated reason (e.g. the sidebar refreshing) must not tear the open thread down.
    await openRoom({ ...room, roomId });
  }

  return { wireChrome, showForSubPath };
}
