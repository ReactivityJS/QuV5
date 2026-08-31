/**
 * CMS DEV API — `createTemplate()`/`createStyle()`'s auto-registration
 * into `templateRegistryKind`/`styleRegistryKind` (kinds.js), and the
 * `editTemplate()`/`editStyle()`/`editPage()` UPDATE path, all proven
 * through a REAL (in-process) relay so write-ACL is genuinely enforced -
 * see `resolver.test.js`'s own doc comment for why that matters for
 * `'content'`-ACL Kinds specifically (no owner-pubkey shortcut, so a
 * misclassified registry id would silently break these calls even when
 * the CLIENT-side code is correct - see `relay-resolver.js`'s own doc
 * comment on exactly this risk).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createTemplate, createStyle, createPage, editTemplate, editStyle, editPage, grantContentWriter } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { templateKind, styleKind, pageKind } from '../src/kinds.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function setupHub(members) {
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: members.map((m) => m.pub) });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });
  return hub;
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport });
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('createTemplate()/createStyle() auto-register into their own registries - resolveTemplateNames()/resolveStyleNames() enumerate them', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = await setupHub(members);
  const space = await connect(hub, admin, members, 'admin');

  await createTemplate(space, { name: 'layout/main', html: '<main></main>' });
  await createTemplate(space, { name: 'layout/post', html: '<article></article>' });
  await createStyle(space, { name: 'global', css: 'body{}' });

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  const templates = await resolver.resolveTemplateNames();
  const styles = await resolver.resolveStyleNames();
  assert.deepEqual(
    templates.map((t) => t.name).sort(),
    ['layout/main', 'layout/post']
  );
  assert.deepEqual(styles, [{ name: 'global' }]);
});

test('createTemplate() called twice with the same name does not duplicate the registry entry', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = await setupHub(members);
  const space = await connect(hub, admin, members, 'admin');

  await createTemplate(space, { name: 'main', html: '<main>v1</main>' });
  await createTemplate(space, { name: 'main', html: '<main>v2</main>' }); // re-registering the same name.

  const resolver = new ContentResolver(space, { appAdminPub: admin.signingPub });
  const templates = await resolver.resolveTemplateNames();
  assert.equal(templates.length, 1);
});

test('editTemplate()/editStyle()/editPage() update EXISTING content in place - readable by an unrelated visitor through the relay', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: visitor.signingPub, xPub: visitor.xPublicKey }];
  const hub = await setupHub(members);
  const adminSpace = await connect(hub, admin, members, 'admin');

  await createTemplate(adminSpace, { name: 'main', html: 'v1 template' });
  await createStyle(adminSpace, { name: 'global', css: 'v1 css' });
  await createPage(adminSpace, { route: '/', title: 'v1 title', template: 'main', content: 'v1 content' });

  await editTemplate(adminSpace, { name: 'main', html: 'v2 template' });
  await editStyle(adminSpace, { name: 'global', css: 'v2 css' });
  await editPage(adminSpace, { route: '/', title: 'v2 title', content: 'v2 content' }); // template omitted - should stay unchanged.

  const visitorSpace = await connect(hub, visitor, members, 'visitor');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolveTemplate('main'), 'v2 template');
  assert.equal(await resolver.resolveStyle('global'), 'v2 css');
  const page = await resolver.resolvePage('/');
  assert.equal(page.title, 'v2 title');
  assert.equal(page.content, 'v2 content');
  assert.equal(page.template, 'main'); // untouched field survives a partial edit.
});

test('editTemplate() on a template a DIFFERENT, non-granted identity owns is rejected by the relay - real per-owner ACL, not just local trust', async () => {
  const admin = await actor();
  const mallory = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: mallory.signingPub, xPub: mallory.xPublicKey }];
  const hub = await setupHub(members);
  const adminSpace = await connect(hub, admin, members, 'admin');
  await createTemplate(adminSpace, { name: 'main', html: 'admin owns this' });

  const malloryHub = hub; // same relay
  const malloryResolveKindSchema = await createAppResolveKindSchema({ appAdminPubs: members.map((m) => m.pub) });
  const mallorySpace = await connect(malloryHub, mallory, members, 'mallory');

  // mallory tries to edit admin's OWN template - she has no grant for it. She DOES need to target
  // the correct (admin-owned) nodeId to even reach the relay's ACL check at all - see
  // editTemplate()'s own "GRANTED CO-EDITORS" doc comment on why ownerPub is required here.
  await editTemplate(mallorySpace, { name: 'main', html: 'hacked by mallory', ownerPub: admin.signingPub, timeout: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const resolver = new ContentResolver(adminSpace, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolveTemplate('main'), 'admin owns this'); // unchanged.
});

test('grantContentWriter() lets a SPECIFIC other identity edit ONE page - the "user X darf CMS-Inhalte pflegen" mechanism', async () => {
  const admin = await actor();
  const editor = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }, { pub: editor.signingPub, xPub: editor.xPublicKey }];
  const hub = await setupHub(members);
  const adminSpace = await connect(hub, admin, members, 'admin');
  await createPage(adminSpace, { route: '/blog/hello', title: 'v1', content: 'v1 body' });

  await grantContentWriter(adminSpace, { kind: pageKind, path: '/blog/hello', granteePub: editor.signingPub });

  const editorSpace = await connect(hub, editor, members, 'editor');
  await editPage(editorSpace, { route: '/blog/hello', title: 'v2 by editor', content: 'v2 body', ownerPub: admin.signingPub });

  // adminSpace already has this Node LOCALLY attached (from her own createPage() above), so
  // resolvePage() returns instantly with whatever is CURRENTLY there - it has no reason to wait for
  // a CHANGE (only a first sync), so the editor's write echoing back to admin over the relay is a
  // genuine, separate round trip this test must wait out explicitly.
  const resolver = new ContentResolver(adminSpace, { appAdminPub: admin.signingPub });
  await waitUntil(async () => (await resolver.resolvePage('/blog/hello'))?.title === 'v2 by editor');
  const page = await resolver.resolvePage('/blog/hello');
  assert.equal(page.title, 'v2 by editor');
  assert.equal(page.content, 'v2 body');
});
