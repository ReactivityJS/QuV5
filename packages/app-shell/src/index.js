/**
 * Plain-Node-importable surface of this package - deliberately excludes
 * `shell.js` (`QuAppShell`), which extends `HTMLElement` at module-evaluate
 * time and therefore only loads in a browser/DOM-shimmed environment - see
 * that file's own doc comment. Import `@qu/app-shell/shell` directly (or
 * `./shell.js` from this package) in a browser entry point.
 */
export { startApp, startPlatform } from './boot.js';
export { loadOrCreateIdentity, joinSpace, IDENTITY_STORAGE_KEY } from './identity.js';
