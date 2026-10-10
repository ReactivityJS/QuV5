/**
 * CHAT APP DESCRIPTOR — the `/apps/*` discovery convention this repo's own
 * `apps/README.md` documents in full. `apps-registry.mjs` picks this up by
 * folder name alone (any `apps/<name>/index.js`), no registration
 * elsewhere needed - the admin console lists/installs it exactly like
 * Gästebuch/Blog/Forum the moment this file exists.
 */
import { installChat, updateChat, CHAT_VERSION, CHAT_TEMPLATE_NAME } from './bundle.js';
import { wireChat } from './actions.js';

export default {
  key: 'chat',
  label: 'Chat',
  install: installChat,
  update: updateChat,
  version: CHAT_VERSION,
  templateNames: () => [CHAT_TEMPLATE_NAME],
  wire: wireChat,
};
