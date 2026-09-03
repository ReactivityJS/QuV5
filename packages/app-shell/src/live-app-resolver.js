/**
 * LIVE APP-ADMIN RESOLVER — the actual fix for the "new app-admin needs a
 * relay restart" gap `@qu/app-core`'s `relay-resolver.js` own doc comment
 * used to document as a deliberate, accepted limitation. Wraps
 * `createAppResolveKindSchema()` (a small, pure, synchronous-result
 * builder) in a reactive shell: this relay connects an INTERNAL, read-only
 * `Space` to its OWN main hub (an ordinary `InProcessTransport`, the same
 * primitive `@qu/space-transport`'s own tests use to talk to a relay
 * without a real socket) and watches `qu-platform-apps` - now a
 * `'relay-admins'`-ACL registry any configured relay-admin may write, see
 * `@qu/app-core`'s kinds.js own doc comment - rebuilding the resolver's
 * `appAdminPubs` set every time that registry changes. A relay-admin
 * registering a brand-new app-admin (`registerApp()`) is therefore enough
 * on its own - no separate STATIC `QU_APP_ADMIN_PUBS` list, no restart.
 *
 * WHY THIS LIVES HERE, NOT IN `@qu/app-core`: `@qu/app-core`'s own `src/`
 * deliberately has no real dependency on `@qu/space-transport` (only a
 * devDependency, used by its tests) - it stays transport-agnostic, DOM-
 * free, "Zero DOM dependency" (see runtime.js's own doc comment). This
 * file needs `InProcessTransport` to talk to the relay's own hub directly,
 * which only makes sense at the layer that ALREADY composes
 * `@qu/space-transport` with the App layer - `@qu/app-shell`, exactly
 * where `relay-server.js` itself lives.
 *
 * ORDERING: `resolveKindSchema` (the function this returns) MUST be handed
 * to `createRelayForwarder({hub, resolveKindSchema, ...})` BEFORE
 * `start()` is called - `start()` connects an internal `Space` to that
 * SAME hub, which only works once the hub is actually listening (`hub.
 * registerRelay()`, called inside `createRelayForwarder()`). The returned
 * `resolveKindSchema` is a STABLE function reference from the start - it
 * delegates to a swappable inner closure (`current`), which is what lets
 * its behavior update over time without ever handing the relay a new
 * function object (relay.js only ever reads the one passed at
 * construction).
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
import { InProcessTransport } from '@qu/space-transport';
import { createAppResolveKindSchema, platformAppsKind, PLATFORM_REGISTRY_ANCHOR } from '@qu/app-core';

/**
 * @param {{collectionRegistryKinds?: object[]}} [params] - forwarded to every `createAppResolveKindSchema()` rebuild, see that function's own doc comment.
 * @returns {{resolveKindSchema: (nodeId: string) => object, start: (params: {hub: object, relayAdmins?: Array<Uint8Array>}) => Promise<void>}}
 */
export function createLiveAppResolveKindSchema({ collectionRegistryKinds = [] } = {}) {
  let current = () => null; // replaced synchronously at the top of start(), before its first await - see this file's own "BOOTSTRAP WINDOW" doc comment.
  const resolveKindSchema = (nodeId) => current(nodeId);

  /** @param {{hub: object, relayAdmins?: Array<Uint8Array>}} params */
  async function start({ hub, relayAdmins = [] }) {
    current = await createAppResolveKindSchema({ appAdminPubs: [], collectionRegistryKinds });

    const kp = await QuCrypto.generateKeypair(); // throwaway - this Space only ever reads (useNode()), never writes, so no real identity is needed.
    const identity = { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
    const transport = new InProcessTransport(hub, `live-app-resolver:${QuCrypto.toBase64Url(kp.publicKey)}`);
    await transport.connect();
    // members: [] - 'relay-admins'-ACL subscribe/read never needs Space membership (relay.js's own
    // handleSubscribe() bypass, see kind-schema.js's doc comment on the mode) - and this reader
    // never writes, so it never needs to be authorized as a relay-admin either.
    const space = new Space({ identity, members: [], relayAdmins, transport });

    const platformId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
    const { node } = await space.useNode(platformId, platformAppsKind); // never released - lives for this relay process's own lifetime.
    const field = node.field('apps');

    async function rebuild() {
      const apps = await field.toArray();
      const appAdminPubs = apps
        .filter(Boolean)
        .map((a) => a.appAdminPub)
        .filter(Boolean)
        .map((b64) => QuCrypto.fromBase64(b64));
      current = await createAppResolveKindSchema({ appAdminPubs, collectionRegistryKinds });
    }
    field.observe(rebuild);
    await rebuild(); // initial snapshot - covers a relay restart with an already-populated registry, not just apps registered AFTER this call.
  }

  return { resolveKindSchema, start };
}
