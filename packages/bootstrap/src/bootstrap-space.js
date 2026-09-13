/**
 * BOOTSTRAP-SPACE — the declarative counterpart to hand-constructing a
 * `Space` (docs/quv5-vs-quv3-decision.md's Arbeitspaket 2): given a plain
 * config object naming WHICH adapter backs each slot (and whatever options
 * that adapter needs), resolves every slot through an `AdapterRegistry`
 * (adapter-registry.js) and constructs the `Space` - the missing
 * "Mountpoint"-equivalent QuV3 had (`QuMount.resolve(path)`), reframed for
 * V5: not a path-prefix dispatch table any more (V5 has no flat path
 * namespace to dispatch on - `docs/v5-space-core-guide.md`'s own decision
 * to drop it), but the same underlying idea - WHICH concrete adapter a
 * given concern uses is a bootstrap-time PARAMETER, never a hardcoded
 * `import` a deployment has to edit source to change.
 *
 * Each slot value is EITHER:
 *   - `{adapter: '<name>', ...options}` - resolved via `registry.create(slot,
 *     name, options)` (this is the whole point of this function: choosing
 *     an adapter BY NAME, from data, e.g. deployment config/env vars/a
 *     `<qu-app-shell>` attribute - see shell.js for the real deployment
 *     that switched to exactly this).
 *   - an already-constructed instance (anything that does NOT have a
 *     string `adapter` property) - passed straight through, untouched. This
 *     is the escape hatch that keeps `bootstrapSpace()` fully backward-
 *     compatible with the existing "just hand `Space` an adapter instance"
 *     style (`Space`'s own constructor never changed) - a caller with a
 *     genuinely one-off adapter, or one that doesn't want a registry at
 *     all, never has to register it anywhere just to use this function.
 *   - `null`/`undefined`/omitted - resolves to `undefined` (the underlying
 *     `Space` default for that slot - memory-only `storage`, its own
 *     private in-memory default for `volatileStorage`).
 *
 * `identity` and `transport` are REQUIRED (a `Space` with neither is
 * meaningless); `storage`/`volatileStorage` stay optional, same as `Space`
 * itself. The resolved `transport` is checked against the Transport
 * contract (`transport-contract.js`'s `assertTransportShape()`, see
 * `docs/peer-transport-contract.md` - Arbeitspaket 4) BEFORE anything else
 * touches it - a typo'd/incomplete custom adapter fails loudly right here,
 * not as a cryptic `TypeError` deep inside `Space`. `transport.connect()`
 * is then called automatically (every real transport has one; a test
 * double may not, `connect` is still required by the contract though - a
 * test double that's a genuine no-op still defines it as `async () => {}`)
 * - one less thing every caller previously had to remember to do itself
 * (`@qu/app-shell`'s `shell.js` did this by hand before).
 *
 * `bus` defaults to a FRESH `EventBus` when entirely omitted (unlike
 * `Space`'s own constructor, which defaults to `null` - seebelow) -
 * `bootstrapSpace()` is the higher-level, "give me a working, observable
 * Space" entrypoint, and every real caller in this codebase already wires
 * one up (`@qu/app-shell`'s `shell.js`'s own doc comment on why `cms-
 * actions.js` needs it to tell a silently-rejected write apart from a slow
 * one) - pass `bus: null` explicitly to opt back into `Space`'s own
 * quieter default, or a specific `EventBus` instance to reuse one you
 * already built elsewhere.
 * @param {{
 *   registry?: import('./adapter-registry.js').AdapterRegistry,
 *   identity: object,
 *   transport: object,
 *   storage?: object|null,
 *   volatileStorage?: object|null,
 *   members?: Array<{pub: Uint8Array, xPub: Uint8Array}>,
 *   relayAdmins?: Array<Uint8Array>,
 *   bus?: object|null,
 * }} config
 * @returns {Promise<{identity: object, transport: object, storage: object|undefined, volatileStorage: object|undefined, bus: object|null, space: import('@qu/space-core').Space}>}
 */
import { Space } from '@qu/space-core';
import { EventBus } from '@qu/events';
import { assertTransportShape } from './transport-contract.js';

function isAdapterRef(value) {
  return value != null && typeof value === 'object' && typeof value.adapter === 'string';
}

async function resolveSlot(registry, slot, value) {
  if (value == null) return undefined;
  if (!isAdapterRef(value)) return value;
  if (!registry) throw new Error(`bootstrapSpace: "${slot}" names an adapter ("${value.adapter}") but no "registry" was given`);
  const { adapter, ...options } = value;
  return registry.create(slot, adapter, options);
}

export async function bootstrapSpace({ registry, identity, transport, storage = null, volatileStorage = null, members = [], relayAdmins = [], bus } = {}) {
  const resolvedIdentity = await resolveSlot(registry, 'identity', identity);
  if (!resolvedIdentity) throw new Error('bootstrapSpace: "identity" is required');

  const resolvedTransport = await resolveSlot(registry, 'transport', transport);
  if (!resolvedTransport) throw new Error('bootstrapSpace: "transport" is required');
  assertTransportShape(resolvedTransport);
  await resolvedTransport.connect();

  const resolvedStorage = await resolveSlot(registry, 'storage', storage);
  const resolvedVolatileStorage = await resolveSlot(registry, 'volatileStorage', volatileStorage);
  const resolvedBus = bus === undefined ? new EventBus() : bus;

  const space = new Space({
    identity: resolvedIdentity,
    members,
    relayAdmins,
    transport: resolvedTransport,
    storage: resolvedStorage,
    bus: resolvedBus,
    ...(resolvedVolatileStorage !== undefined ? { volatileStorage: resolvedVolatileStorage } : {}),
  });

  return { identity: resolvedIdentity, transport: resolvedTransport, storage: resolvedStorage, volatileStorage: resolvedVolatileStorage, bus: resolvedBus, space };
}
