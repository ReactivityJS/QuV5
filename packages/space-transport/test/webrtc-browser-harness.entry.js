/**
 * Bundled into ONE script (via esbuild, see webrtc-browser-smoke.test.js)
 * and injected into a real Chromium page - exposes `window.QuWebRTCHarness`
 * so the Node-side test can drive a REAL `WsClientTransport` +
 * `wrapWithSignaling()` + `createWebRTCPeer()` (real `RTCPeerConnection`,
 * the browser's own global) from `page.evaluate()` calls. Not part of the
 * package's own public API - test-only glue.
 */
import { QuCrypto } from '@qu/core';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import { wrapWithSignaling } from '@qu/space-transport/webrtc-signaling';
import { createWebRTCPeer } from '@qu/space-transport/webrtc-peer';

function identityFromB64(obj) {
  return {
    signingKey: QuCrypto.fromBase64(obj.signingKey),
    signingPub: QuCrypto.fromBase64(obj.signingPub),
    xPrivateKey: QuCrypto.fromBase64(obj.xPrivateKey),
    xPublicKey: QuCrypto.fromBase64(obj.xPublicKey),
  };
}

window.QuWebRTCHarness = {
  /** Connects to the relay, sends `hello`, and opens a `createWebRTCPeer()` toward `remotePubB64`. */
  async connect({ relayUrl, identityB64, remotePubB64 }) {
    const identity = identityFromB64(identityB64);
    const inner = new WsClientTransport(relayUrl);
    const signaling = wrapWithSignaling(inner);
    await signaling.connect();
    const sig = await QuCrypto.sign(new TextEncoder().encode('qu-space-hello-v1'), identity.signingKey);
    signaling.send({ type: 'hello', pub: identity.signingPub, sig });
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the relay's own presence tracking catch up.

    const peer = await createWebRTCPeer({ signaling, identity, remotePub: QuCrypto.fromBase64(remotePubB64), iceServers: [] });
    window.__quPeer = peer;
    return true;
  },

  /** Creates a data channel, waits for it to actually open, sends `message`. */
  async createChannelAndSend(label, message) {
    const dc = window.__quPeer.createDataChannel(label);
    await new Promise((resolve) => {
      const check = () => (dc.readyState === 'open' ? resolve() : setTimeout(check, 20));
      check();
    });
    dc.send(message);
    return true;
  },

  /** Waits for a remote-initiated data channel to arrive AND deliver one message, returns it. */
  waitForChannelMessage(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('waitForChannelMessage: timed out')), timeoutMs);
      window.__quPeer.onDataChannel((channel) => {
        channel.onMessage((data) => {
          clearTimeout(timeout);
          resolve(data);
        });
      });
    });
  },

  close() {
    window.__quPeer?.close();
  },
};
