/**
 * PLATFORM RUNTIME — the layer ABOVE a single `AppRuntime` (docs/
 * app-shell-arbeitsauftrag.md §19-21): resolves the CURRENT route's first
 * path segment against the relay-admin's `qu-platform-apps` registry
 * (`kinds.js`) to decide WHICH app owns it, then hands the REMAINING path
 * to that app's own `AppRuntime` exactly as if it were the only app on the
 * relay. Neither the Shell nor the Relay need to know in advance which
 * apps exist - this Node is the one place that mapping lives, same
 * "registry Node, not a query" pattern `kinds.js`'s own
 * `routeRegistryKind` already uses one level down.
 *
 * `#/forum/topic/123` example: prefix `"forum"` resolves (via
 * `resolveForPath()`) to `{appAdminPub: <forum's own app-admin>, subPath:
 * "/topic/123"}` - `boot.js` then constructs an ordinary `AppRuntime` for
 * THAT `appAdminPub` and calls `.resolveRoute("/topic/123")` on it, no
 * different from a single-app deployment. The forum app's own content
 * (Manifest/Pages/Templates/Styles) never has to know it's mounted under a
 * prefix at all - `AppRuntime`/`HashRouter` stay completely unaware
 * `PlatformRuntime` exists, same layering `ContentResolver` already keeps
 * from `AppRuntime` (docs §22/§23).
 */
import { QuCrypto } from '@qu/core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { platformAppsKind } from './kinds.js';

/** Polls `checkFn` until it returns a non-null/non-undefined value, or `timeout` elapses (then returns `null`) - same shape as `resolver.js`'s own `waitFor()`, local here to avoid a needless cross-file dependency for one small helper. */
async function waitFor(checkFn, { timeout = 4000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await checkFn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** @param {string} fullPath @returns {{prefix: string, subPath: string}} splits `"/forum/topic/123"` into `{prefix: "forum", subPath: "/topic/123"}`; `"/"`/`""` into `{prefix: "", subPath: "/"}`. */
function splitPath(fullPath) {
  const trimmed = (fullPath || '/').replace(/^\/+/, '');
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) return { prefix: trimmed, subPath: '/' };
  return { prefix: trimmed.slice(0, slashIndex), subPath: '/' + trimmed.slice(slashIndex + 1) };
}

export class PlatformRuntime {
  /** @param {import('@qu/space-core').Space} space @param {{relayAdminPub: Uint8Array|string}} params */
  constructor(space, { relayAdminPub }) {
    this._space = space;
    this._relayAdminPub = typeof relayAdminPub === 'string' ? QuCrypto.fromBase64(relayAdminPub) : relayAdminPub;
  }

  /** @returns {Promise<Array<{prefix: string, appAdminPub: Uint8Array, name: string}>>} Every app the relay-admin has registered - empty if none (yet). */
  async resolveApps({ timeout } = {}) {
    const id = await deriveOwnerNodeId(this._relayAdminPub, platformAppsKind.kind);
    const { node, release } = await this._space.useNode(id, platformAppsKind);
    await waitFor(() => (node.field('apps').length > 0 ? true : null), { timeout: timeout ?? 500 });
    const apps = await node.field('apps').toArray();
    release();
    return apps.filter(Boolean).map((a) => ({ ...a, appAdminPub: QuCrypto.fromBase64(a.appAdminPub) }));
  }

  /**
   * @param {string} fullPath - the CURRENT route, e.g. `"/forum/topic/123"`.
   * @returns {Promise<{prefix: string, appAdminPub: Uint8Array, name: string, subPath: string}|null>} `null` if no registered app owns this prefix.
   */
  async resolveForPath(fullPath, options) {
    const { prefix, subPath } = splitPath(fullPath);
    const apps = await this.resolveApps(options);
    const match = apps.find((a) => a.prefix === prefix);
    return match ? { ...match, subPath } : null;
  }
}
