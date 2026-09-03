/**
 * <qu-view> — read-only, live-updating binding of ONE field of a Space
 * Node into a real DOM element, built on `@qu/space-ui`'s `bindField()`
 * (the actual reactive primitive - this Component is purely the
 * declarative wrapper QuV5 was missing over it; see architecture.md's
 * corrected "Phase 2" section). Subscribes in `connectedCallback()`,
 * unsubscribes in `disconnectedCallback()` - mounting IS subscribing, no
 * separate wiring step, matching QuV3's own `<qu-view>`.
 *
 * Attributes: `field` (required - the field name on the resolved Node),
 * `kind` + `node-id` (see resolve.js's own doc comment for the two ways
 * each can be supplied), `attr` (which DOM property carries the value -
 * `"auto"` (default: `.value` for a form control, `.textContent`
 * otherwise), `"value"`, `"textContent"`, `"checked"`, or any other plain
 * element property name). Deliberately NO `"innerHTML"` option - a
 * live-bound field's value is Space data, not template markup that has
 * been through `sanitizeHtml()` (see @qu/app-renderer's sanitizer.js);
 * rendering it as markup here would reopen exactly the injection risk that
 * pipeline exists to close. A caller that genuinely needs rich HTML from
 * Space data renders it template-side via `pageKind.data` instead (already
 * sanitized in `render.js`).
 *
 * Acts on itself unless it has exactly one child ELEMENT (e.g. a wrapped
 * `<input>`), which becomes the actual bind target instead - see
 * context.js's `resolveTarget()`.
 */
import { bindField } from '@qu/space-ui';
import { resolveTarget, assertSafeAttrMode } from './context.js';
import { resolveField } from './resolve.js';

export class QuView extends HTMLElement {
  connectedCallback() {
    this._generation = (this._generation ?? 0) + 1;
    this._unbind = null;
    // Kept on the instance (not just fired-and-forgotten) so a caller - a test, mainly - can
    // `await el._started` to observe completion or a thrown error (e.g. assertSafeAttrMode()'s
    // rejection of attr="innerHTML"); connectedCallback() itself can't be async (the spec requires
    // it run synchronously), so this is the one way to make the async work it kicks off awaitable.
    // ALSO given its own .catch() right here - a real misuse (attr="innerHTML") should fail loud
    // in the console, but must never become a literal unhandled-rejection crash for markup a CMS
    // author (not this element's programmer) happened to write; `_started` itself stays the
    // original rejected promise (a second subscriber doesn't swallow it), so a test can still
    // `assert.rejects(() => el._started)`.
    this._started = this._start(this._generation);
    this._started.catch((err) => console.error('<qu-view>:', err.message));
  }

  async _start(generation) {
    const resolved = await resolveField(this, generation, () => this._generation);
    if (!resolved) return;
    const { field, release } = resolved;
    const target = resolveTarget(this);
    const attrMode = this.getAttribute('attr') ?? 'auto';
    try {
      assertSafeAttrMode(attrMode);
    } catch (err) {
      release();
      throw err;
    }
    const unbindField = bindField(target, field, { prop: attrMode === 'auto' ? null : attrMode });
    this._unbind = () => {
      unbindField();
      release();
    };
  }

  disconnectedCallback() {
    this._generation = (this._generation ?? 0) + 1; // invalidates any in-flight _start() from this connection.
    this._unbind?.();
    this._unbind = null;
  }
}
