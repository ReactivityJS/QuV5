/**
 * SYNC GUARD — "keep the screen awake while `UploadOutbox` still has work
 * in flight" via the Screen Wake Lock API (`navigator.wakeLock`), so a
 * large upload started right before the phone would otherwise auto-lock
 * gets a chance to actually finish. Built entirely on `UploadOutbox`'s own
 * public `watchAll()` (see upload-outbox.js) - this file adds no new Kind,
 * no new state, just a DOM-facing reaction to the SAME `'pending'`/
 * `'uploading'`/`'done'`/`'failed'`/`'synced'` lifecycle every other
 * consumer of that class already reads.
 *
 * Acquires the lock the instant ANY record is `'pending'`/`'uploading'`,
 * releases it the instant NONE are (`'done'`/`'synced'`/`'failed'` all
 * count as settled here - a `'failed'` entry is only retried on an
 * explicit `retry()` call, so it is not "in flight" until then). Also
 * re-acquires on `visibilitychange` when the guard still has in-flight work
 * outstanding: a Wake Lock is unconditionally released by the browser the
 * moment a tab is backgrounded (spec behaviour, not a bug) - `guardSync()`
 * itself cannot prevent that, only ask again once the tab is foregrounded.
 *
 * IMPORTANT LIMIT (see this file's own name: a GUARD, not a lifeline) - a
 * Wake Lock only prevents the SCREEN from sleeping/locking; it does nothing
 * once the tab/app itself is backgrounded or closed by the OS (a browser
 * page has no way around that scheduling limit). A Service Worker with
 * Background Sync is the separate, independent building block for "keep
 * uploading even while backgrounded" - this helper does not replace it.
 *
 * Missing/unsupported `navigator.wakeLock` (older browsers, Node, a
 * `document.visibilityState === 'hidden'` request rejection) degrades to a
 * silent no-op rather than throwing - a chat/forum UI should work exactly
 * the same either way, just without the screen staying on.
 */

function anyInFlight(records) {
  return records.some((r) => r.status === 'pending' || r.status === 'uploading');
}

/**
 * @param {import('./upload-outbox.js').UploadOutbox} outbox
 * @returns {Promise<() => Promise<void>>} stop() - unobserves the outbox and releases any held lock.
 */
export async function guardSync(outbox) {
  let lock = null;
  let stopped = false;
  let inFlight = false;

  async function acquire() {
    if (lock || stopped) return;
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // request() would just reject - visibilitychange below retries once visible again.
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener?.('release', () => {
        lock = null;
      });
    } catch {
      lock = null; // e.g. a race where the tab was backgrounded between the check above and the request landing.
    }
  }

  async function release() {
    if (!lock) return;
    const held = lock;
    lock = null;
    await held.release?.().catch(() => {});
  }

  async function sync(records) {
    inFlight = anyInFlight(records);
    if (stopped) return;
    if (inFlight) await acquire();
    else await release();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && inFlight) acquire();
  }
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisibilityChange);

  const unobserve = await outbox.watchAll(sync);

  return async function stop() {
    stopped = true;
    unobserve();
    if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisibilityChange);
    await release();
  };
}
