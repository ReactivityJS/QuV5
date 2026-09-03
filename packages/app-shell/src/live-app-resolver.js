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
 * @param {{collectionRegistryKinds?: object[]}} [params] - forwarded to every `createAppResolveKindSchema()` rebuild, see that function's own doc comment.
 * @returns {{resolveKindSchema: (nodeId: string) => object, start: (params: {url: string, relayAdmins?: Array<Uint8Array>}) => Promise<void>}}
 */
export function createLiveAppResolveKindSchema({ collectionRegistryKinds = [] } = {}) {
  let current = () => null; // replaced synchronously at the top of start(), before its first await - see this file's own "BOOTSTRAP WINDOW" doc comment.
  const resolveKindSchema = (nodeId) => current(nodeId);

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
      const globalApps = [...watchedPrefixes].map((prefix) => ({
        prefix,
        pageRoutes: (globalPageRoutesByPrefix.get(prefix) ?? []).filter(Boolean).map((r) => r.route),
      }));
      current = await createAppResolveKindSchema({ appAdminPubs, collectionRegistryKinds, globalApps });
    }
    field.observe(rebuild);
    await rebuild(); // initial snapshot - covers a relay restart with an already-populated registry, not just apps registered AFTER this call.
  }

  return { resolveKindSchema, start };
}
