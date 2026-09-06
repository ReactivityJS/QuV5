/**
 * VERIFY WRITES ACKED — factored out of `cms-actions.js` so every OTHER
 * "framework interactivity attaches to inert markup" wiring file
 * (`guestbook-actions.js`/`blog-actions.js`/`forum-actions.js`) can give
 * its own forms the SAME real-relay-confirmation guarantee, not just the
 * CMS editor. A REAL, deployment-observed failure class this exists to
 * catch: a save that silently never reaches the relay at all - most
 * commonly, a write REJECTED because the signed-in identity is neither
 * `nodeId`'s owner (or a granted co-editor, for `'content'`-ACL content)
 * NOR a current Space member (for `'members'`-ACL content, e.g. a
 * Guestbook/Forum's own shared lists). Every `@qu/app-core` Dev API
 * mutation applies its own change to the LOCAL Y.Doc synchronously and
 * returns - `await`ing it only proves the LOCAL mutation happened, never
 * that the relay accepted it (`@qu/space-transport`'s relay.js own
 * `acceptWrite()` sends a `write-ack` on success; a REJECTED write gets no
 * reply of any kind - see that file's own "WRITE-ACK" doc comment).
 * Without this, a form would show a bare "Gespeichert"/"Eingetragen" the
 * instant the local mutation applied, REGARDLESS of whether the relay
 * ever actually accepted it - the symptom is genuinely confusing without
 * this check: the value stays visible until the next reload (the local
 * Y.Doc still holds the optimistic mutation), then silently reverts,
 * because the relay's own mirror - what a reload actually re-syncs from -
 * never had it.
 *
 * Watches `nodeId`'s own `debug.space.write.local`/`space.node.<id>.
 * write-ack` pair on `space`'s own `bus` (`Space`'s own `bus` getter)
 * WHILE `fn()` runs, then waits up to `timeout` for every local write it
 * counted to be acked - throws a clear, actionable error instead of
 * resolving silently if even one wasn't. No-ops (skips verification, same
 * as before this existed) if `space` has no `bus` configured at all
 * (still true of some test setups) - can't verify what it can't observe,
 * and that must never make an otherwise-working save start throwing.
 * @param {import('@qu/space-core').Space} space
 * @param {string} nodeId - the SAME id `fn()`'s own write(s) target.
 * @param {() => Promise<*>} fn
 */
export async function verifyWritesAcked(space, nodeId, fn, { timeout = 3000 } = {}) {
  const bus = space.bus;
  if (!bus) return fn();
  let expected = 0;
  let acked = 0;
  const offLocal = bus.on('debug.space.write.local', (payload) => {
    if (payload?.nodeId === nodeId) expected++;
  });
  const offAck = bus.on(`space.node.${nodeId}.write-ack`, () => {
    acked++;
  });
  try {
    const result = await fn();
    // `fn()` resolving proves only that its OWN field.set()/replaceText() calls returned - Yjs's
    // `doc.on('update', ...)` (space.js's own `_handleLocalUpdate()`) fires SYNCHRONOUSLY but is
    // itself `async` (sealing an envelope is real crypto work) and is never awaited by the write
    // that triggered it, so `debug.space.write.local` for THIS save can still be several
    // microtasks/one real async hop away from having fired at all - `expected` itself needs a
    // moment to catch up before comparing it against `acked` means anything, the same "settle"
    // margin `bootstrap-platform.mjs`'s own `waitUntilAllWritesAcked()` already bakes in for the
    // identical reason, just applied before the FIRST check here instead of only before it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const deadline = Date.now() + timeout;
    while (acked < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (acked < expected) {
      throw new Error(
        'Speichern wurde vom Relay nicht bestätigt - die Änderung bleibt nur lokal sichtbar und geht bei einem Reload verloren. ' +
          'Meist bedeutet das: die aktuell angemeldete Identität ist weder Owner/Mitglied dieses Inhalts noch wurde ihr Schreibzugriff gewährt.'
      );
    }
    return result;
  } finally {
    offLocal();
    offAck();
  }
}
