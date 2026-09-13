/**
 * SEAL STRATEGIES — the pluggable "who does `envelope.to` name" policy
 * (docs/routing-anonymity.md, "2. Empfänger-Anonymität bei 1:n-Gruppen"):
 * `Space`'s constructor `sealStrategy` param, the SAME dependency-
 * injection idea this framework already uses for `storage`/`transport`
 * (swap the concrete implementation, never the call site), applied to one
 * more concern - HOW an envelope's recipient list is shaped, not just
 * where bytes are stored/sent.
 *
 * A strategy is a pure, synchronous function:
 *   `({recipientXPubKeys: Array<Uint8Array>, memberXPubKeys: Array<Uint8Array>}) => Array<Uint8Array>`
 * returning which ADDITIONAL member X25519 pubkeys should get a PADDING
 * entry in `envelope.to` (see `@qu/core`'s `QuCrypto.encrypt()`'s own
 * `paddingXPubKeys` param doc comment for what "padding" means
 * structurally - a byte-indistinguishable dummy, never a usable key) -
 * `space.js`'s `_handleLocalUpdate()` calls it once per local write and
 * passes the result straight through to `sealUpdate()`. Never async,
 * never touches the network/crypto itself - purely "which pubkeys," the
 * actual padding bytes are `QuCrypto.encrypt()`'s job.
 *
 * Registered as the `'sealStrategy'` slot in `@qu/bootstrap`'s adapter
 * registry (`registerSealStrategyAdapters()`) - a deployment picks one by
 * NAME (`{adapter: 'pad-to-members'}`) through `bootstrapSpace()`, exactly
 * like `storage`/`transport`. A THIRD future strategy (e.g. padding to a
 * FIXED count instead of the full membership, trading some privacy for
 * less bandwidth on a huge Space) is pure addition - a new function here,
 * a new registration there, zero change to `Space`/`envelope.js`.
 */
import { QuCrypto } from '@qu/core';

/** The default - `envelope.to` names exactly the real recipients, nothing more (unchanged behavior from before this param existed). */
function none() {
  return [];
}

/**
 * Pads `envelope.to` out to this Space's FULL current membership: every
 * member NOT already an intended recipient gets an indistinguishable
 * dummy entry, so a `{recipients}`-narrowed write's real audience is never
 * visible to a relay/network observer - only that SOME subset of the
 * Space's membership was addressed, which is already knowable from the
 * member list itself (a relay's own self-join endpoint, e.g. `@qu/app-
 * shell`'s `/members.json` - see docs/routing-anonymity.md's own
 * "Sender-Anonymität" section on why that's not a NEW leak). A plain,
 * un-narrowed write (the common case - `recipientXPubKeys` already equals
 * every member) costs nothing extra here: there's no member left to pad.
 */
function padToMembers({ recipientXPubKeys, memberXPubKeys }) {
  const already = new Set(recipientXPubKeys.map((pub) => QuCrypto.toBase64(pub)));
  return memberXPubKeys.filter((pub) => !already.has(QuCrypto.toBase64(pub)));
}

export const sealStrategies = Object.freeze({ none, padToMembers });
