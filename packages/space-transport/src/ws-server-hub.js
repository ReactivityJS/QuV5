/**
 * WS SERVER HUB — the real-network counterpart to `createInProcessHub()`
 * (see in-process-transport.js), implementing exactly the three methods
 * `createRelayForwarder()` actually needs on the SERVER side
 * (`registerRelay`/`deliverTo`/`peerIds`) - which is why `relay.js` itself
 * needed ZERO changes to go from "tests inside one process" to "a real
 * relay process talking to real peer processes over the network." The hub
 * abstraction is exactly the seam that made that possible.
 *
 * Unlike the in-process hub, there is no `registerPeerInbox`/`sendToRelay`
 * here - those are PEER-side concerns (see ws-client-transport.js); a
 * server-side hub only ever needs to know "who's connected" and "deliver
 * this to that connection."
 */
import { randomUUID } from 'node:crypto';
import { encodeForWire, decodeFromWire } from '@qu/space-core';

/**
 * @param {import('ws').WebSocketServer} wss - Already listening.
 * @returns {{registerRelay: Function, deliverTo: Function, peerIds: () => string[]}}
 */
export function createWsServerHub(wss) {
  /** @type {Map<string, import('ws').WebSocket>} */
  const sockets = new Map();
  let relayHandler = null;

  wss.on('connection', (ws) => {
    const peerId = `peer-${randomUUID()}`;
    sockets.set(peerId, ws);

    ws.on('message', (raw) => {
      let data;
      try {
        data = decodeFromWire(JSON.parse(raw.toString()));
      } catch {
        return; // malformed frame - silently dropped, same posture WebSocketServerTransport takes (packages/relay).
      }
      relayHandler?.(peerId, data);
    });

    ws.on('close', () => sockets.delete(peerId));
  });

  return {
    registerRelay(handler) {
      relayHandler = handler;
    },
    deliverTo(peerId, _fromPeerId, data) {
      const ws = sockets.get(peerId);
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(encodeForWire(data)));
    },
    peerIds() {
      return [...sockets.keys()];
    },
  };
}
