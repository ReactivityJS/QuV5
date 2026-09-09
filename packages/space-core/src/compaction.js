/**
 * COMPACTION POLICY — an OPT-IN mechanism, deliberately NOT automatic
 * background scheduling: the relay is content-blind BY DESIGN (`space.js`'s
 * own top doc comment - it never holds a signing/encryption key), so it
 * structurally CANNOT compact anything itself. Producing a compacted
 * snapshot means sealing a brand-new, validly-signed envelope
 * (`Space.compactNode()`) - something only an authorized WRITER's own
 * Space can do, and only for a Node that Space currently has attached.
 *
 * `compactIfNeeded()` is therefore a small helper a write-path Dev API
 * function calls right after its OWN write completes - "did this write
 * push the Node's local history past a threshold? if so, compact it" -
 * never a timer/scheduler this package would need to own the lifecycle of.
 * The first real caller is `@qu/app-core`'s `pushToSharedList()` (a
 * Guestbook/Forum entry - the highest-churn, most write-heavy content this
 * framework has, exactly the "10.000 Einträge" case this exists for), via
 * its own opt-in `compactThreshold` param - every EXISTING caller that
 * never passes it keeps behaving exactly as before this existed, zero
 * added cost.
 *
 * COST NOTE: `Space.envelopeCount()` reads the Node's ENTIRE stored
 * envelope array just to report its `.length` - an O(n) check, same cost
 * class as the replay this whole mechanism exists to bound. Calling this
 * after EVERY write on a large list re-pays that cost every time (though
 * still far cheaper than what a fresh subscriber's own full replay would
 * cost) - a caller writing at high frequency should check less often than
 * every single write (e.g. only every Nth call, or only past a MUCH higher
 * threshold) rather than relying on this module to rate-limit itself; kept
 * simple here on purpose, real usage patterns should decide that policy.
 */

/**
 * @param {import('./space.js').Space} space
 * @param {string} id
 * @param {{threshold?: number}} [options] - `threshold` (default 500) - compact once the Node's own
 *   stored envelope count exceeds this. No storage adapter mounted for this Node (`envelopeCount()`
 *   returning `null`) is a silent no-op, not an error - compaction is a local-storage/relay-mirror
 *   optimization, never something a caller without persistence needs to think about.
 */
export async function compactIfNeeded(space, id, { threshold = 500 } = {}) {
  const count = await space.envelopeCount(id);
  if (count != null && count > threshold) await space.compactNode(id);
}
