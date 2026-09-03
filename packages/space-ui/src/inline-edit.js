/**
 * INLINE EDIT — a `[contenteditable]` element bound to an `@qu/space-core`
 * `Field`, with explicit save/cancel semantics instead of `bind.js`'s
 * live-as-you-type two-way binding (a contenteditable's own "what does the
 * user consider a finished edit" convention is Enter/blur = save,
 * Escape = revert - not "every keystroke," which would also fight a
 * remote update mid-edit far more visibly than a text `<input>` would).
 *
 * WHILE EDITING (the element has focus), a remote change to the field is
 * NEVER applied to the DOM - clobbering what the user is actively typing
 * with someone else's concurrent edit would be worse than briefly showing
 * a stale value. The last-known-good value IS still tracked internally, so
 * the moment editing ends (save or cancel) the element reflects reality
 * again - save() always writes the user's own final text (last write
 * wins, same as any other 'atomic' field), cancel() reverts to whatever
 * the field's value was at that moment (including a remote change that
 * arrived mid-edit, now surfaced).
 */

/**
 * @param {HTMLElement} el - must have `contentEditable = 'true'` (this
 *   function does not set it itself - a caller styling the element
 *   differently while read-only vs. editable needs that control anyway).
 * @param {{get(): Promise<*>, set(value: *): Promise<void>, observe(cb: () => void): () => void}} field
 * @param {{onSave?: (value: string) => void, onCancel?: (value: string) => void}} [options]
 * @returns {(() => void) & {save: () => Promise<void>, cancel: () => void}} Stops the binding when called; `.save`/`.cancel` also let a caller trigger the same save/cancel an external UI control (e.g. an icon button) can drive without itself listening for Enter/Escape/blur.
 */
export function makeInlineEditable(el, field, { onSave, onCancel } = {}) {
  let lastKnownValue = '';
  let editing = false;
  // Set right before Enter/Escape call el.blur() themselves (purely to drop focus/exit edit mode
  // visually) - a REAL resulting 'blur' event must not ALSO run the blur listener's own save(),
  // which would otherwise double-save (Enter) or resurrect the just-cancelled value (Escape).
  // Not relied upon to fire at all: el.blur() is a no-op unless `el` is genuinely the focused
  // element, so save()/cancel() below are called directly by Enter/Escape, never routed through it.
  let ignoreNextBlur = false;

  async function render() {
    const value = (await field.get()) ?? '';
    lastKnownValue = value;
    if (!editing) el.textContent = value;
  }
  const unobserve = field.observe(render);
  render();

  const startEditing = () => {
    editing = true;
  };

  const save = async () => {
    editing = false;
    const value = el.textContent;
    await field.set(value);
    lastKnownValue = value;
    onSave?.(value);
  };

  const cancel = () => {
    editing = false;
    el.textContent = lastKnownValue;
    onCancel?.(lastKnownValue);
  };

  const onBlur = () => {
    if (ignoreNextBlur) {
      ignoreNextBlur = false;
      return;
    }
    save();
  };

  const onKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      ignoreNextBlur = true;
      save();
      el.blur?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      ignoreNextBlur = true;
      cancel();
      el.blur?.();
    }
  };

  el.addEventListener('focus', startEditing);
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onKeydown);

  const stop = () => {
    unobserve();
    el.removeEventListener('focus', startEditing);
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('keydown', onKeydown);
  };
  // Additive, backward-compatible: still callable exactly as `stop()` (every existing caller does
  // just that), but also exposes save()/cancel() directly - @qu/space-components' <qu-bind
  // editable="inline"> needs to trigger them from its own Save/Cancel icon buttons, not just from
  // Enter/Escape/blur on `el` itself.
  stop.save = save;
  stop.cancel = cancel;
  return stop;
}
