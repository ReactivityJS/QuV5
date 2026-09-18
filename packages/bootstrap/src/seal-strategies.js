/**
 * SEAL STRATEGY ADAPTERS — registers the `'sealStrategy'` slot's two
 * built-in strategies (`@qu/space-core`'s `seal-strategies.js`, docs/
 * routing-anonymity.md) so a deployment can pick one by NAME through
 * `bootstrapSpace()`'s config, exactly like `storage`/`transport`:
 *
 *   bootstrapSpace({ registry, identity, transport, members, sealStrategy: { adapter: 'pad-to-members' } });
 *
 * Safe to import anywhere (browser or Node) - both strategies are plain,
 * synchronous, zero-dependency functions already living in `@qu/space-core`
 * (which this package already depends on) - no separate browser/node pack
 * needed, unlike `./adapters/browser.js`/`./adapters/node.js`.
 */
import { sealStrategies } from '@qu/space-core';

/** @param {import('./adapter-registry.js').AdapterRegistry} registry */
export function registerSealStrategyAdapters(registry) {
  registry.register('sealStrategy', 'none', () => sealStrategies.none);
  registry.register('sealStrategy', 'pad-to-members', () => sealStrategies.padToMembers);
}
