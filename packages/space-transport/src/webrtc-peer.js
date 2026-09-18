/**
 * WEBRTC PEER — `docs/webrtc.md`: an OPTIONAL, app-initiated P2P channel to
 * one specific remote member, built on top of `webrtc-signaling.js`'s
 * `wrapWithSignaling()`. Deliberately NOT a `Space` transport (see that
 * file's own doc comment on why - `Space`'s own Yjs sync stays
 * Relay-mediated) - this is a second, independent thing an app opts into,
 * for cases that genuinely need a real-time P2P channel: a game's own
 * low-latency data channel, a voice/video call.
 *
 * THIS FILE ONLY LOADS IN A BROWSER (or any runtime with a global
 * `RTCPeerConnection`) - deliberately excluded from this package's own
 * `index.js` (which stays plain-Node-importable), the same split
 * `ws-client-transport.js`/`indexeddb-store.js` already establish for their
 * own browser-only globals. `RTCPeerConnectionImpl` is still injectable
 * (default `globalThis.RTCPeerConnection`) for the exact same reason
 * `WsClientTransport` takes `WebSocketImpl` - real logic tests inject a
 * fake/double, no real browser needed for THOSE; only the end-to-end
 * Playwright smoke test needs a real one.
 *
 * SIGNALING: entirely through the `signaling` param (a `wrapWithSignaling()`-
 * wrapped transport's `sendSignal()`/`onSignal()`) - this file never touches
 * a relay/Space directly, never needs to know about envelopes/ACL/Kinds at
 * all. `signal` payloads are plain, already-JSON-safe objects (an SDP
 * `RTCSessionDescriptionInit` or an ICE candidate's own `.toJSON()`) - no
 * `Uint8Array` ever appears in one, so no wire-codec base64 dance is needed
 * here (unlike an envelope).
 *
 * GLARE (both sides starting an offer at the same moment) is resolved via
 * the standard "Perfect Negotiation" pattern (WebRTC spec / MDN): each side
 * deterministically computes the SAME "polite"/"impolite" role by comparing
 * both member's own base64 pubkeys as plain strings (no coordination
 * needed - both sides compute this independently and always agree) - the
 * polite side backs off and accepts an incoming offer instead of its own
 * when both collide, the impolite side's own offer wins. This needs no
 * extra protocol of its own - "who is polite" is a pure function of two
 * already-known pubkeys.
 *
 * RENEGOTIATION (`addTrack()`/`removeTrack()`) is AUTOMATIC - both trigger
 * the browser's own `negotiationneeded` event, which this file's internal
 * `onnegotiationneeded` handler answers with a fresh offer/answer round
 * over `signaling`, with ZERO extra calls from the app. `addTrack()`/
 * `removeTrack()` themselves return a Promise that resolves once that
 * triggered round has actually settled - so an app that awaits it knows the
 * new track is actually flowing, not just locally added.
 *
 * `setEnabled(kind, bool)` is the CHEAP, no-renegotiation toggle (`docs/
 * app-developer-guide.md`'s own "Laufzeit-Steuerung, wie ein Schalter"
 * example): flips `track.enabled` on every current sender of that media
 * `kind` - the remote side sees the stream freeze/mute instantly, the
 * connection/m-line itself is untouched. Use `addTrack()`/`removeTrack()`
 * instead when a media kind should be removed from the call ENTIRELY, not
 * just paused.
 *
 * NO DEFAULT `iceServers` - see `docs/app-developer-guide.md`'s own
 * datenschutz-Hinweis: real P2P WebRTC exchanges ICE candidates that tend
 * to reveal both peers' real IP addresses, even to a configured STUN/TURN
 * server - a deliberate trade-off an app opts into explicitly, never a
 * silent default.
 */
import { QuCrypto } from '@qu/core';

function toB64(pub) {
  return typeof pub === 'string' ? pub : QuCrypto.toBase64(pub);
}

/**
 * A real `RTCSessionDescription`'s `type`/`sdp` are accessors on its OWN
 * PROTOTYPE, not own-enumerable properties on the instance - fine for
 * `JSON.stringify()` (which calls its spec-mandated `toJSON()`), but NOT
 * for `@qu/space-core`'s `encodeForWire()`/`wire-codec.js`, which walks
 * `Object.entries()` directly (needed elsewhere to tag `Uint8Array` fields
 * an envelope carries) and therefore sees an object with NO own keys at
 * all - silently serializing a real offer/answer as `{}`, an empty SDP a
 * remote `setRemoteDescription()` then rejects outright. Sending a
 * genuinely plain `{type, sdp}` object instead sidesteps the whole
 * distinction, regardless of which serialization path a given
 * `signaling.sendSignal()` implementation happens to take.
 */
function toPlainDescription(desc) {
  return { type: desc.type, sdp: desc.sdp };
}

/** Wraps a raw `RTCDataChannel` in the small, stable API this module exposes (`createDataChannel()`/`onDataChannel()` both return one) - never leaks the raw DOM object, so a fake `RTCPeerConnectionImpl` in tests never has to implement the FULL `RTCDataChannel` surface, only what this wrapper actually touches. */
function wrapDataChannel(channel) {
  const messageListeners = new Set();
  channel.onmessage = (event) => {
    for (const cb of messageListeners) cb(event.data);
  };
  return {
    label: channel.label,
    get readyState() {
      return channel.readyState;
    },
    send: (data) => channel.send(data),
    /** @param {(data: *) => void} cb @returns {() => void} unsubscribe */
    onMessage: (cb) => {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    close: () => channel.close(),
  };
}

/**
 * @param {{
 *   signaling: object,
 *   identity: {signingPub: Uint8Array},
 *   remotePub: Uint8Array|string,
 *   iceServers: Array<object>,
 *   RTCPeerConnectionImpl?: typeof RTCPeerConnection,
 * }} params
 *   `signaling` - a `wrapWithSignaling()`-wrapped transport (`sendSignal`/`onSignal`) - typically
 *     the SAME wrapped transport already handed to `bootstrapSpace()`/`new Space(...)` for this
 *     peer, so signaling piggybacks on the connection that's already open.
 *   `identity` - THIS peer's own identity (only `signingPub` is read) - used solely for the
 *     deterministic polite/impolite comparison above, never sent anywhere.
 *   `remotePub` - the OTHER member's signing pubkey (raw `Uint8Array` or already-base64 `string` -
 *     either works, matching `onSignal()`'s own `from` shape).
 *   `iceServers` - REQUIRED, no default - see this file's own top doc comment.
 * @returns {Promise<object>} the peer instance - `{createDataChannel, onDataChannel, addTrack,
 *   removeTrack, setEnabled, onTrack, onStateChange, close}`. Resolves once the underlying
 *   `RTCPeerConnection` exists and signaling is wired - NOT once actually connected (see
 *   `onStateChange()` for that).
 */
export async function createWebRTCPeer({ signaling, identity, remotePub, iceServers, RTCPeerConnectionImpl = globalThis.RTCPeerConnection } = {}) {
  if (!signaling) throw new Error('createWebRTCPeer: "signaling" is required - see wrapWithSignaling()');
  if (!identity) throw new Error('createWebRTCPeer: "identity" is required');
  if (!remotePub) throw new Error('createWebRTCPeer: "remotePub" is required');
  if (!iceServers) throw new Error('createWebRTCPeer: "iceServers" is required (no default - see this file\'s own top doc comment on why)');
  if (!RTCPeerConnectionImpl) throw new Error('createWebRTCPeer: no global RTCPeerConnection on this runtime - pass { RTCPeerConnectionImpl }');

  const ownPubB64 = toB64(identity.signingPub);
  const remotePubB64 = toB64(remotePub);
  const polite = ownPubB64 < remotePubB64; // see this file's own top doc comment - a pure, coordination-free comparison both sides agree on independently.

  const pc = new RTCPeerConnectionImpl({ iceServers });

  let makingOffer = false;
  let ignoreOffer = false;
  let negotiationPromise = Promise.resolve();

  async function negotiate() {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      signaling.sendSignal(remotePubB64, { description: toPlainDescription(pc.localDescription) });
    } catch (err) {
      console.error('createWebRTCPeer: negotiation failed', err);
    } finally {
      makingOffer = false;
    }
  }
  pc.onnegotiationneeded = () => {
    negotiationPromise = negotiate();
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) signaling.sendSignal(remotePubB64, { candidate: candidate.toJSON() });
  };

  const stateListeners = new Set();
  pc.onconnectionstatechange = () => {
    for (const cb of stateListeners) cb(pc.connectionState);
  };

  const trackListeners = new Set();
  pc.ontrack = (event) => {
    const stream = event.streams[0];
    for (const cb of trackListeners) cb(stream);
  };

  const dataChannelListeners = new Set();
  pc.ondatachannel = (event) => {
    const wrapped = wrapDataChannel(event.channel);
    for (const cb of dataChannelListeners) cb(wrapped);
  };

  const unsubscribeSignal = signaling.onSignal(async ({ from, signal }) => {
    if (from !== remotePubB64) return; // not this peer's own remote - another concurrent createWebRTCPeer() call owns it.
    const { description, candidate } = signal;
    try {
      if (description) {
        const offerCollision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          signaling.sendSignal(remotePubB64, { description: toPlainDescription(pc.localDescription) });
        }
      } else if (candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          if (!ignoreOffer) throw err; // a candidate for an offer we deliberately ignored is expected to fail - anything else is real.
        }
      }
    } catch (err) {
      console.error('createWebRTCPeer: failed to handle incoming signal', err);
    }
  });

  return {
    /** @param {string} label @param {object} [options] RTCDataChannelInit. @returns {{label, readyState, send, onMessage, close}} */
    createDataChannel(label, options) {
      return wrapDataChannel(pc.createDataChannel(label, options));
    },
    /** For a channel the REMOTE side created (`pc.createDataChannel()` only ever creates ones THIS side initiated). @param {(channel: object) => void} cb @returns {() => void} unsubscribe */
    onDataChannel(cb) {
      dataChannelListeners.add(cb);
      return () => dataChannelListeners.delete(cb);
    },
    /** Adds a track, triggers automatic renegotiation - resolves once that round has settled. @param {MediaStreamTrack} track @param {MediaStream} stream @returns {Promise<void>} */
    async addTrack(track, stream) {
      pc.addTrack(track, stream);
      await Promise.resolve(); // let the browser's own queued 'negotiationneeded' task (re)assign negotiationPromise before we await it.
      await negotiationPromise;
    },
    /** Removes a track, triggers automatic renegotiation - resolves once that round has settled. @param {MediaStreamTrack} track @returns {Promise<void>} */
    async removeTrack(track) {
      const sender = pc.getSenders().find((s) => s.track === track);
      if (sender) pc.removeTrack(sender);
      await Promise.resolve();
      await negotiationPromise;
    },
    /** Cheap runtime mute/unmute - no renegotiation, see this file's own top doc comment. @param {'audio'|'video'} kind @param {boolean} enabled */
    setEnabled(kind, enabled) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === kind) sender.track.enabled = enabled;
      }
    },
    /** @param {(stream: MediaStream) => void} cb @returns {() => void} unsubscribe */
    onTrack(cb) {
      trackListeners.add(cb);
      return () => trackListeners.delete(cb);
    },
    /** @param {(state: 'new'|'connecting'|'connected'|'disconnected'|'failed'|'closed') => void} cb @returns {() => void} unsubscribe */
    onStateChange(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    close() {
      unsubscribeSignal();
      pc.close();
    },
  };
}
