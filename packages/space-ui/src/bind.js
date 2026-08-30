/**
 * BIND — one-way and two-way reactive binding between a real DOM element
 * and an `@qu/space-core` `Field` (`node.field(name)`, see field.js). No
 * virtual DOM, no diffing beyond "does the value actually differ" (avoids
 * clobbering an input's own cursor position on every remote echo) - a
 * `Field` already IS the reactive primitive (`observe()`), this is just
 * wiring it to `element[prop]` and, optionally, the reverse direction.
 *
 * ONE-WAY (`twoWay: false`, the default): `el[prop]` (default `textContent`
 * for a plain element, `value` for anything with a `value` property - an
 * `<input>`/`<textarea>`/`<select>`) tracks the field, nothing writes back.
 *
 * TWO-WAY (`twoWay: true`): ALSO writes `el[prop]` back through
 * `field.set()` on `event` (default `'input'`) - guarded against feedback:
 * a write triggered by the element's own edit does not immediately bounce
 * back and stomp the user's cursor once the corresponding remote echo
 * arrives (the `applying` flag below), and a render triggered while the
 * user is actively typing never overwrites what they're mid-typing with a
 * stale re-read of the SAME value it just wrote - only a genuinely
 * different remote value re-renders once `applying` clears.
 *
 * Works with any `Field` that has `.get()`/`.set()`/`.observe()` - in
 * practice an 'atomic' field (see kind-schema.js); a `'text'` field's own
 * `ytext`/`insert()`/`delete()` API is a better fit for a real rich-text
 * editor binding (out of scope here - point ProseMirror/Quill straight at
 * `field.ytext`, as `docs/v5-space-core-guide.md` already recommends).
 */

/**
 * @param {Element} el
 * @param {{get(): Promise<*>, set(value: *): Promise<void>, observe(cb: () => void): () => void}} field
 * @param {{twoWay?: boolean, event?: string, prop?: string|null}} [options]
 * @returns {() => void} Stops the binding (unobserves the field, removes any event listener).
 */
export function bindField(el, field, { twoWay = false, event = 'input', prop = null } = {}) {
  const targetProp = prop ?? ('value' in el ? 'value' : 'textContent');
  let applying = false;

  async function render() {
    if (applying) return;
    const value = (await field.get()) ?? '';
    // Re-check: this render()'s OWN field.get() may have been in flight when the user started
    // typing (applying flips to true synchronously, but this call was already past the first
    // check and suspended on the await) - without this second check, a late-resolving render()
    // triggered before an edit began can still land AFTER it and clobber the in-progress edit
    // with the stale value it captured before the edit ever started.
    if (applying) return;
    if (el[targetProp] !== value) el[targetProp] = value;
  }

  const unobserve = field.observe(render);
  render();

  let onEvent = null;
  if (twoWay) {
    onEvent = async () => {
      applying = true;
      try {
        await field.set(el[targetProp]);
      } finally {
        applying = false;
      }
    };
    el.addEventListener(event, onEvent);
  }

  return () => {
    unobserve();
    if (onEvent) el.removeEventListener(event, onEvent);
  };
}

/**
 * Convenience: a checkbox/toggle bound two-way to a boolean field, via
 * `'checked'`/`'change'` instead of `bindField()`'s text-oriented defaults.
 * @param {HTMLInputElement} el - `type="checkbox"`.
 * @param {object} field
 * @returns {() => void}
 */
export function bindCheckbox(el, field) {
  let applying = false;

  async function render() {
    if (applying) return;
    const value = (await field.get()) ?? false;
    if (applying) return; // see bindField()'s identical re-check for why.
    if (el.checked !== value) el.checked = value;
  }

  const unobserve = field.observe(render);
  render();

  const onChange = async () => {
    applying = true;
    try {
      await field.set(el.checked);
    } finally {
      applying = false;
    }
  };
  el.addEventListener('change', onChange);

  return () => {
    unobserve();
    el.removeEventListener('change', onChange);
  };
}
