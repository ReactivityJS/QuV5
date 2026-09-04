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
 * `resolveForPath()`) to `{realm: 'main', appAdminPub: <forum's own
 * app-admin>, subPath: "/topic/123"}` - `boot.js` then constructs an
 * ordinary `AppRuntime` for THAT `appAdminPub` and calls
 * `.resolveRoute("/topic/123")` on it, no different from a single-app
 * deployment. The forum app's own content (Manifest/Pages/Templates/
 * Styles) never has to know it's mounted under a prefix at all -
 * `AppRuntime`/`HashRouter` stay completely unaware `PlatformRuntime`
 * exists, same layering `ContentResolver` already keeps from `AppRuntime`
 * (docs §22/§23).
 *
 * TWO KINDS OF MATCH, both handled by the SAME `resolveForPath()`, neither
 * hardcoded to any particular prefix STRING (architecture.md §7 - "kein
 * Sonderfall zu normalen Spaces"):
 *
 *   1. A REGISTERED alias (`qu-platform-apps`, prettier, opt-in, relay-
 *      admin-curated - any of the configured relay-admins, see kinds.js's
 *      own doc comment on `platformAppsKind`'s `'relay-admins'` ACL) -
 *      `{realm: 'main', appAdminPub, ...}` as above, or `{realm: 'global',
 *      ...}` (no `appAdminPub` - a global app has no single owner, see
 *      kinds.js's own "GLOBAL APP CONTENT" doc comment) when a relay-admin
 *      registered that prefix with `registerApp(..., {realm: 'global'})` -
 *      the built-in admin console is conventionally `"admin"`, but any
 *      OTHER prefix works identically; this class never special-cases the
 *      route STRING.
 *   2. UNREGISTERED, the DEFAULT: every app is self-certifyingly reachable
 *      at its OWN owner id with zero relay-admin involvement - the prefix
 *      is tried as a literal base64url-encoded owner pubkey
 *      (`QuCrypto.toBase64Url`/`fromBase64Url`, the same encoding
 *      `content-id.js`'s own Node ids already use). An app-admin never
 *      needs anyone's cooperation just to be reachable; `registerApp()`
 *      only ever adds a prettier alias on top.
 */
import { QuCrypto } from '@qu/core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { platformAppsKind, PLATFORM_REGISTRY_ANCHOR } from './kinds.js';

/** The registry's own id never changes (one global, `'relay-admins'`-ACL registry per relay - see kinds.js's own doc comment) - computed once, lazily, and cached rather than re-derived (an async sha256) on every `resolveApps()` call. */
let platformRegistryIdPromise = null;
function platformRegistryId() {
  return (platformRegistryIdPromise ??= deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind));
}

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
  /**
   * @param {import('@qu/space-core').Space} space - MUST have been constructed with a `relayAdmins`
   *   list including every identity allowed to write `qu-platform-apps` (see `Space`'s own
   *   constructor doc comment) - otherwise every relay-admin's registration write is silently
   *   rejected by this Space's own independent ACL check (never just the relay's), and
   *   `resolveApps()` always returns an empty list.
   */
  constructor(space) {
    this._space = space;
  }

  /**
   * @returns {Promise<Array<{prefix: string, appAdminPub: Uint8Array|null, name: string, realm: 'main'|'global', mode?: 'off'|'global'|'multiuser'}>>}
   *   Every app/alias any configured relay-admin has registered - empty if
   *   none (yet). ONE entry PER PREFIX, even if it was registered/updated
   *   more than once - `apps` is an append-only log (kinds.js's own doc
   *   comment on `platformAppsKind` - `ListField` has no update/removal
   *   primitive), so a LATER entry for an already-known prefix (e.g.
   *   `setAppMode()` changing a `realm: 'global'` app's `mode`) is a state
   *   UPDATE, not a second, competing app - only the LAST one for a given
   *   `prefix` is current. `mode` is only ever meaningful for `realm:
   *   'global'` entries (`undefined` for `realm: 'main'` - see kinds.js's
   *   own doc comment on the three states), defaulting to `'global'` when
   *   absent so every entry from before this field existed (the built-in
   *   admin console's own original registration included) keeps behaving
   *   exactly as before.
   */
  async resolveApps({ timeout } = {}) {
    const id = await platformRegistryId();
    const { node, release } = await this._space.useNode(id, platformAppsKind);
    await waitFor(() => (node.field('apps').length > 0 ? true : null), { timeout: timeout ?? 500 });
    const apps = await node.field('apps').toArray();
    release();
    const byPrefix = new Map();
    for (const a of apps.filter(Boolean)) byPrefix.set(a.prefix, a); // last write per prefix wins - see this method's own doc comment.
    return [...byPrefix.values()].map((a) => ({
      ...a,
      appAdminPub: a.appAdminPub ? QuCrypto.fromBase64(a.appAdminPub) : null,
      realm: a.realm ?? 'main',
      mode: (a.realm ?? 'main') === 'global' ? (a.mode ?? 'global') : undefined,
    }));
  }

  /**
   * @param {string} fullPath - the CURRENT route, e.g. `"/forum/topic/123"`.
   * @returns {Promise<{prefix: string, subPath: string, realm: 'main'|'global', mode?: 'off'|'global'|'multiuser', appAdminPub?: Uint8Array, name: string|null}|null>}
   *   `null` if `prefix` matches NEITHER a registered alias NOR a valid
   *   owner id (see this file's own top doc comment's "TWO KINDS OF
   *   MATCH"), OR if it matches a `realm: 'global'` app currently in
   *   `mode: 'off'` (kinds.js's own doc comment on the three states) -
   *   `boot.js`'s cue to render the landing page either way, indistinguishable
   *   from "never registered" on purpose (an "off" app should look exactly
   *   as absent as one that was never installed, not like a broken one).
   */
  async resolveForPath(fullPath, options) {
    const { prefix, subPath } = splitPath(fullPath);
    const apps = await this.resolveApps(options);
    const match = apps.find((a) => a.prefix === prefix); // safe - resolveApps() already dedupes to one (current) entry per prefix.
    if (match) {
      if (match.realm === 'global' && match.mode === 'off') return null;
      return { ...match, subPath };
    }
    try {
      const appAdminPub = QuCrypto.fromBase64Url(prefix);
      if (appAdminPub.length !== 32) return null;
      return { prefix, subPath, realm: 'main', appAdminPub, name: null };
    } catch {
      return null; // not a registered alias and not a well-formed owner id either.
    }
  }
}
