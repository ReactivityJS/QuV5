/**
 * PRESENCE / TYPING — custom status and "member X is typing" are ordinary
 * application data, not a transport concern: a self-certifying
 * `acl.write: 'owner'` Kind (`presenceKind`) with `persistence: 'volatile'`
 * (see kind-schema.js's own doc comment) so it flows through the EXACT
 * SAME write/subscribe/mirror path every other Kind uses, just mirrored to
 * an in-memory adapter instead of durable storage - never a bespoke wire
 * message, never something `Space`/the relay treat differently. `Space`
 * itself stays entirely unaware "presence" is a concept, same "flexible
 * watcher, not baked-in mechanism" pattern `alias.js`'s `AliasRegistry`
 * already established for this framework.
 *
 * An EARLIER draft of this added `hello`-piggybacked custom status and a
 * dedicated `'typing'` wire message with its own relay forwarding code
 * path - reverted deliberately: this framework already has a general
 * "the storage adapter decides durability" mechanism (`@qu/space-storage`'s
 * swappable memory/durable/file adapters), and per-Kind `persistence`
 * (this Task) extends it to exactly this case for free, without growing
 * the relay's wire vocabulary at all.
 *
 * ONLINE/OFFLINE LIVENESS is deliberately NOT part of the `presenceKind`
 * Node above - that stays the pre-existing `hello`/`PresenceTracker`
 * mechanism (`@qu/space-transport`'s relay.js), because it is genuinely
 * connection-lifecycle, not data: nothing can SIGN a "went offline" fact
 * after its own connection already dropped. `presenceKind`'s own `online`
 * field is a best-effort, SELF-REPORTED signal instead (set `true` on
 * publish, `false` only via an explicit graceful `publishPresence(space,
 * {online: false})` before disconnecting) - a crash/lost-network never
 * sends that, so a reader wanting to treat a long-silent `online: true` as
 * effectively offline should compare `updatedAt` against its own staleness
 * threshold (how stale is "too stale" is an app/UI policy, not something
 * this framework hardcodes) - the same honest tradeoff any purely
 * peer-signed liveness scheme has without a trusted server participating.
 *
 * UPDATE - `onlineVisibility` + the RELAY's own live connection, made
 * client-readable. `PresenceTracker` (the relay's REAL ground truth, not
 * the self-reported field above) was previously push-routing-only - never
 * told to any client. `onlineVisibility: 'public'|'private'` is a
 * profile-wide setting (independent of how many Spaces/chats this identity
 * shares with a viewer - deliberately no relay-computed `'contacts'` tier;
 * see `presence-visibility.js`'s own doc comment on why) that controls
 * whether the relay will ever disclose that ground truth to a subscriber at
 * all. `declareOnlineVisibility()` below sets BOTH this field (so a fellow
 * Space member can read the setting like any other presence data) AND
 * signs+sends the separate relay declaration the ACTUAL enforcement runs
 * on (`presence-visibility.js`) - the relay never decodes this field
 * itself, same "signed declaration, not relay-side Yjs decoding" reasoning
 * `group-membership.js` already established for `'group'`-ACL mode.
 * `Space.watchLivePresence(pub)`/`LivePresenceWatcher` (below) are the
 * READING half.
 */
import { QuCrypto } from '@qu/core';
import { defineKind, deriveOwnerNodeId } from './kind-schema.js';

/**
 * One per member: `online` (self-reported, see this file's own doc
 * comment), `status` (any app-defined string, `null` = none), `updatedAt`
 * (ms epoch, refreshed on every publish), `typingIn` (a Node id this member
 * is currently typing into, or `null`), `typingAt` (ms epoch of the last
 * typing-state change), `onlineVisibility` (`'public'|'private'`, unset =
 * `'private'` - privacy-first default, same posture `user.js`'s own
 * `listed` field takes; see this file's own "UPDATE" doc comment - this
 * field is the APP-READABLE mirror of a setting the RELAY separately
 * enforces via a signed declaration, never derived FROM this field by the
 * relay itself). All `'atomic'`+`'public'` - an `'owner'`-ACL Kind's meta
 * is already public (see kind-schema.js), so keeping the fields public too
 * avoids needing every watcher to also be a Space member; this is
 * low-sensitivity, inherently short-lived data by design.
 */
export const presenceKind = defineKind('qu-presence', {
  fields: {
    online: { shape: 'atomic', visibility: 'public' },
    status: { shape: 'atomic', visibility: 'public' },
    updatedAt: { shape: 'atomic', visibility: 'public' },
    typingIn: { shape: 'atomic', visibility: 'public' },
    typingAt: { shape: 'atomic', visibility: 'public' },
    onlineVisibility: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'owner' },
  persistence: 'volatile',
});

/**
 * @param {Uint8Array} pub @returns {Promise<string>} the self-certifying
 * presence Node id for `pub` - same derivation any `'owner'`-ACL Kind uses
 * (see kind-schema.js's `deriveOwnerNodeId()`).
 *
 * A RELAY wiring `resolveKindSchema(nodeId)` for an app that has MORE THAN
 * ONE self-certifying (`'owner'`/`'named'`) Kind (e.g. both a profile Kind
 * AND `presenceKind`) can't tell them apart from `nodeId` alone - the
 * derivation hashes the Kind name away, by design (see kind-schema.js's own
 * doc comment on why: nothing about a Node id should leak which Kind
 * produced it beyond "some owner-ACL Kind"). The fix is the same one
 * `demo/auto-demo.mjs` already uses for its own two owner-ACL Kinds:
 * precompute the ids you expect (here, `presenceNodeId(pub)` for every
 * known member) and check membership in that Set, alongside whatever else
 * `resolveKindSchema` already does - not something this function can do
 * for you, since it only knows about ONE identity at a time.
 */
export function presenceNodeId(pub) {
  return deriveOwnerNodeId(pub, presenceKind.kind);
}

/**
 * Publishes (creates on first call, updates thereafter) THIS Space's own
 * presence Node with `fields` - only the given keys are touched, everything
 * else keeps its last-published value (or stays unset). `updatedAt` is
 * always refreshed, even if the caller didn't ask for it, since every
 * publish is itself the "still alive" signal a staleness-based reader
 * depends on.
 * @param {import('./space.js').Space} space
 * @param {{online?: boolean, status?: string|null, typingIn?: string|null}} fields
 * @returns {Promise<import('./node.js').SpaceNode>}
 */
export async function publishPresence(space, fields = {}) {
  const nodeId = await presenceNodeId(space.identity.signingPub);
  const node = space.getNode(nodeId) ?? (await space.createNode(presenceKind, { updatedAt: Date.now() }, { id: nodeId }));
  for (const [name, value] of Object.entries(fields)) await node.field(name).set(value);
  await node.field('updatedAt').set(Date.now());
  if ('typingIn' in fields) await node.field('typingAt').set(Date.now());
  return node;
}

/** Convenience: `publishPresence(space, {status})`. `null` clears back to "no custom status." @param {import('./space.js').Space} space @param {string|null} status */
export const setStatus = (space, status) => publishPresence(space, { status });

/** Convenience: marks this Space's identity as (not) typing into `nodeId` - see this file's own doc comment; NOT a `Field`/CRDT concept from the caller's perspective, just a presence field like any other. @param {import('./space.js').Space} space @param {string} nodeId @param {boolean} typing */
export const setTyping = (space, nodeId, typing) => publishPresence(space, { typingIn: typing ? nodeId : null });

/**
 * Sets THIS Space's identity's profile-wide `onlineVisibility` - see this file's own "UPDATE" doc
 * comment on the split this covers: publishes the app-readable `presenceKind.onlineVisibility`
 * field (`publishPresence()`, ordinary CRDT write) AND, in the SAME call, signs+sends the separate
 * relay declaration (`Space.declareOnlineVisibility()`) the relay's own enforcement actually runs
 * on - the two are kept in sync by construction rather than left for the caller to remember both.
 * @param {import('./space.js').Space} space
 * @param {'public'|'private'} onlineVisibility
 * @returns {Promise<import('./node.js').SpaceNode>}
 */
export async function declareOnlineVisibility(space, onlineVisibility) {
  const node = await publishPresence(space, { onlineVisibility });
  await space.declareOnlineVisibility(onlineVisibility);
  return node;
}

/**
 * Starts (or continues) locally tracking one Node id's `useNode()`
 * reference for `pub`'s presence Node, and returns the CURRENT snapshot
 * once it's had a chance to hydrate/sync - a one-shot convenience for a
 * caller that just wants "what is X's presence right now," without setting
 * up a `PresenceWatcher`. For anything that needs to react to CHANGES, use
 * `PresenceWatcher` instead (below) - repeatedly polling this would just
 * re-run the same `useNode()` reference-count churn for no benefit.
 * @param {import('./space.js').Space} space
 * @param {Uint8Array|string} pub
 * @returns {Promise<{online: boolean|undefined, status: string|null|undefined, updatedAt: number|undefined, typingIn: string|null|undefined, typingAt: number|undefined, release: () => void}>}
 */
export async function watchPresence(space, pub) {
  const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
  const nodeId = await presenceNodeId(pubBytes);
  const { node, release } = await space.useNode(nodeId, presenceKind);
  const [online, status, updatedAt, typingIn, typingAt] = await Promise.all([
    node.field('online').get(),
    node.field('status').get(),
    node.field('updatedAt').get(),
    node.field('typingIn').get(),
    node.field('typingAt').get(),
  ]);
  return { online, status, updatedAt, typingIn, typingAt, release };
}

/**
 * A live, multi-member presence CACHE: call `watch(pub)` once per member
 * you care about, then read `of(pubB64)` any time - kept up to date
 * reactively off `space`'s own `bus` (`space.node.*.changed`, see space.js's
 * own doc comment), no polling. Same "opt-in watcher, Space stays unaware"
 * shape as `alias.js`'s `AliasRegistry`.
 */
export class PresenceWatcher {
  /** @param {import('./space.js').Space} space @param {import('@qu/events').EventBus} bus - the SAME bus given to `space`'s own constructor. */
  constructor(space, bus) {
    this._space = space;
    /** @type {Map<string, string>} presence nodeId -> the pubB64 it belongs to - `deriveOwnerNodeId()` is one-way, so this has to be recorded at `watch()` time rather than recovered from the nodeId later. */
    this._pubByNodeId = new Map();
    /** @type {Map<string, object>} pubB64 -> last known {online, status, updatedAt, typingIn, typingAt} */
    this._map = new Map();
    bus.on('space.node.*.changed', (payload) => {
      if (payload.kind === presenceKind.kind && this._pubByNodeId.has(payload.nodeId)) this._absorb(payload.nodeId);
    });
  }

  /** Starts tracking `pub`'s presence (subscribes via `useNode()` if not already) and populates an initial snapshot before returning. @param {Uint8Array|string} pub */
  async watch(pub) {
    const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
    const pubB64 = QuCrypto.toBase64(pubBytes);
    const nodeId = await presenceNodeId(pubBytes);
    this._pubByNodeId.set(nodeId, pubB64);
    await this._space.useNode(nodeId, presenceKind); // reference-counted - see useNode()'s own doc comment; this class never releases it itself (a caller wanting to stop watching calls space.getNode(nodeId)/unsubscribeNode() directly, same as any other useNode() caller manages their own lifecycle).
    await this._absorb(nodeId);
  }

  async _absorb(nodeId) {
    const node = this._space.getNode(nodeId);
    const pubB64 = this._pubByNodeId.get(nodeId);
    if (!node || !pubB64) return;
    const [online, status, updatedAt, typingIn, typingAt] = await Promise.all([
      node.field('online').get(),
      node.field('status').get(),
      node.field('updatedAt').get(),
      node.field('typingIn').get(),
      node.field('typingAt').get(),
    ]);
    this._map.set(pubB64, { online, status, updatedAt, typingIn, typingAt });
  }

  /** @param {string} pubB64 @returns {{online, status, updatedAt, typingIn, typingAt}|undefined} `undefined` until `watch()` has resolved at least once for this pubkey. */
  of(pubB64) {
    return this._map.get(pubB64);
  }
}

/**
 * A live, multi-identity cache for the RELAY's own real connection state -
 * see this file's own "UPDATE" doc comment for how this differs from
 * `PresenceWatcher` above (that one reads the self-reported `online` field
 * off an ordinary Node; this one reads `Space.watchLivePresence()`'s
 * relay-pushed ground truth off the bus). Same "opt-in watcher, Space stays
 * unaware" shape as `PresenceWatcher`/`alias.js`'s `AliasRegistry`.
 */
export class LivePresenceWatcher {
  /** @param {import('./space.js').Space} space @param {import('@qu/events').EventBus} bus - the SAME bus given to `space`'s own constructor. */
  constructor(space, bus) {
    this._space = space;
    /** @type {Map<string, boolean|undefined>} pubB64 -> last known live online state - `undefined` until the relay's first reply arrives (current state, or a later push), present at all only once `watch()` has been called for it. */
    this._map = new Map();
    bus.on('space.presence.live.changed', ({ pub, online }) => {
      if (this._map.has(pub)) this._map.set(pub, online);
    });
  }

  /** Starts watching `pub`'s REAL live connection state - see `Space.watchLivePresence()`'s own doc comment on what gates whether anything is ever actually reported back. @param {Uint8Array|string} pub */
  async watch(pub) {
    const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
    const pubB64 = QuCrypto.toBase64(pubBytes);
    if (!this._map.has(pubB64)) this._map.set(pubB64, this._space.isLiveOnline(pubB64));
    await this._space.watchLivePresence(pubBytes);
  }

  /** Stops watching `pub` - does not clear the last-known value from `isOnline()`. @param {Uint8Array|string} pub */
  async unwatch(pub) {
    const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
    await this._space.unwatchLivePresence(pubBytes);
  }

  /** @param {string} pubB64 @returns {boolean|undefined} the last known live online state, `undefined` until the relay has replied at least once (or `watch()` was never called for this pubkey). */
  isOnline(pubB64) {
    return this._map.get(pubB64);
  }
}
