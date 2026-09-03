/**
 * THIS FILE ONLY LOADS IN A BROWSER (or a DOM-shimmed environment, e.g.
 * jsdom with `HTMLElement`/`customElements` on `globalThis`) - it is
 * deliberately excluded from this package's own `index.js` (which stays
 * plain-Node-importable, see that file's own doc comment), the exact same
 * split `@qu/app-shell`'s `shell.js` already establishes for
 * `<qu-app-shell>`.
 *
 * Importing this registers the three declarative Qu Components
 * (`<qu-view>`, `<qu-bind>`, `<qu-list>`) with `customElements` - side
 * effects only, nothing to import BY NAME from here (import the classes
 * directly from qu-view.js/qu-bind.js/qu-list.js if a caller genuinely
 * needs the class itself, e.g. for `instanceof` checks in a test).
 */
import { QuView } from './qu-view.js';
import { QuBind } from './qu-bind.js';
import { QuList } from './qu-list.js';

if (typeof customElements !== 'undefined') {
  if (!customElements.get('qu-view')) customElements.define('qu-view', QuView);
  if (!customElements.get('qu-bind')) customElements.define('qu-bind', QuBind);
  if (!customElements.get('qu-list')) customElements.define('qu-list', QuList);
}
