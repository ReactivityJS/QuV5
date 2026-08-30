/**
 * RELAY IDENTITY — a relay's OWN Ed25519+X25519 keypair. Only meaningful
 * once a relay acts as a PEER itself: authenticating an outbound
 * connection to an upstream relay it federates with (see
 * `federation.js`'s `federateRelay()`, which needs an `identity` to sign
 * `hello`/`subscribe` with). A plain, non-federating relay never touches
 * this at all.
 *
 * Deliberately auto-generated and persisted, never something an admin
 * pastes into an env var by hand: unlike `QU_MEMBERS_JSON` (a genuine
 * ACL decision only a human/operator can make - see `relay-server.js`'s
 * own doc comment on why THAT one legitimately needs input), a relay's
 * own identity is not a decision at all, just a keypair that needs to
 * exist and stay stable across restarts. Requiring one to be generated
 * and copy-pasted in BEFORE the relay can start for the first time is a
 * pure chicken-and-egg problem with no upside - `loadOrCreateIdentity()`
 * resolves it the standard way: generate lazily on first boot, persist,
 * reuse on every later boot.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { QuCrypto } from '@qu/core';

/**
 * @param {string} filePath - Where to load/persist the identity, e.g. `${dataDir}/relay-identity.json`.
 * @returns {Promise<{identity: {signingKey: Uint8Array, signingPub: Uint8Array, xPrivateKey: Uint8Array, xPublicKey: Uint8Array}, created: boolean}>}
 *   `created` is `true` the first time this file didn't exist yet (useful for a one-time "here's your new relay identity" log line).
 */
export async function loadOrCreateIdentity(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    return { identity: decodeIdentity(raw), created: false };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const kp = await QuCrypto.generateKeypair();
  const identity = { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  await mkdir(dirname(filePath), { recursive: true });
  // mode: 0o600 - this file holds private key material; only applies to a NEWLY created file
  // (Node's fs never chmods an already-existing one via this option), which is exactly this branch.
  await writeFile(filePath, JSON.stringify(encodeIdentity(identity), null, 2), { mode: 0o600 });
  return { identity, created: true };
}

/** A short, printable summary of an identity's PUBLIC halves only - never the private keys (see `relay-server.js --print-identity`, the intended caller). */
export async function describeIdentity(identity) {
  return {
    fingerprint: await QuCrypto.fingerprint(identity.signingPub),
    pub: QuCrypto.toBase64(identity.signingPub),
    xPub: QuCrypto.toBase64(identity.xPublicKey),
  };
}

function encodeIdentity(identity) {
  return {
    signingKey: QuCrypto.toBase64(identity.signingKey),
    signingPub: QuCrypto.toBase64(identity.signingPub),
    xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
    xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
  };
}

function decodeIdentity(raw) {
  return {
    signingKey: QuCrypto.fromBase64(raw.signingKey),
    signingPub: QuCrypto.fromBase64(raw.signingPub),
    xPrivateKey: QuCrypto.fromBase64(raw.xPrivateKey),
    xPublicKey: QuCrypto.fromBase64(raw.xPublicKey),
  };
}
