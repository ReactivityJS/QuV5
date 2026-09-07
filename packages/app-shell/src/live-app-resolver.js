/**
 * LIVE APP-ADMIN RESOLVER — the actual fix for the "new app-admin needs a
 * relay restart" gap `@qu/app-core`'s `relay-resolver.js` own doc comment
 * used to document as a deliberate, accepted limitation. Wraps
 * `createAppResolveKindSchema()` (a small, pure, synchronous-result
 * builder) in a reactive shell: this relay connects an INTERNAL, read-only
 * `Space` to ITSELF, over a REAL WebSocket loopback connection (exactly
 * the same `WsClientTransport` any ordinary peer/browser uses - no
 * fabricated in-process shortcut, see "WHY A REAL SOCKET" below), and
 * watches `qu-platform-apps` - now a `'relay-admins'`-ACL registry any
 * configured relay-admin may write, see `@qu/app-core`'s kinds.js own doc
 * comment - rebuilding the resolver's `appAdminPubs` set every time that
 * registry changes. A relay-admin registering a brand-new app-admin
 * (`registerApp()`) is therefore enough on its own - no separate STATIC
 * `QU_APP_ADMIN_PUBS` list, no restart.
 *
 * WHY A REAL SOCKET, NOT `InProcessTransport`: that primitive (`@qu/space-
 * transport`'s own tests use it) only works against a hub built by
 * `createInProcessHub()`, which ALSO plays the peer-registration role
 * (`registerPeerInbox`/`sendToRelay`) - a real relay's hub
 * (`createWsServerHub()`) deliberately has NO such API (see that file's
 * own doc comment: "there is no `registerPeerInbox`/`sendToRelay` here -
 * those are PEER-side concerns"), only real socket connections. Rather
 * than inventing a THIRD, relay-only "local peer" hub API, this reader
 * connects the exact same way any other peer would - simpler, and proves
 * the live registry is reachable through the SAME path a real app-admin's
 * own `registerApp()`/`createApp()` calls use, not a parallel one.
 *
 * WHY THIS LIVES HERE, NOT IN `@qu/app-core`: `@qu/app-core`'s own `src/`
 * deliberately has no real dependency on `@qu/space-transport` (only a
 * devDependency, used by its tests) - it stays transport-agnostic, DOM-
 * free, "Zero DOM dependency" (see runtime.js's own doc comment). This
 * file needs `WsClientTransport`, which only makes sense at the layer that
 * ALREADY composes `@qu/space-transport` with the App layer -
 * `@qu/app-shell`, exactly where `relay-server.js` itself lives.
 *
 * ORDERING: `resolveKindSchema` (the function this returns) MUST be handed
 * to `createRelayForwarder({hub, resolveKindSchema, ...})` BEFORE
 * `start()` is called, AND the relay's HTTP/WebSocket server must already
 * be LISTENING (`start()` connects to `url` as an ordinary client - see
 * `relay-server.js`'s own `main()` for the exact "listen, then start()"
 * order). The returned `resolveKindSchema` is a STABLE function reference
 * from the start - it delegates to a swappable inner closure (`current`),
 * which is what lets its behavior update over time without ever handing
 * the relay a new function object (relay.js only ever reads the one
 * passed at construction).
 *
 * BOOTSTRAP WINDOW: before `start()`'s own first `await` resolves,
 * `current` briefly classifies nothing but `qu-platform-apps` itself
 * (correct - its id is a FIXED anchor, not app-admin-dependent) - any
 * request for an app-admin's own content arriving in that microscopic
 * window falls through to the ordinary `pageKind` fallback (still safe:
 * `'content'`-ACL is grant-derived, never silently over-permissive) rather
 * than its real `'named'`-ACL classification, and simply retries on the
 * client's own reconnect/resubscribe logic - the same small, accepted race
 * every other "resolveKindSchema built once at boot" caller already lives
 * with, just now re-run reactively instead of only once.
 */
import { QuCrypto } from '@qu/core';
import { Space, deriveOwnerNodeId } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import WebSocket from 'ws';
import { createAppResolveKindSchema, platformAppsKind, PLATFORM_REGISTRY_ANCHOR, adminRouteRegistryKind, globalAppAnchor } from '@qu/app-core';

/**
 * A REAL REGRESSION THIS ONCE HAD, fixed here: once this file starts
 * rebuilding `resolveKindSchema` reactively, it ALWAYS passes an explicit
 * `globalApps` array to `createAppResolveKindSchema()` - which means that
 * function's OWN default parameter (`[{prefix: 'admin', templateNames:
 * ['main'], ...}]`, matching what `admin-console-bundle.js` ships) never
 * applies in platform mode any more, not even for the 'admin' prefix
 * itself. The built-in admin console's own "main" template is hardcoded
 * here rather than relying on any dynamic registration - it predates
 * `registerApp()`'s own `globalTemplateNames` param (below) and there is no
 * reason to ever make its OWN operators declare it. Every OTHER global
 * app's own template/style names ARE now dynamic (`rebuild()`'s own
 * `globalTemplateNamesByPrefix`/`globalStyleNamesByPrefix`, merged with
 * this hardcoded set below) - `kinds.js`'s own `platformAppsKind` doc
 * comment on the real, observed failure that gap used to cause: a NEW
 * global app's own template (`installGlobalCms()`'s `__cms__`, for any
 * prefix other than "admin") was silently REJECTED (no `'relay-admins'`
 * -ACL classification exists for a name the relay was never told about)
 * until `registerApp()`/`addGlobalTemplateNames()` closed it.
 */
const KNOWN_GLOBAL_TEMPLATE_NAMES = { admin: ['main'] };

/**
 * @param {{collectionRegistryKinds?: object[]}} [params] - forwarded to every `createAppResolveKindSchema()` rebuild, see that function's own doc comment.
 * @returns {{resolveKindSchema: (nodeId: string, claimedPub?: Uint8Array) => Promise<object>, start: (params: {url: string, relayAdmins?: Array<Uint8Array>}) => Promise<void>}}
 */
export function createLiveAppResolveKindSchema({ collectionRegistryKinds = [] } = {}) {
  let current = () => null; // replaced synchronously at the top of start(), before its first await - see this file's own "BOOTSTRAP WINDOW" doc comment.
  // `claimedPub` passed straight through - see relay.js's own doc comment on `resolveKindSchema`'s
  // second parameter (the "self-provisioned participant, never in appAdminPubs" fallback it
  // unlocks) - `current` is `createAppResolveKindSchema()`'s own returned closure, already async.
  const resolveKindSchema = (nodeId, claimedPub) => current(nodeId, claimedPub);

  /** @param {{url: string, relayAdmins?: Array<Uint8Array>}} params - `url` is this SAME relay's own address (e.g. `ws://127.0.0.1:<port>`), reached ONLY after it is actually listening - see this file's own "ORDERING" doc comment. */
  async function start({ url, relayAdmins = [] }) {
    current = await createAppResolveKindSchema({ appAdminPubs: [], collectionRegistryKinds });

    const kp = await QuCrypto.generateKeypair(); // throwaway - this Space only ever reads (useNode()), never writes, so no real identity is needed.
    const identity = { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
    const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
    await transport.connect();
    // members: [] - 'relay-admins'-ACL subscribe/read never needs Space membership (relay.js's own
    // handleSubscribe() bypass, see kind-schema.js's doc comment on the mode) - and this reader
    // never writes, so it never needs to be authorized as a relay-admin either.
    const space = new Space({ identity, members: [], relayAdmins, transport });

    const platformId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
    const { node } = await space.useNode(platformId, platformAppsKind); // never released - lives for this relay process's own lifetime.
    const field = node.field('apps');

    // WATCHING EVERY GLOBAL APP'S OWN ROUTE REGISTRY - the SAME reactive idea as `qu-platform-apps`
    // itself, one level down: a relay-admin CREATING a brand-new global app's page needs its route
    // correctly classified (`adminPageKind`, 'relay-admins'-ACL) the moment it's published, not
    // after a restart - see `@qu/app-core`'s `dev.js`'s own `publishGlobalRoute()` doc comment.
    // Global apps are only ever ADDED (`qu-platform-apps`'s own `ListField` has no removal), so a
    // watch, once started for a given prefix, never needs tearing down - `watchedPrefixes` just
    // tracks which ones already have one, so `ensureGlobalWatches()` never double-subscribes.
    const watchedPrefixes = new Set();
    const globalPageRoutesByPrefix = new Map(); // prefix -> string[], updated in place by each registry's own observe() callback.

    async function watchGlobalRouteRegistry(prefix) {
      const anchor = await globalAppAnchor(prefix);
      const registryId = await deriveOwnerNodeId(anchor, adminRouteRegistryKind.kind);
      const { node: registryNode } = await space.useNode(registryId, adminRouteRegistryKind); // never released - same "lives for this process" posture as the platform registry above.
      const routesField = registryNode.field('routes');
      const syncRoutes = async () => {
        globalPageRoutesByPrefix.set(prefix, await routesField.toArray());
        await rebuild();
      };
      routesField.observe(syncRoutes); // fire-and-forget from the ListField's own synchronous handler - each call's own rebuild() below settles independently, see ensureGlobalWatches()'s own comment.
      await syncRoutes(); // initial snapshot for this newly-discovered global app, same reasoning as the platform registry's own initial rebuild() below.
    }

    async function ensureGlobalWatches(apps) {
      const prefixes = apps.filter((a) => a?.realm === 'global').map((a) => a.prefix);
      const newOnes = prefixes.filter((prefix) => !watchedPrefixes.has(prefix));
      for (const prefix of newOnes) watchedPrefixes.add(prefix);
      await Promise.all(newOnes.map(watchGlobalRouteRegistry)); // each call's own rebuild()s (via syncRoutes()) are harmless no-ops until this function's own rebuild() below runs anyway.
    }

    async function rebuild() {
      const apps = (await field.toArray()).filter(Boolean);
      await ensureGlobalWatches(apps);
      const appAdminPubs = apps
        .map((a) => a.appAdminPub)
        .filter(Boolean)
        .map((b64) => QuCrypto.fromBase64(b64));
      // `globalViewNames`, unlike `pageRoutes` above, has no registry of its own to watch live
      // (`dev.js`'s `registerApp()` own doc comment on why) - it's read straight off each app's
      // OWN `qu-platform-apps` entry instead, same as `sharedLists` below. Last entry per prefix
      // wins, same "last write wins" convention `platform.js`'s `resolveApps()` already uses.
      const globalViewNamesByPrefix = new Map();
      // `globalTemplateNames`/`globalStyleNames` - the SAME "read straight off each app's own
      // qu-platform-apps entry" pattern as `globalViewNames`, one Kind over - `kinds.js`'s own
      // `platformAppsKind` doc comment on the real, observed failure this closes: a NEW global
      // app's own template/style (any prefix other than the built-in admin console's hardcoded
      // "main") was silently REJECTED (no 'relay-admins'-ACL classification exists for a name the
      // relay was never told about) until this was added.
      const globalTemplateNamesByPrefix = new Map();
      const globalStyleNamesByPrefix = new Map();
      for (const app of apps) {
        if (app?.realm !== 'global') continue;
        if (app.globalViewNames?.length) globalViewNamesByPrefix.set(app.prefix, app.globalViewNames);
        if (app.globalTemplateNames?.length) globalTemplateNamesByPrefix.set(app.prefix, app.globalTemplateNames);
        if (app.globalStyleNames?.length) globalStyleNamesByPrefix.set(app.prefix, app.globalStyleNames);
      }
      const globalApps = [...watchedPrefixes].map((prefix) => ({
        prefix,
        // KNOWN_GLOBAL_TEMPLATE_NAMES ∪ whatever this prefix's own registration declared - the
        // hardcoded admin-console default stays valid even for a prefix that ALSO lists its own
        // names (not that "admin" ever would).
        templateNames: [...new Set([...(KNOWN_GLOBAL_TEMPLATE_NAMES[prefix] ?? []), ...(globalTemplateNamesByPrefix.get(prefix) ?? [])])],
        styleNames: globalStyleNamesByPrefix.get(prefix) ?? [],
        pageRoutes: (globalPageRoutesByPrefix.get(prefix) ?? []).filter(Boolean).map((r) => r.route),
        viewNames: globalViewNamesByPrefix.get(prefix) ?? [],
      }));
      // See `dev.js`'s `registerApp()` own doc comment on `sharedLists` - the SAME "no relay
      // restart needed" fix `appAdminPubs`/`globalApps` above already give `'named'`/`'relay-admins'`
      // content, extended to `sharedListKind` (`'members'`-ACL, anchored on a hash of its own NAME -
      // relay-resolver.js's own doc comment on why that specifically can't self-certify dynamically
      // the way an owner-derived id can). Collected across EVERY app regardless of `realm` - a
      // `realm: 'main'` Guestbook/Forum install needs this exactly as much as a hypothetical global
      // one would.
      const sharedListNames = [...new Set(apps.flatMap((a) => a.sharedLists ?? []))];
      current = await createAppResolveKindSchema({ appAdminPubs, collectionRegistryKinds, globalApps, sharedListNames });
    }
    field.observe(rebuild);
    await rebuild(); // initial snapshot - covers a relay restart with an already-populated registry, not just apps registered AFTER this call.
  }

  return { resolveKindSchema, start };
}
