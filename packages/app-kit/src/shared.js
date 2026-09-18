/**
 * SHARED CORE — `createQuApp()`'s actual logic, environment-AGNOSTIC (no
 * browser/Node globals touched here) so `browser.js`/`node.js` can each
 * stay a thin, environment-specific shell around the SAME implementation -
 * the same "one core, thin environment packs" split `@qu/bootstrap`
 * already establishes for `adapters/browser.js`/`adapters/node.js`.
 *
 * WHY THIS PACKAGE EXISTS: `docs/bootstrap-api.md`/`docs/app-developer-guide.md`
 * already give an app everything it needs (`AdapterRegistry` +
 * `bootstrapSpace()` + Kind-Schema + Qu-Components), but wiring a real app
 * still means several manual steps every caller repeats verbatim
 * (construct a registry, register identity + environment adapters, resolve
 * an identity, bootstrap, then hand `.quSpace`/`.quKinds` to some DOM
 * element by hand). `createQuApp(options)` collapses that into ONE call
 * with named options - a "batteries included" convenience layer, not a
 * new capability: everything it does is composition over `@qu/bootstrap`'s
 * own already-tested primitives, nothing reimplemented. The escape
 * hatches (`registry`/`transport`/an already-built `identity` object) mean
 * a caller is never actually BLOCKED by this layer - they can always drop
 * to `@qu/bootstrap` directly for anything this convenience shape doesn't
 * cover.
 *
 * "THE INSTANCE GROWS ONLY WITH WHAT WAS ASKED FOR": the returned object
 * always has `{space, identity, registry}` (the irreducible minimum any
 * app needs) - `webrtc` is present ONLY when `options.webrtc` was given.
 * An app that never asks for WebRTC gets an object with no `webrtc`
 * property at all, not `undefined` sitting there as a reminder of a
 * feature it never opted into.
 */
import { AdapterRegistry, bootstrapSpace, registerIdentityStoreAdapters } from '@qu/bootstrap';
import { registerMemoryAdapters } from '@qu/bootstrap/memory';
import { ensureUserProfile } from '@qu/space-core';
import { wrapWithSignaling } from '@qu/space-transport';

function isAdapterRef(value) {
  return value != null && typeof value === 'object' && typeof value.adapter === 'string';
}

/** Turns a bare adapter NAME (`'indexeddb'`) into `{adapter: 'indexeddb'}` - an object (already a ref, or an already-built instance) or `undefined` passes through untouched. Shared by `storage`/`sealStrategy`, which `bootstrapSpace()` itself resolves - unlike `transport` (see `resolveTransport()` below), nothing here needs the RESOLVED value before `bootstrapSpace()` sees it. */
function normalizeAdapterOption(value) {
  return typeof value === 'string' ? { adapter: value } : value;
}

/**
 * `transport` must be resolved (not just passed as a ref) BEFORE
 * `bootstrapSpace()` ever sees it, because the `webrtc` option (below)
 * needs to wrap the REAL transport instance in `wrapWithSignaling()` -
 * `bootstrapSpace()` has no hook for "resolve, then let me modify, then
 * use." `options.relay` is the common-case shorthand (a WebSocket URL
 * string, or `{hub}` for in-process/memory mode - the same `hub` a caller
 * already has from `createSharedInProcessHub()`); `options.transport` is
 * the advanced escape hatch (an adapter ref OR an already-built instance,
 * passed straight through exactly like `bootstrapSpace()`'s own `transport`
 * param already allows).
 */
async function resolveTransport(registry, { relay, transport }) {
  const ref =
    transport ??
    (typeof relay === 'string'
      ? { adapter: 'ws-client', url: relay }
      : relay?.hub
        ? { adapter: 'in-process', hub: relay.hub, peerId: relay.peerId }
        : null);
  if (!ref) throw new Error('createQuApp: "relay" (a WebSocket URL string, or { hub } for in-process/memory mode) or an advanced "transport" is required');
  if (!isAdapterRef(ref)) return ref; // already a built instance - the "transport" escape hatch.
  const { adapter, ...opts } = ref;
  return registry.create('transport', adapter, opts);
}

/**
 * @param {{envRegisterAdapters: (registry: AdapterRegistry) => void, supportsWebRTC: boolean, supportsMount: boolean, defaults: object}} env
 *   `envRegisterAdapters` - registers this environment's `storage`/`transport` pack (`registerBrowserAdapters`/`registerNodeAdapters`) on top of the identity + memory adapters this function ALWAYS registers itself.
 *   `supportsWebRTC` - `createWebRTCPeer()` needs a real `RTCPeerConnection` (browser-only) - the node entry passes `false` so `options.webrtc` fails loudly instead of silently doing nothing.
 *   `supportsMount` - `options.mount` needs a real DOM (`document.querySelector`) - the node entry passes `false` for the same reason.
 *   `defaults` - environment-specific option defaults (`identity`/`ensureUserProfile`) - see `browser.js`/`node.js`'s own doc comments on why they differ.
 * @param {object} options - see `browser.js`'s own doc comment for the full, documented option list (identical between environments except `mount`/`webrtc` support).
 * @returns {Promise<{space: object, identity: object, registry: AdapterRegistry, webrtc?: {connect: (remotePub: Uint8Array|string) => Promise<object>}}>}
 */
export async function createQuAppCore(env, options) {
  const opts = { ...env.defaults, ...options };
  const {
    registry = new AdapterRegistry(),
    identity: identityOption,
    identityKey,
    storage,
    members = [],
    relayAdmins = [],
    sealStrategy,
    kinds,
    mount,
    webrtc,
    ensureUserProfile: shouldEnsureUserProfile,
  } = opts;

  if (mount && !env.supportsMount) throw new Error('createQuApp: "mount" needs a real DOM - not supported in this environment (see @qu/app-kit/node\'s own doc comment)');
  if (webrtc && !env.supportsWebRTC) throw new Error('createQuApp: "webrtc" needs a real RTCPeerConnection - not supported in this environment (see @qu/app-kit/node\'s own doc comment)');

  registerIdentityStoreAdapters(registry, identityKey !== undefined ? { defaultKey: identityKey } : undefined);
  registerMemoryAdapters(registry); // safe in every environment (zero network/disk) - always available for tests/demos alongside whichever real pack env.envRegisterAdapters adds.
  env.envRegisterAdapters(registry);

  const identity = typeof identityOption === 'string' ? await registry.create('identity', identityOption) : identityOption;

  const rawTransport = await resolveTransport(registry, opts);
  const signaling = webrtc ? wrapWithSignaling(rawTransport) : null;

  const { space } = await bootstrapSpace({
    registry,
    identity,
    transport: signaling ?? rawTransport,
    storage: normalizeAdapterOption(storage),
    members,
    relayAdmins,
    sealStrategy: normalizeAdapterOption(sealStrategy),
  });

  if (shouldEnsureUserProfile) await ensureUserProfile(space);

  if (mount) {
    const el = typeof mount === 'string' ? document.querySelector(mount) : mount;
    if (!el) throw new Error(`createQuApp: "mount" ("${mount}") did not resolve to an element`);
    el.quSpace = space;
    if (kinds) el.quKinds = kinds;
  }

  const app = { space, identity, registry };
  if (webrtc) {
    app.webrtc = {
      /** @param {Uint8Array|string} remotePub @returns {Promise<object>} a `createWebRTCPeer()` instance - see docs/webrtc.md. */
      connect: (remotePub) => env.createWebRTCPeer({ signaling, identity, remotePub, iceServers: webrtc.iceServers }),
    };
  }
  return app;
}
