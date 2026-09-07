/**
 * `globalTemplateNames`/`globalStyleNames` (`kinds.js`'s own `platformAppsKind`
 * doc comment) — a REAL, previously-shipped bug this Kind field (and
 * `registerApp()`'s/`addGlobalTemplateNames()`'s own support for it) fixes:
 * `createGlobalTemplate()`/`createGlobalStyle()` for any `realm: 'global'`
 * prefix OTHER than the built-in admin console's hardcoded `"main"`
 * template was ALWAYS silently rejected (misclassified against the generic
 * `'content'`-ACL fallback, no grant exists for a `'relay-admins'`-ACL
 * Kind) - concretely, `installGlobalCms()`'s own `__cms__` template write,
 * used both by `bin/bootstrap-platform.mjs`'s "cms" bootstrap step AND the
 * admin console's own "Views/Seiten (CMS)" button (`admin-actions.js`) for
 * EVERY app that isn't "admin" itself. Found while diagnosing a user report
 * that `bootstrap-platform.mjs` never actually finished ("Some writes were
 * never write-acked") even once its relay-admin identity was genuinely
 * trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { registerApp, addGlobalTemplateNames, createGlobalTemplate, adminTemplateKind, ContentResolver, globalAppAnchor } from '@qu/app-core';
import { createLiveAppResolveKindSchema } from '../src/live-app-resolver.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function bootRelay() {
  const relayAdmin = await actor();
  const relayAdmins = [relayAdmin.signingPub];
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;
  await start({ url, relayAdmins });

  async function connect() {
    const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
    await transport.connect();
    return new Space({ identity: relayAdmin, members, relayAdmins, transport });
  }

  const space = await connect();

  async function close() {
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { space, connect, close };
}

test('createGlobalTemplate(): a name NEVER declared via globalTemplateNames is silently rejected (the bug), one that IS declared is accepted (the fix)', async () => {
  const { space, connect, close } = await bootRelay();
  try {
    // No `globalTemplateNames` at all - the exact shape of every existing realm:'global' registration
    // before this fix, and of "App registrieren"'s own bare form.
    await registerApp(space, { prefix: 'notice', name: 'Notice Board', realm: 'global' });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const anchor = await globalAppAnchor('notice');

    // THE BUG: an undeclared template name is silently dropped by the RELAY - resolving it back
    // through `space` itself would misleadingly "succeed" (the local Y.Doc already has the
    // optimistic mutation applied regardless of relay acceptance, `verify-writes.js`'s own top doc
    // comment on exactly this trap) - a FRESH, independent connection (never wrote it, only ever
    // sees what the relay actually mirrored/replayed) is what genuinely proves the write never
    // landed.
    await createGlobalTemplate(space, 'notice', { name: 'undeclared', html: '<p>never lands</p>' });
    const outsider1 = await connect();
    const undeclared = await new ContentResolver(outsider1, { appAdminPub: anchor, kinds: { templateKind: adminTemplateKind } }).resolveTemplate('undeclared', { timeout: 800 });
    assert.equal(undeclared, null, 'an undeclared global template name must still be silently rejected - this is the bug being characterized, not (yet) the fix');

    // THE FIX: declaring the name first (`addGlobalTemplateNames()` - the SAME thing
    // `admin-actions.js`'s own "Views/Seiten (CMS)" button and `bootstrap-platform.mjs`'s own "cms"
    // registration now both do before ever calling `installGlobalCms()`) makes the write land.
    await addGlobalTemplateNames(space, { prefix: 'notice', globalTemplateNames: ['declared'] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await createGlobalTemplate(space, 'notice', { name: 'declared', html: '<p>lands now</p>' });
    const outsider2 = await connect();
    const declared = await new ContentResolver(outsider2, { appAdminPub: anchor, kinds: { templateKind: adminTemplateKind } }).resolveTemplate('declared', { timeout: 3000 });
    assert.equal(declared, '<p>lands now</p>', 'a DECLARED global template name must be accepted and resolvable, seen by a peer that never wrote it');
  } finally {
    await close();
  }
});

test('registerApp({globalTemplateNames}): declaring the name AT REGISTRATION TIME (bootstrap-platform.mjs\'s own "cms" step) also works, no separate addGlobalTemplateNames() call needed', async () => {
  const { space, connect, close } = await bootRelay();
  try {
    await registerApp(space, { prefix: 'cms2', name: 'CMS', realm: 'global', mode: 'multiuser', globalTemplateNames: ['__cms__'] });
    await new Promise((resolve) => setTimeout(resolve, 400));

    await createGlobalTemplate(space, 'cms2', { name: '__cms__', html: '<div><qu-slot name="content"></qu-slot></div>' });

    // Again, a FRESH connection - see the sibling test's own doc comment on why this matters here.
    const anchor = await globalAppAnchor('cms2');
    const outsider = await connect();
    const template = await new ContentResolver(outsider, { appAdminPub: anchor, kinds: { templateKind: adminTemplateKind } }).resolveTemplate('__cms__', { timeout: 3000 });
    assert.ok(template, 'a template name declared at registerApp() time is accepted immediately, no separate addGlobalTemplateNames() round trip needed');
  } finally {
    await close();
  }
});
