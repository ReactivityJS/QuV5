/**
 * This entry point is plain-Node-importable on purpose - only
 * context.js/resolve.js's ancestor-DOM-resolution helpers, no
 * `HTMLElement` subclass anywhere here. The Custom Elements themselves
 * (`<qu-view>`/`<qu-bind>`/`<qu-list>`) live behind the separate
 * "@qu/space-components/elements" entry (src/elements.js) - a bare `class
 * extends HTMLElement` throws the moment a module defining one evaluates
 * under plain Node with no DOM/jsdom shim present, so they can never be
 * part of THIS entry. See @qu/app-shell's shell.js for the identical,
 * already-established split (that package's `<qu-app-shell>` is likewise
 * excluded from its own main index.js).
 */
export { findQuSpace, findQuKind, resolveTarget, getPath } from './context.js';
export { resolveNodeRef, resolveField } from './resolve.js';
