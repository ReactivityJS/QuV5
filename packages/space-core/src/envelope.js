/**
 * ENVELOPE — the one sealed unit that ever leaves a peer, for storage AND
 * for transport alike. This is the V5 replacement for QuBit's `{ts, pub,
 * sig}` envelope, applied one level lower: instead of sealing a whole
 * key/value write, it seals one Yjs CRDT update (a binary diff produced by
 * a single local transaction).
 *
 * Why per-update, not per-Doc: a Y.Doc's value only exists as the MERGE of
 * many peers' contributions, so no single peer can ever meaningfully sign
 * "the document" - by the time a signature was computed, a concurrent edit
 * may already have merged in and invalidated it. An individual update has
 * no such problem: it is atomic, immutable, and produced by exactly one
 * peer, so it can be signed exactly like QuBit's own value used to be.
 *
 * Two independent crypto steps happen here, always in this order - sign
 * over the CIPHERTEXT, never the plaintext (same rule QuStore's own
 * `#seal()` follows, see packages/core/src/store.js):
 *   1. ENCRYPT the update bytes for every space member (ECDH envelope
 *      encryption via QuCrypto.encrypt - the same "one content key, wrapped
 *      per recipient" shape QuStore already uses for `encryptWith`).
 *   2. SIGN the ciphertext with the author's Ed25519 key.
 *
 * This is deliberately the ONLY place a Yjs update is ever encrypted for
 * transport/storage. Whether the plaintext *inside* that update was already
 * itself ciphertext (an 'atomic-encrypted' field write, see field.js) or a
 * genuinely plaintext CRDT text-op (a 'text' field edit) makes no
 * difference here - sealUpdate() cannot tell the two apart, and does not
 * need to: it is the transport/storage boundary, not the field boundary.
 * That is exactly the property this design wants: a relay or a durable
 * store only ever handles ONE kind of thing (a sealed envelope), never a
 * per-field-type special case.
 */
import { QuCrypto } from '@qu/core';

/**
 * @param {Uint8Array} update - Raw bytes from `doc.on('update', ...)`.
 * @param {object} sender - `{signingKey, signingPub, xPrivateKey, xPublicKey}` (Ed25519 + X25519 pairs).
 * @param {Array<Uint8Array>} recipientXPubKeys - Every space member's X25519 public key (encryption recipients).
 * @returns {Promise<object>} A plain, structurally-cloneable envelope - safe to hand to a Transport or a Storage adapter as-is.
 */
export async function sealUpdate(update, sender, recipientXPubKeys) {
  const { iv, ct, to } = await QuCrypto.encrypt(update, recipientXPubKeys, sender.xPrivateKey);
  const sigInput = concatBytes(iv, ct);
  const sig = await QuCrypto.sign(sigInput, sender.signingKey);
  return {
    iv,
    ct,
    to, // [{pub: X25519 recipient pubkey, key: wrapped content key}]
    senderXPub: sender.xPublicKey,
    sig,
    pub: sender.signingPub, // Ed25519 - who to verify the signature against
    ts: Date.now(),
  };
}

/**
 * Verifies an envelope's write signature. Requires ONLY the signer's public
 * key - never a decryption key. A relay (see @qu/space-transport's
 * RelayForwarder) calls exactly this and nothing else, which is what makes
 * it structurally unable to read content: it never even receives an
 * X25519 private key to attempt decryption with.
 * @param {object} envelope
 * @param {(pubBase64: string) => boolean} isAuthorizedWriter - Kind-Schema's write-ACL check.
 * @returns {Promise<boolean>}
 */
export async function verifyEnvelope(envelope, isAuthorizedWriter) {
  const pubB64 = QuCrypto.toBase64(envelope.pub);
  if (!isAuthorizedWriter(pubB64)) return false;
  const sigInput = concatBytes(envelope.iv, envelope.ct);
  return QuCrypto.verify(sigInput, envelope.sig, envelope.pub);
}

/**
 * Decrypts an already-signature-verified envelope back into the raw update
 * bytes for `Y.applyUpdate()`. Only a peer holding the matching X25519
 * private key (i.e. an actual space member) can do this - a relay never
 * can, by construction (see verifyEnvelope's doc comment above).
 * @param {object} envelope
 * @param {{xPrivateKey: Uint8Array, xPublicKey: Uint8Array}} recipient
 * @returns {Promise<Uint8Array>}
 * @throws if `recipient` is not among the envelope's intended recipients.
 */
export async function openUpdate(envelope, recipient) {
  const myPubB64 = QuCrypto.toBase64(recipient.xPublicKey);
  const entry = envelope.to.find((t) => QuCrypto.toBase64(t.pub) === myPubB64);
  if (!entry) throw new Error('openUpdate: recipient is not an intended reader of this envelope');
  return QuCrypto.decrypt(envelope.iv, envelope.ct, entry.key, envelope.senderXPub, recipient.xPrivateKey);
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
