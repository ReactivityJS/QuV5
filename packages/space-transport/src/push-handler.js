/**
 * PUSH HANDLER — a plugin, not core relay logic: subscribes to the relay's
 * own `relay.notify.**` events (see relay.js's "PUSH ROUTING" doc comment)
 * and decides, PURELY from the `online` flag already on the payload,
 * whether to actually send a Web Push. This is the concrete example of
 * "toast vs. browser-notification vs. push is the handler's call based on
 * state, not something baked into the event bus" - the bus/relay only
 * ever describe WHAT happened and WHETHER the recipient looks reachable
 * live; every decision about WHICH channel to use lives in a handler like
 * this one, registered independently, swappable/removable without
 * touching relay.js at all.
 *
 * `sendPush` is injectable specifically so this stays testable and so a
 * real deployment can plug in an actual Web Push implementation (VAPID
 * keys + the `web-push` npm package, or `@qu/push` from the V3 evaluation
 * branch this was ported from, which already has a real one) without this
 * file needing to change - the default here just logs, which is enough to
 * prove the ROUTING is correct end-to-end (see demo/relay.mjs) without
 * this PoC inventing its own VAPID/push-subscription-storage machinery,
 * real, separate work with its own scope.
 */

/**
 * @param {import('@qu/events').EventBus} bus
 * @param {{sendPush?: (payload: {nodeId: string, kind: string, topic: string, to: string, authorPub: string}) => void|Promise<void>, pattern?: string}} [options]
 *   `sendPush` defaults to a console.log stub (see this file's own doc
 *   comment). `pattern` defaults to `relay.notify.**` (every kind/topic) -
 *   narrow it (e.g. `relay.notify.chat.**`) to only push for specific Kinds.
 * @returns {() => void} Unsubscribe function.
 */
export function registerPushHandler(bus, { sendPush = defaultSendPush, pattern = 'relay.notify.**' } = {}) {
  return bus.on(pattern, async (payload) => {
    if (payload.online) return; // the recipient's own live connection already got the real, forwarded envelope - a push would be redundant noise.
    await sendPush(payload);
  });
}

function defaultSendPush(payload) {
  console.log(`[push-handler] would send Web Push to ~${payload.to.slice(0, 12)}… : ${payload.kind}.${payload.topic} in node ${payload.nodeId} (from ~${payload.authorPub.slice(0, 12)}…)`);
}
