/**
 * MESSENGER — the private, end-to-end-encrypted 1:1/group chat data layer
 * (`docs/chat-app-concept.md`'s own Datenmodell, §2/§2a), built entirely on
 * `@qu/space-core`'s public API, same "no Space/relay-side special case"
 * posture every other file in this package already takes. `apps/chat/`
 * (the UI) is this file's one real consumer - see that folder's own
 * `actions.js` for how these compose into a working messenger.
 *
 * ONE UNIFIED DATA MODEL FOR 1:1 AND GROUP CHATS - a deliberate departure
 * from the concept doc's own original, never-fully-worked-out sketch
 * ("model 1:1 as a 2-member group" without solving WHO is allowed to
 * create the shared Node first). The resolution (confirmed with the user):
 * there is no artificial ownership asymmetry to solve at all - exactly
 * like Matrix, where a DM is simply a room with two members, WHOEVER
 * starts a conversation creates the `groupKind` Group (`createGroup()`,
 * `kinds.js`'s own doc comment) under their OWN pubkey, naming the other
 * party as a member immediately - identical to starting a group chat with
 * one fewer member.
 *
 * `groupKind` IS THE DISCOVERY/EXISTENCE ANCHOR - no separate "chat
 * routing" Node exists. `chatKind` holds ONLY the actual private content
 * (`name`/`messages`) - no `groupOwnerPub`/`groupName`/`kind` fields on it
 * at all, because every caller already addresses it BY that exact pair
 * (passed around explicitly everywhere below, same as `resolveGroupContent()`'s
 * own `groupOwnerPub` parameter already works), and `groupKind` itself
 * already answers "does this conversation exist, and who's in it" -
 * restating that on `chatKind` too would just be a second, redundant
 * source of truth. This also has a real technical payoff: `chatKind`'s
 * fields are now ALL `'encrypted'` (uniform visibility), which is what
 * makes it COMPACTABLE at all (`Space.compactNode()`'s own doc comment -
 * see `addGroupChatMembers()` below for why that matters).
 *
 * `getOrCreateDirectChat()` resolves the one remaining real wrinkle for
 * 1:1: two people need to agree on WHERE a conversation lives without a
 * prior round-trip, so its `groupName` is DETERMINISTIC (a hash of both
 * pubkeys, sorted) - computable by either side the moment they know each
 * other's pubkey, independent of who actually ends up creating it.
 * Discovering a brand-new conversation at all (i.e. learning the
 * counterpart's pubkey in the first place) is deliberately "contacts-
 * first" - the user's own decision: a conversation only becomes reachable
 * once BOTH sides already know each other's pubkey (a shared profile
 * link, the opt-in `listed` user directory - `@qu/space-core`'s
 * `user.js` - or this file's own `contactsKind`), never a new push/notify
 * mechanism. `getOrCreateDirectChat()` therefore checks BOTH possible
 * owner slots (mine, theirs) via `resolveGroup()` before creating a new
 * one, so whichever side happens to start first is found by the other
 * rather than silently duplicated.
 *
 * ACCEPTED RACE (documented, not solved): if both sides start a 1:1 with
 * each other in the same narrow window, before either's Group Node has
 * synced to the other, two independent conversation pairs can result -
 * the same low-stakes "we called each other at the same instant" edge case
 * `createGroup()`'s own "last write wins" tradeoff already accepts
 * elsewhere in this package. Left for the UI to notice/merge later if it
 * ever matters, not solved here.
 *
 * READ/DELIVERED, TYPING, ONLINE need no wrapper here - they are already
 * fully generic, already-built primitives from OTHER packages, used
 * directly by the UI with `chatNodeId(groupOwnerPub, groupName)` as their
 * anchor: `@qu/space-plugins`'s `markRead()`/`markDelivered()`/
 * `ReadReceiptWatcher` (`contentNodeId` = a chat's own Node id), and
 * `@qu/space-core`'s `setTyping()`/`LivePresenceWatcher`. Wrapping them
 * here would only rename them - `@qu/app-core` deliberately does not
 * depend on `@qu/space-plugins` (a sibling "optional app helpers" layer,
 * never a dependency of this package - see that package's own doc
 * comment), so this file stays exactly what everything else in it already
 * is: Kind-Schemas + the handful of dev-API calls to use them, nothing an
 * app couldn't otherwise write itself by hand.
 */
import { QuCrypto } from '@qu/core';
import { defineKind, deriveOwnerNodeId } from '@qu/space-core';
import { deriveContentNodeId } from './content-id.js';
import { groupKind } from './kinds.js';
import { createGroup, editGroup } from './dev.js';
import { ContentResolver } from './resolver.js';

/**
 * One Node per conversation (1:1 or group) - the actual private content
 * only, see this file's own top doc comment on why `groupOwnerPub`/
 * `groupName`/a `kind` field do NOT live here (the referenced `groupKind`
 * Group already is that source of truth). `messages` is a single
 * `ListField` per chat (`docs/chat-app-concept.md`'s own "entschiedene
 * Punkte" - simpler, robust enough for v1, not a global shared-list).
 * Each message is deliberately a flat, open object (no closed/versioned
 * schema) - see `sendMessage()`'s own doc comment for the exact shape and
 * why. ALL fields `'encrypted'` (uniform visibility) - required for
 * `Space.compactNode()` to work on this Node at all (see
 * `addGroupChatMembers()` below).
 */
export const chatKind = defineKind('qu-chat', {
  fields: {
    name: { shape: 'atomic', visibility: 'encrypted' }, // group display name - unused/null for a 1:1 (shown as the OTHER party's own profile alias instead, a pure UI concern).
    messages: { shape: 'list', visibility: 'encrypted' },
  },
  acl: { write: 'group' },
});

/** @param {Uint8Array} groupOwnerPub @param {string} groupName @returns {Promise<string>} */
export function chatNodeId(groupOwnerPub, groupName) {
  return deriveContentNodeId(groupOwnerPub, chatKind.kind, groupName);
}

/** Deterministic `groupName` for a 1:1 between `pubA`/`pubB` - a hash of both, sorted, so EITHER side computes the exact same value without a prior round-trip. @param {Uint8Array} pubA @param {Uint8Array} pubB @returns {Promise<string>} */
async function directChatGroupName(pubA, pubB) {
  const [a, b] = [QuCrypto.toBase64(pubA), QuCrypto.toBase64(pubB)].sort();
  const digest = await QuCrypto.sha256(new TextEncoder().encode(`qu-chat-dm-v1:${a}:${b}`));
  return `dm-${QuCrypto.toBase64Url(digest)}`;
}

/**
 * Finds this identity's 1:1 conversation with `peer`, creating one (under
 * THIS identity's own pubkey) only if neither side has already started it -
 * see this file's own top doc comment for the full "why" and the accepted
 * race. Checks `groupKind` (the real discovery anchor), not `chatKind`
 * itself - a `chatKind.name` is intentionally always `null` for a 1:1, so
 * it could never serve as an "does this exist" signal.
 * @param {import('@qu/space-core').Space} space
 * @param {{pub: Uint8Array, xPub: Uint8Array}} peer
 * @param {{timeout?: number}} [options] - per-candidate lookup timeout (default 500ms *2 candidates) - keep this SHORT, unlike a real content resolve: a negative result (genuinely never created) is the COMMON case for a brand-new contact, not the exception.
 * @returns {Promise<{groupOwnerPub: Uint8Array, groupName: string, existed: boolean}>}
 */
export async function getOrCreateDirectChat(space, peer, { timeout = 500 } = {}) {
  const groupName = await directChatGroupName(space.identity.signingPub, peer.pub);
  const resolver = new ContentResolver(space, { appAdminPub: space.identity.signingPub });
  for (const groupOwnerPub of [space.identity.signingPub, peer.pub]) {
    const existing = await resolver.resolveGroup(groupName, { ownerPub: groupOwnerPub, timeout });
    if (existing) return { groupOwnerPub, groupName, existed: true };
  }
  const members = [{ pub: space.identity.signingPub, xPub: space.identity.xPublicKey }, peer];
  await createGroup(space, { name: groupName, members });
  await space.createNode(
    chatKind,
    { name: null },
    // `recipients` is REQUIRED here - omitting it makes Space._effectiveRecipients() fall back to
    // the Space's own flat member list (its own doc comment), not this Group's members, which for a
    // private chat is both WRONG (could encrypt for people who aren't even in the conversation) and
    // potentially a hard failure (a deployment with no flat 'members' list configured at all, which
    // every self-certifying/group-ACL Kind is designed to work without - relay-server.js's own
    // "WHY MEMBERS ARE OPTIONAL NOW" doc comment).
    { groupOwnerPub: space.identity.signingPub, groupName, recipients: members.map((m) => m.xPub) }
  );
  return { groupOwnerPub: space.identity.signingPub, groupName, existed: false };
}

/**
 * Starts a NEW group chat (3+ participants, though nothing stops 2) -
 * always owned by THIS identity (the creator/admin, same role `createGroup()`
 * itself already gives whoever calls it, and the only identity who can
 * later call `addGroupChatMembers()`/`removeGroupChatMember()` below with
 * relay-enforced effect - see `editGroup()`'s own doc comment on why only
 * the genuine owner's own `declareGroupMembership()` is self-certifying).
 * @param {import('@qu/space-core').Space} space
 * @param {{name: string, members: Array<{pub: Uint8Array, xPub: Uint8Array}>}} params - `name` is the group's DISPLAY name; `members` excludes this identity itself (added automatically).
 * @returns {Promise<{groupOwnerPub: Uint8Array, groupName: string}>}
 */
export async function createGroupChat(space, { name, members }) {
  const groupName = `group-${crypto.randomUUID()}`;
  const allMembers = [...members, { pub: space.identity.signingPub, xPub: space.identity.xPublicKey }];
  await createGroup(space, { name: groupName, members: allMembers });
  await space.createNode(
    chatKind,
    { name },
    { groupOwnerPub: space.identity.signingPub, groupName, recipients: allMembers.map((m) => m.xPub) } // see getOrCreateDirectChat()'s own comment on why this is required, not optional.
  );
  return { groupOwnerPub: space.identity.signingPub, groupName };
}

/**
 * Adds one or more members to an ALREADY-ACTIVE group chat - the one case
 * that needs more than `editGroup()` alone. WHY: `chatKind.messages` is a
 * single Node MULTIPLE members write to over time; Yjs integrates each
 * author's updates as a strictly ordered, gapless per-author sequence (the
 * exact same property `grant.js`'s own "WRITE-BEFORE-GRANT IS A TRAP" doc
 * comment describes for grants). A brand-new member who was never a
 * decryption recipient of an author's EARLIER messages can therefore never
 * integrate ANY LATER message from that same author either, even ones
 * sent after they joined - a real, confirmed framework behavior (see
 * `group-private-content.test.js`'s own "new member still gets null, even
 * for a later edit" case), not something specific to this Kind.
 * `Space.compactNode(id, {recipients})` (space.js's own "UPDATE" doc
 * comment) is the fix: resealing the Node's WHOLE current state as one
 * envelope for the Group's new member list gives every member - including
 * whoever just joined - a gap-free baseline to read forward from. Member
 * REMOVAL (`removeGroupChatMember()` below) needs none of this - no new
 * reader ever needs a fresh baseline just because someone left.
 * @param {import('@qu/space-core').Space} space
 * @param {{groupOwnerPub: Uint8Array, groupName: string, newMembers: Array<{pub: Uint8Array, xPub: Uint8Array}>}} params
 * @returns {Promise<Array<{pub: Uint8Array, xPub: Uint8Array}>>} the Group's full member list after adding.
 */
export async function addGroupChatMembers(space, { groupOwnerPub, groupName, newMembers }) {
  const resolver = new ContentResolver(space, { appAdminPub: groupOwnerPub });
  const group = await resolver.resolveGroup(groupName, { ownerPub: groupOwnerPub, forceRevalidate: true });
  if (!group) throw new Error(`addGroupChatMembers: group "${groupName}" (owner ${QuCrypto.toBase64(groupOwnerPub)}) has not synced`);
  const updatedMembers = [...group.members, ...newMembers];
  await editGroup(space, { name: groupName, members: updatedMembers, ownerPub: groupOwnerPub });

  const id = await chatNodeId(groupOwnerPub, groupName);
  if (!space.getNode(id)) await space.useNode(id, chatKind, { groupRef: { groupOwnerPub, groupName } });
  await space.compactNode(id, { recipients: updatedMembers.map((m) => m.xPub) });
  return updatedMembers;
}

/**
 * Removes one member from a group chat - a plain `editGroup()` call, no
 * compaction needed (see `addGroupChatMembers()`'s own doc comment on why
 * ADDING is the asymmetric case). The removed member keeps whatever
 * they've already decrypted (real E2E behavior, not a gap to close - see
 * `docs/chat-app-concept.md`'s own "entschiedene Punkte") and simply can't
 * write any more (already-enforced `'group'`-ACL, relay AND client-side).
 * @param {import('@qu/space-core').Space} space
 * @param {{groupOwnerPub: Uint8Array, groupName: string, removePub: Uint8Array}} params
 * @returns {Promise<Array<{pub: Uint8Array, xPub: Uint8Array}>>} the Group's full member list after removing.
 */
export async function removeGroupChatMember(space, { groupOwnerPub, groupName, removePub }) {
  const resolver = new ContentResolver(space, { appAdminPub: groupOwnerPub });
  const group = await resolver.resolveGroup(groupName, { ownerPub: groupOwnerPub, forceRevalidate: true });
  if (!group) throw new Error(`removeGroupChatMember: group "${groupName}" (owner ${QuCrypto.toBase64(groupOwnerPub)}) has not synced`);
  const removeB64 = QuCrypto.toBase64(removePub);
  const updatedMembers = group.members.filter((m) => QuCrypto.toBase64(m.pub) !== removeB64);
  await editGroup(space, { name: groupName, members: updatedMembers, ownerPub: groupOwnerPub });
  return updatedMembers;
}

/**
 * Appends one message to a chat, encrypted for whoever is a CURRENT Group
 * member at send time (re-resolved on every call, never cached - see
 * `docs/chat-app-concept.md`'s own "nicht rückwirkend" decision: a member
 * added/removed later never retroactively changes an already-sent
 * message's own recipients). Reuses an already-`useNode()`d chat handle if
 * the caller (typically the open thread's own live subscription) already
 * has one, so this never creates a second, independent reference-counted
 * handle for a chat that's already open - only a caller sending WITHOUT
 * the thread open (unusual, but not disallowed) pays for a fresh one,
 * which is then simply left attached rather than released (same
 * "a few warm Nodes is cheap, see `useNode()`'s own warm-cache" tradeoff
 * `Space` already makes elsewhere - not released here to avoid tearing
 * down a Node a concurrent caller might also be using).
 * @param {import('@qu/space-core').Space} space
 * @param {{groupOwnerPub: Uint8Array, groupName: string}} chat
 * @param {{type?: string, text?: string|null, attachment?: object|null}} fields - `type` defaults `'text'`; `attachment` (fileId/name/mimeType/size/url/...) is for a later Stufe (image/file/audio/video uploads via `@qu/space-plugins`'s `UploadOutbox`/`uploadToRelayBlob()`) - deliberately open-shaped, not enumerated here (this file's own top doc comment).
 * @returns {Promise<object>} the stored message, including its generated `id`/`from`/`sentAt`.
 */
export async function sendMessage(space, { groupOwnerPub, groupName }, { type = 'text', text = null, attachment = null } = {}) {
  const id = await chatNodeId(groupOwnerPub, groupName);
  const groupRef = { groupOwnerPub, groupName };
  const node = space.getNode(id) ?? (await space.useNode(id, chatKind, { groupRef })).node;
  const resolver = new ContentResolver(space, { appAdminPub: groupOwnerPub });
  const group = await resolver.resolveGroup(groupName, { ownerPub: groupOwnerPub });
  if (!group) throw new Error(`sendMessage: group "${groupName}" (owner ${QuCrypto.toBase64(groupOwnerPub)}) has not synced - cannot resolve current recipients`);
  const message = { id: crypto.randomUUID(), from: QuCrypto.toBase64(space.identity.signingPub), type, text, attachment, sentAt: Date.now() };
  await node.field('messages').push(message, { recipients: group.members.map((m) => m.xPub) });
  return message;
}

/**
 * One per identity: a PRIVATE (self-only readable), locally-curated
 * contact list - the "contacts-first" discovery primitive this file's own
 * top doc comment describes. `entries` is a single `'atomic'` array
 * (`Array<{pub, xPub, alias, addedAt}>`, all base64 except `addedAt`),
 * REPLACED wholesale on every edit - same "a curated list, not an
 * append-only log" shape `groupKind.members` already uses, for the exact
 * same reason (a contact can be removed again).
 */
export const contactsKind = defineKind('qu-contacts', {
  fields: { entries: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'owner' },
});

/** @param {import('@qu/space-core').Space} space @returns {Promise<string>} */
function contactsNodeId(space) {
  return deriveOwnerNodeId(space.identity.signingPub, contactsKind.kind);
}

/** Adds (or updates, matched by `pub`) one contact. @param {import('@qu/space-core').Space} space @param {{pub: Uint8Array, xPub: Uint8Array, alias?: string}} contact */
export async function addContact(space, { pub, xPub, alias = null }) {
  const id = await contactsNodeId(space);
  const node = space.getNode(id) ?? (await space.createNode(contactsKind, {}, { id }));
  const entries = (await node.field('entries').get()) ?? [];
  const pubB64 = QuCrypto.toBase64(pub);
  const next = entries.filter((e) => e.pub !== pubB64);
  next.push({ pub: pubB64, xPub: QuCrypto.toBase64(xPub), alias, addedAt: Date.now() });
  await node.field('entries').set(next);
  return next;
}

/** @param {import('@qu/space-core').Space} space @returns {Promise<Array<{pub: string, xPub: string, alias: string|null, addedAt: number}>>} */
export async function listContacts(space) {
  const id = await contactsNodeId(space);
  const node = space.getNode(id) ?? (await space.createNode(contactsKind, {}, { id }));
  return (await node.field('entries').get()) ?? [];
}

/**
 * One per identity: a PRIVATE, locally-maintained index of this identity's
 * own open conversations (which chats to show in a conversation list, and
 * what to show for each without re-resolving the Group itself every time) -
 * there is no OTHER way to enumerate "my chats", since each one is its own
 * independently-addressed, content-ACL `groupKind`/`chatKind` pair (no
 * shared registry by design - see this file's own top doc comment).
 * Updated by the UI whenever it creates/opens/receives into a chat; never
 * shared, never read by anyone but this identity.
 */
export const conversationsKind = defineKind('qu-conversations', {
  fields: { entries: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'owner' },
});

/** @param {import('@qu/space-core').Space} space @returns {Promise<string>} */
function conversationsNodeId(space) {
  return deriveOwnerNodeId(space.identity.signingPub, conversationsKind.kind);
}

/** Records (or updates, matched by `groupOwnerPub`+`groupName`) one conversation in this identity's own index. @param {import('@qu/space-core').Space} space @param {{groupOwnerPub: Uint8Array, groupName: string, kind: '1:1'|'group', title?: string|null, peerPub?: string|null, lastMessageAt?: number}} entry */
export async function recordConversation(space, { groupOwnerPub, groupName, kind, title = null, peerPub = null, lastMessageAt = Date.now() }) {
  const id = await conversationsNodeId(space);
  const node = space.getNode(id) ?? (await space.createNode(conversationsKind, {}, { id }));
  const entries = (await node.field('entries').get()) ?? [];
  const ownerB64 = QuCrypto.toBase64(groupOwnerPub);
  const next = entries.filter((e) => !(e.groupOwnerPub === ownerB64 && e.groupName === groupName));
  next.push({ groupOwnerPub: ownerB64, groupName, kind, title, peerPub, lastMessageAt });
  await node.field('entries').set(next);
  return next;
}

/** @param {import('@qu/space-core').Space} space @returns {Promise<Array<{groupOwnerPub: string, groupName: string, kind: string, title: string|null, peerPub: string|null, lastMessageAt: number}>>} */
export async function listConversations(space) {
  const id = await conversationsNodeId(space);
  const node = space.getNode(id) ?? (await space.createNode(conversationsKind, {}, { id }));
  return (await node.field('entries').get()) ?? [];
}
