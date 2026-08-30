/**
 * AUTO-COMPACT ON JOIN — closes a real gap in `'members'`-mode,
 * `visibility: 'encrypted'` content (the DEFAULT for a field with no
 * `visibility` declared - see kind-schema.js): a member who joins AFTER
 * some history was already written can never decrypt an earlier envelope
 * they weren't a recipient of (no later event retroactively adds a
 * recipient to an already-sealed envelope) - and because Yjs integrates
 * one author's updates as a strictly ordered, gapless sequence (see
 * grant.js's own "WRITE-BEFORE-GRANT IS A TRAP" doc comment for the exact
 * same property applied to grants), that ALSO permanently blocks every
 * LATER update from that same author too, not just the one they missed. A
 * real chat room hits this constantly: rejoin under a new identity (a
 * browser tab's own `loadOrCreateIdentity()` is keyed by display name -
 * changing the name IS a new identity), and every future message from an
 * already-known author silently stops rendering for that one peer, forever
 * - see `space.js`'s own `debug.space.write.remote.undecryptable` doc
 * comment for the mechanics, and demo/README.md's Caveats section for the
 * manual `Space.compactNode()`/`rm -rf demo/.data` workaround this used to
 * require by hand.
 *
 * The fix already exists in the framework (`Space.compactNode()` reseals a
 * Node's ENTIRE current state as one envelope, encrypted for whoever is a
 * member NOW) - what's usually missing is simply CALLING it at the right
 * moment. This watches `space.member.joined` (see space.js's own doc
 * comment on that topic - fires the instant a relay's `member-joined`
 * broadcast arrives) and compacts every Node id you register, so an
 * EXISTING member's own copy closes the gap for whoever just joined,
 * covering everything written from that point forward - built entirely on
 * `@qu/space-core`'s public API, `Space` itself stays unaware this exists,
 * same "opt-in watcher, not baked-in mechanism" pattern `alias.js`'s
 * `AliasRegistry`/`presence.js`'s `PresenceWatcher` already use.
 *
 * Deliberately opt-in per Node id, not automatic for every Node a Space
 * has open: compacting only makes sense for a Node this identity can
 * actually write (an unauthorized `compactNode()` call is simply dropped
 * by the relay the same way any other unauthorized write is - see
 * kind-schema.js's ACL modes - wasted but harmless), and `'owner'`/
 * `'named'`-ACL Nodes have no membership gate at all (kind-schema.js's own
 * doc comment) so never have this gap to close in the first place.
 */

/**
 * @param {import('@qu/space-core').Space} space
 * @param {import('@qu/events').EventBus} bus - the SAME bus given to `space`'s own constructor.
 * @param {Iterable<string>} [nodeIds] - Node ids to compact on every future join. Add more later via the returned `watch()`.
 * @returns {{watch: (nodeId: string) => void, stop: () => void}}
 */
export function autoCompactOnJoin(space, bus, nodeIds = []) {
  const ids = new Set(nodeIds);
  const off = bus.on('space.member.joined', async () => {
    for (const id of ids) await space.compactNode(id);
  });
  return {
    /** Adds another Node id to compact on every future join - e.g. a room created after this watcher started. */
    watch(nodeId) {
      ids.add(nodeId);
    },
    /** Stops reacting to further joins. */
    stop: off,
  };
}
