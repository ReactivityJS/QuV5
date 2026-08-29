/**
 * FILE STORE — real, on-disk persistence: one append-only newline-delimited
 * JSON file per Node id under `dataDir`. This is what `createDurableStore()`
 * (durable-store.js) only SIMULATES for tests - the actual "survives a
 * process/container restart" tier, used by relay-server.js/the Docker
 * deployment (see docs/v5-space-core-guide.md) so a relay's mirror (see
 * @qu/space-transport's relay.js) is still there after a redeploy/restart,
 * not just for the lifetime of one running process.
 *
 * Every envelope is run through `@qu/space-core`'s `encodeForWire()`/
 * `decodeFromWire()` before being written/after being read - the exact
 * same problem (Uint8Array fields don't survive `JSON.stringify` as-is)
 * that motivated that module for the WebSocket wire, applies identically
 * to a JSON file on disk.
 *
 * Deliberately simple for this PoC: append-only, no compaction, no
 * concurrent-writer locking (fine for one relay process owning its own
 * data directory, the only deployment shape this PoC targets - see the
 * guide's "known gaps" section for what a production version would add).
 */
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeForWire, decodeFromWire } from '@qu/space-core';

/**
 * @param {string} dataDir - Directory to store one `<nodeId>.ndjson` file per Node in. Created if missing.
 */
export function createFileStore(dataDir) {
  function fileFor(nodeId) {
    // Node ids are framework-generated (crypto.randomUUID() by default, see
    // @qu/space-core's Space.createNode()) or caller-chosen - encodeURIComponent
    // keeps an arbitrary id filesystem-safe without inventing a second ID
    // scheme, and rules out path traversal via a hostile "../.." id.
    return join(dataDir, `${encodeURIComponent(nodeId)}.ndjson`);
  }

  return {
    async append(nodeId, envelope) {
      await mkdir(dataDir, { recursive: true });
      const line = `${JSON.stringify(encodeForWire(envelope))}\n`;
      await appendFile(fileFor(nodeId), line, 'utf8');
    },

    async load(nodeId) {
      let content;
      try {
        content = await readFile(fileFor(nodeId), 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return []; // nothing written for this Node (yet).
        throw err;
      }
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => decodeFromWire(JSON.parse(line)));
    },
  };
}
