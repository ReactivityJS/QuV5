/**
 * DEBUG LOGGER — an optional, opt-in watcher for ANY `EventBus`: client-side
 * (`new Space({..., bus})`) or relay-side (`createRelayForwarder({..., bus})`)
 * alike, since both are just an `EventBus` instance fed different events
 * (see `@qu/space-core`'s space.js / `@qu/space-transport`'s relay.js, both
 * of which now emit a `debug.**` topic family for exactly this - every
 * write, verify, reject, forward, mirror, and subscribe/hello, in addition
 * to the app-facing `space.node.*.changed`/`notification.*`/`relay.notify.*`
 * events those same files already emit).
 *
 * Deliberately NOT wired in by default anywhere - a bus with nobody
 * listening on `debug.**` costs one cheap trie lookup per event (see
 * `EventBus.emit()`'s own doc comment on dispatch cost); attaching this is
 * a separate, explicit opt-in on top of that, for exactly the
 * "debugging (optional)" use case: call it once, in dev/a debug console/a
 * CLI flag, get one line per event; never call it, pay nothing beyond the
 * lookup.
 *
 * This subscribes to the bus with `on()`, so it goes through `emit()`'s own
 * ordering/fault-isolation - a throwing `log` function is caught and
 * reported the same way any other handler's throw would be, never crashes
 * the write/forward it's just trying to observe.
 */

/**
 * @param {import('./event-bus.js').EventBus} bus
 * @param {{pattern?: string, log?: (line: string, payload: *) => void, label?: string}} [options]
 *   `pattern` defaults to `'**'` (literally everything on this bus, domain
 *   events included) - narrow it (e.g. `'debug.**'` for instrumentation
 *   only, or `'debug.relay.write.**'` for one slice) to cut noise.
 *   `log` defaults to `console.debug`, called as `log(line, payload)`.
 *   `label` (e.g. `'[relay]'`/`'[alice]'`) prefixes every line - useful
 *   the moment more than one bus's output is interleaved in one terminal
 *   (see `demo/relay.mjs`'s own two-peer + relay debug wiring).
 * @returns {() => void} Unsubscribe function - stops logging, changes nothing else.
 */
export function createDebugLogger(bus, { pattern = '**', log = console.debug, label = '' } = {}) {
  return bus.on(pattern, (payload, ctx) => {
    const prefix = label ? `${label} ` : '';
    log(`${prefix}${ctx.topic}`, payload);
  });
}
