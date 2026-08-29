/**
 * MEMORY STORE — the "flüchtig"/ephemeral tier (see docs/v5-space-core-guide.md): a
 * Node still syncs live through this (nothing about signing/verification
 * changes), but nothing survives past this process's lifetime. Same role
 * as QuStore's VolatileAdapter used to play, just for sealed envelopes
 * instead of QuBits.
 *
 * Note this stores the envelope AS-IS (ciphertext + signature, never the
 * plaintext update) - "memory-only" describes lifetime, not confidentiality.
 * Even a purely in-RAM tier never holds a decryptable copy unless the
 * holding process is itself an authorized space member.
 */
export function createMemoryStore() {
  /** @type {Map<string, object[]>} */
  const log = new Map();
  return {
    async append(nodeId, envelope) {
      const list = log.get(nodeId) ?? [];
      list.push(envelope);
      log.set(nodeId, list);
    },
    async load(nodeId) {
      return [...(log.get(nodeId) ?? [])];
    },
  };
}
