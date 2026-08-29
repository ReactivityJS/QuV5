/**
 * DEMO IDENTITY HELPERS — not part of the @qu/* packages themselves, just
 * thin glue so the demo scripts (auto-demo.mjs/relay.mjs/chat.mjs) can
 * persist a peer's Ed25519+X25519 keypair across process runs and derive
 * every peer's short pubkey fingerprint (`QuCrypto.fingerprint()`, see
 * `packages/core/src/crypto.js`) for display.
 *
 * Deliberately simple, single-machine semantics: every demo identity lives
 * as one JSON file (base64-encoded keys, private material included) under
 * one shared directory (`demo/.identities/` by default, gitignored). That
 * is fine for "two terminals on the same laptop," which is what this demo
 * is for - it is NOT how a real deployment would distribute identities (a
 * real peer never puts its private key next to a public directory of
 * everyone else's).
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuCrypto } from '@qu/core';

export const DEFAULT_IDENTITY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.identities');

/** Loads `<dir>/<name>.json` if it exists, otherwise generates and persists a fresh keypair under that name. */
export async function ensureIdentity(name, dir = DEFAULT_IDENTITY_DIR) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return {
      name,
      signingKey: QuCrypto.fromBase64(raw.signingKey),
      signingPub: QuCrypto.fromBase64(raw.signingPub),
      xPrivateKey: QuCrypto.fromBase64(raw.xPrivateKey),
      xPublicKey: QuCrypto.fromBase64(raw.xPublicKey),
    };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const kp = await QuCrypto.generateKeypair();
  const identity = { name, signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  await writeFile(
    file,
    JSON.stringify(
      {
        name,
        signingKey: QuCrypto.toBase64(identity.signingKey),
        signingPub: QuCrypto.toBase64(identity.signingPub),
        xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
        xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
      },
      null,
      2
    ),
    'utf8'
  );
  return identity;
}

/** Every identity file currently in `dir`, as PUBLIC halves only - `{name, pub, xPub}` - suitable for a Space's `members` list. */
export async function loadMembers(dir = DEFAULT_IDENTITY_DIR) {
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const members = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(dir, file), 'utf8'));
    members.push({ name: raw.name, pub: QuCrypto.fromBase64(raw.signingPub), xPub: QuCrypto.fromBase64(raw.xPublicKey) });
  }
  return members;
}

/** `QuCrypto.fingerprint()` of an identity's Ed25519 signing key - the "who is this" a demo UI shows next to a message. */
export async function fingerprintOf(identity) {
  return QuCrypto.fingerprint(identity.signingPub ?? identity);
}
