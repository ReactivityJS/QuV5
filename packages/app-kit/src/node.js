/**
 * `createQuApp()` — the NODE entry (`@qu/app-kit/node`): same shared core
 * as `browser.js` (`shared.js`'s own doc comment), registering
 * `registerNodeAdapters()` (`'file'`/`'durable'` storage, a `ws`-backed
 * `'ws-client'` transport) instead of the browser pack.
 *
 * `mount`/`webrtc` are NOT supported here - both need real browser globals
 * (`document`/`RTCPeerConnection`) this entry deliberately never imports
 * (the same reasoning `@qu/bootstrap/node`'s own doc comment gives for
 * never pulling in browser-only code) - passing either throws loudly
 * rather than silently doing nothing. No `@qu/space-components` import
 * either - there is no DOM here for a Custom Element to register against.
 *
 * @param {{
 *   registry?: import('@qu/bootstrap').AdapterRegistry,
 *   relay?: string|{hub: object, peerId?: string},
 *   transport?: object,
 *   identity?: 'memory'|object,
 *   identityKey?: string,
 *   storage?: 'file'|'durable'|'memory'|object,
 *   members?: Array<{pub: Uint8Array, xPub: Uint8Array}>,
 *   relayAdmins?: Array<Uint8Array>,
 *   sealStrategy?: 'none'|'pad-to-members'|object,
 *   kinds?: {[name: string]: object},
 *   ensureUserProfile?: boolean,
 * }} options
 *   `identity` - default `'memory'` (a Node script/CLI has no obvious durable identity home the way
 *     a browser's `localStorage` is one - `registerIdentityStoreAdapters()` never registers a
 *     `'file'` identity adapter itself; a caller that wants one registers its own against `registry`
 *     first, see `docs/bootstrap-api.md`'s own "a fourth flavor" note). `storage: 'file'` needs
 *     `{dataDir}` - see `@qu/bootstrap/node`'s own doc comment.
 *   `ensureUserProfile` - default `false` here (unlike the browser entry) - a headless script rarely
 *     wants a `qu-user` profile created on its behalf without asking.
 * @returns {Promise<{space: import('@qu/space-core').Space, identity: object, registry: import('@qu/bootstrap').AdapterRegistry}>}
 */
import { registerNodeAdapters } from '@qu/bootstrap/node';
import { createQuAppCore } from './shared.js';

export async function createQuApp(options = {}) {
  return createQuAppCore(
    {
      envRegisterAdapters: registerNodeAdapters,
      supportsWebRTC: false,
      supportsMount: false,
      createWebRTCPeer: null,
      defaults: { identity: 'memory', ensureUserProfile: false },
    },
    options
  );
}
