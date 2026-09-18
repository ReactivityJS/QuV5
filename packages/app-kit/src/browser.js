/**
 * `createQuApp()` — the BROWSER entry (`@qu/app-kit`'s main `.` export):
 * one call that wires up everything `docs/app-developer-guide.md`'s §1.1
 * otherwise walks through by hand - identity persistence, the relay
 * connection, an optional `storage`/`sealStrategy`/WebRTC, and (if `mount`
 * is given) making the result usable by Qu-Components in plain HTML with
 * zero extra JS. See `shared.js`'s own top doc comment for the overall
 * design ("batteries included, nothing reimplemented, escape hatches
 * everywhere").
 *
 * REGISTERS `<qu-view>`/`<qu-bind>`/`<qu-list>` UNCONDITIONALLY (a plain
 * side-effect import of `@qu/space-components/elements`, the exact same
 * thing `@qu/app-shell`'s `shell.js` already does) - "möglichst viel
 * Qu-Components im HTML" is this package's whole second reason to exist
 * (`docs/app-developer-guide.md` §2), so an app using `createQuApp()`
 * never has to remember this import itself. Harmless even for an app that
 * writes zero Qu-Components markup - `customElements.define()` with
 * nothing ever instantiating the tags does nothing observable.
 *
 * @param {{
 *   registry?: import('@qu/bootstrap').AdapterRegistry,
 *   relay?: string|{hub: object, peerId?: string},
 *   transport?: object,
 *   identity?: 'local-storage'|'session-storage'|'memory'|object,
 *   identityKey?: string,
 *   storage?: 'indexeddb'|'memory'|object,
 *   members?: Array<{pub: Uint8Array, xPub: Uint8Array}>,
 *   relayAdmins?: Array<Uint8Array>,
 *   sealStrategy?: 'none'|'pad-to-members'|object,
 *   kinds?: {[name: string]: object},
 *   mount?: string|Element,
 *   webrtc?: {iceServers: Array<object>},
 *   ensureUserProfile?: boolean,
 * }} options
 *   `relay` - the common case: a WebSocket URL (`wss://...`), or `{hub}` for in-process/memory mode
 *     (tests/demos - see `@qu/bootstrap/memory`'s `createSharedInProcessHub()`). `transport` is the
 *     advanced escape hatch (an adapter ref or an already-built instance) - see `bootstrapSpace()`'s
 *     own doc comment.
 *   `identity` - default `'local-storage'` (ONE persistent identity per browser/profile, the "primary
 *     local identity" `docs/bootstrap-api.md` describes) - or an already-built `{signingKey, ...}`
 *     object.
 *   `storage`/`sealStrategy` - omit for `bootstrapSpace()`'s own defaults (memory-only storage, no
 *     recipient padding).
 *   `kinds` - `{name: kindSchema}` - forwarded onto `mount.quKinds` so `kind="name"` Qu-Component
 *     attributes resolve (`docs/app-developer-guide.md` §2's own `resolve.js` reference).
 *   `mount` - a CSS selector or `Element` - gets `.quSpace`/`.quKinds` set on it, the one manual step
 *     `docs/app-developer-guide.md`'s full example otherwise needs. Omit for a headless/non-DOM use
 *     of this same call (e.g. a background WebRTC-only script).
 *   `webrtc` - ONLY when given: wraps the resolved transport (`wrapWithSignaling()`) and returns a
 *     `webrtc.connect(remotePub)` convenience (`createWebRTCPeer()` under the hood, see
 *     `docs/webrtc.md`). Omit entirely for an app that never uses WebRTC - `app.webrtc` then doesn't
 *     exist at all.
 *   `ensureUserProfile` - default `true` (matches `@qu/app-shell`'s own real boot path) - set `false`
 *     to opt out.
 * @returns {Promise<{space: import('@qu/space-core').Space, identity: object, registry: import('@qu/bootstrap').AdapterRegistry, webrtc?: {connect: (remotePub: Uint8Array|string) => Promise<object>}}>}
 */
import { registerBrowserAdapters } from '@qu/bootstrap/browser';
import { createWebRTCPeer } from '@qu/space-transport/webrtc-peer';
import { createQuAppCore } from './shared.js';
import '@qu/space-components/elements';

export async function createQuApp(options = {}) {
  return createQuAppCore(
    {
      envRegisterAdapters: registerBrowserAdapters,
      supportsWebRTC: true,
      supportsMount: true,
      createWebRTCPeer,
      defaults: { identity: 'local-storage', ensureUserProfile: true },
    },
    options
  );
}
