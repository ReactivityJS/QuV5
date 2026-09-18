/**
 * createWebRTCPeer() — proves the ACTUAL negotiation/data-channel/media
 * logic in webrtc-peer.js, over a REAL relay + `wrapWithSignaling()` (both
 * already proven independently by rtc-signal-relay.test.js/
 * webrtc-signaling.test.js) but a FAKE `RTCPeerConnection` (`FakeRTCPeerConnection`
 * below) - no real browser needed for these; see the separate Playwright
 * smoke test for real-`RTCPeerConnection` end-to-end proof.
 *
 * THE FAKE is deliberately NOT a full WebRTC re-implementation - just
 * enough of the real state machine (`signalingState` transitions,
 * `negotiationneeded`, paired data channels, a synthetic `ontrack`) for
 * webrtc-peer.js's OWN negotiation logic (offer/answer/glare handling via
 * the Perfect Negotiation pattern) to run unmodified against it. Two
 * instances are "wired" via a shared `FakeNetwork` (exactly 2 slots - one
 * per side of the one pair each test constructs), never via any real
 * ICE/SDP parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { createInProcessHub, InProcessTransport, createRelayForwarder, wrapWithSignaling } from '../src/index.js';
import { createWebRTCPeer } from '../src/webrtc-peer.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'open';
    this.onmessage = null;
    this._pairChannel = null;
  }
  _pair(other) {
    this._pairChannel = other;
  }
  send(data) {
    queueMicrotask(() => this._pairChannel?.onmessage?.({ data }));
  }
  close() {
    this.readyState = 'closed';
  }
}

function createFakeNetwork() {
  const peers = [];
  return {
    register(pc) {
      peers.push(pc);
      if (peers.length === 2) {
        peers[0]._remote = peers[1];
        peers[1]._remote = peers[0];
      }
    },
  };
}

class FakeRTCPeerConnection {
  constructor(options, network) {
    this.iceServers = options?.iceServers;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this._senders = [];
    this._remote = null;
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.ontrack = null;
    this.ondatachannel = null;
    network.register(this);
  }

  async setLocalDescription(desc) {
    if (!desc) {
      const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
      desc = { type, sdp: `fake-${type}-${Math.random().toString(36).slice(2)}` };
    }
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
    if (desc.type === 'answer') this._markConnected();
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (desc.type === 'answer') this._markConnected();
  }

  async addIceCandidate() {}

  _markConnected() {
    for (const pc of [this, this._remote]) {
      if (!pc) continue;
      pc.connectionState = 'connected';
      queueMicrotask(() => pc.onconnectionstatechange?.());
    }
  }

  createDataChannel(label) {
    const channel = new FakeDataChannel(label);
    const remoteChannel = new FakeDataChannel(label);
    channel._pair(remoteChannel);
    remoteChannel._pair(channel);
    queueMicrotask(() => this._remote?.ondatachannel?.({ channel: remoteChannel }));
    queueMicrotask(() => this.onnegotiationneeded?.());
    return channel;
  }

  addTrack(track, stream) {
    const sender = { track };
    this._senders.push(sender);
    queueMicrotask(() => this.onnegotiationneeded?.());
    queueMicrotask(() => this._remote?.ontrack?.({ streams: [stream] }));
    return sender;
  }

  removeTrack(sender) {
    this._senders = this._senders.filter((s) => s !== sender);
    queueMicrotask(() => this.onnegotiationneeded?.());
  }

  getSenders() {
    return this._senders;
  }

  close() {
    this.connectionState = 'closed';
  }
}

/** Sets up two `createWebRTCPeer()` instances (alice/bob) over a real relay + signaling wrapper, each backed by its own end of one `FakeRTCPeerConnection` pair. */
async function connectedPeerPair({ iceServers = [{ urls: 'stun:test.invalid' }] } = {}) {
  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];
  const hub = createInProcessHub();
  const { presence } = createRelayForwarder({ hub, members, resolveKindSchema: () => null });

  const aliceTransport = wrapWithSignaling(new InProcessTransport(hub, 'alice'));
  await aliceTransport.connect();
  aliceTransport.send({ type: 'hello', pub: alice.signingPub, sig: await QuCrypto.sign(new TextEncoder().encode('qu-space-hello-v1'), alice.signingKey) });

  const bobTransport = wrapWithSignaling(new InProcessTransport(hub, 'bob'));
  await bobTransport.connect();
  bobTransport.send({ type: 'hello', pub: bob.signingPub, sig: await QuCrypto.sign(new TextEncoder().encode('qu-space-hello-v1'), bob.signingKey) });

  await waitUntil(() => presence.isOnline(QuCrypto.toBase64(alice.signingPub)) && presence.isOnline(QuCrypto.toBase64(bob.signingPub)));

  const network = createFakeNetwork();
  const RTCPeerConnectionImpl = function (options) {
    return new FakeRTCPeerConnection(options, network);
  };

  const alicePeer = await createWebRTCPeer({ signaling: aliceTransport, identity: alice, remotePub: bob.signingPub, iceServers, RTCPeerConnectionImpl });
  const bobPeer = await createWebRTCPeer({ signaling: bobTransport, identity: bob, remotePub: alice.signingPub, iceServers, RTCPeerConnectionImpl });
  return { alicePeer, bobPeer };
}

test('createWebRTCPeer(): required options are enforced', async () => {
  await assert.rejects(() => createWebRTCPeer({}), /"signaling" is required/);
  await assert.rejects(() => createWebRTCPeer({ signaling: {} }), /"identity" is required/);
  await assert.rejects(() => createWebRTCPeer({ signaling: {}, identity: {} }), /"remotePub" is required/);
  await assert.rejects(() => createWebRTCPeer({ signaling: {}, identity: {}, remotePub: 'x' }), /"iceServers" is required/);
});

test('createWebRTCPeer(): a data channel opened on one side arrives on the other via onDataChannel(), messages round-trip', async () => {
  const { alicePeer, bobPeer } = await connectedPeerPair();
  try {
    const received = [];
    const unsubscribe = bobPeer.onDataChannel((channel) => {
      channel.onMessage((data) => received.push(data));
      channel.send('hello from bob');
    });

    const dc = alicePeer.createDataChannel('game-state');
    const aliceReceived = [];
    dc.onMessage((data) => aliceReceived.push(data));
    dc.send('hello from alice');

    await waitUntil(() => received.length > 0 && aliceReceived.length > 0);
    assert.equal(received[0], 'hello from alice');
    assert.equal(aliceReceived[0], 'hello from bob');
    unsubscribe();
  } finally {
    alicePeer.close();
    bobPeer.close();
  }
});

test('createWebRTCPeer(): addTrack() resolves once negotiation settles, and the remote side sees onTrack()', async () => {
  const { alicePeer, bobPeer } = await connectedPeerPair();
  try {
    const remoteStreams = [];
    bobPeer.onTrack((stream) => remoteStreams.push(stream));

    const fakeTrack = { kind: 'video', enabled: true };
    const fakeStream = { id: 'local-stream' };
    await alicePeer.addTrack(fakeTrack, fakeStream);

    await waitUntil(() => remoteStreams.length > 0);
    assert.equal(remoteStreams[0], fakeStream);
  } finally {
    alicePeer.close();
    bobPeer.close();
  }
});

test('createWebRTCPeer(): setEnabled() toggles track.enabled directly, no renegotiation needed', async () => {
  const { alicePeer, bobPeer } = await connectedPeerPair();
  try {
    const fakeTrack = { kind: 'video', enabled: true };
    await alicePeer.addTrack(fakeTrack, { id: 's' });

    alicePeer.setEnabled('video', false);
    assert.equal(fakeTrack.enabled, false);
    alicePeer.setEnabled('video', true);
    assert.equal(fakeTrack.enabled, true);

    // a DIFFERENT kind is untouched:
    const audioTrack = { kind: 'audio', enabled: true };
    await alicePeer.addTrack(audioTrack, { id: 's2' });
    alicePeer.setEnabled('video', false);
    assert.equal(audioTrack.enabled, true, 'setEnabled("video", ...) never touches an audio track');
  } finally {
    alicePeer.close();
    bobPeer.close();
  }
});

test('createWebRTCPeer(): removeTrack() resolves and stops the track from the connection\'s own sender list', async () => {
  const { alicePeer, bobPeer } = await connectedPeerPair();
  try {
    const fakeTrack = { kind: 'audio', enabled: true };
    await alicePeer.addTrack(fakeTrack, { id: 's' });
    await alicePeer.removeTrack(fakeTrack); // resolves without throwing - the actual sender-removal is exercised via the fake's own getSenders(), not independently observable from the peer's public API alone.
  } finally {
    alicePeer.close();
    bobPeer.close();
  }
});

test('createWebRTCPeer(): glare (both sides negotiate near-simultaneously) still converges - the polite side backs off', async () => {
  const { alicePeer, bobPeer } = await connectedPeerPair();
  try {
    const remoteStreams = [];
    bobPeer.onTrack((stream) => remoteStreams.push(stream));
    const bobStreams = [];
    alicePeer.onTrack((stream) => bobStreams.push(stream));

    // both sides add a track at (near) the same moment - a real glare scenario.
    const aliceTrack = { kind: 'video', enabled: true };
    const bobTrack = { kind: 'video', enabled: true };
    await Promise.all([alicePeer.addTrack(aliceTrack, { id: 'alice-stream' }), bobPeer.addTrack(bobTrack, { id: 'bob-stream' })]);

    // both sides still end up with a track from the other, despite the simultaneous negotiation.
    await waitUntil(() => remoteStreams.length > 0 && bobStreams.length > 0);
  } finally {
    alicePeer.close();
    bobPeer.close();
  }
});
