/**
 * UPLOAD STATUS UI — wires a `<input type="file">` and per-file status
 * icon elements to `@qu/space-plugins`' `UploadOutbox` (local save, sync
 * queue, mark-done-after-relay-sync - see that file's own doc comment).
 *
 * `bindUploadStatusIcon()` NEVER auto-hides the icon on `'done'` - it only
 * ever changes which CSS class is present (`classes.done` replaces
 * `classes.uploading`, etc.). "Display stay always on bis File remote zum
 * relay synced" (this Task's own wording) means the caller's stylesheet
 * decides what a `'done'` icon looks like (a checkmark, faded out via CSS,
 * whatever) - this function does not remove the element or set `hidden`,
 * so an upload can never silently look "gone" while actually still
 * `'pending'`/`'failed'` under a class the caller forgot to style.
 */

/**
 * @param {HTMLInputElement} inputEl - `<input type="file" multiple>` (or single - both work, `.files` is always iterated).
 * @param {import('@qu/space-plugins').UploadOutbox} outbox
 * @param {{onEnqueue?: (id: string, file: File) => void}} [options]
 * @returns {() => void} Stops the binding.
 */
export function bindFileInput(inputEl, outbox, { onEnqueue } = {}) {
  const onChange = async () => {
    for (const file of inputEl.files) {
      const id = await outbox.enqueue({ name: file.name, size: file.size, mimeType: file.type }, file);
      onEnqueue?.(id, file);
    }
    inputEl.value = ''; // lets selecting the SAME file again fire another 'change' - standard <input type="file"> UX.
  };
  inputEl.addEventListener('change', onChange);
  return () => inputEl.removeEventListener('change', onChange);
}

/**
 * @param {Element} iconEl
 * @param {import('@qu/space-plugins').UploadOutbox} outbox
 * @param {string} fileId
 * @param {{classes?: {pending: string, uploading: string, done: string, failed: string}}} [options]
 * @returns {Promise<() => void>} Stops the binding (resolves once the FIRST status render has happened - see `UploadOutbox.watch()`'s own doc comment on why this isn't synchronous).
 */
export async function bindUploadStatusIcon(iconEl, outbox, fileId, { classes = DEFAULT_CLASSES } = {}) {
  const allClasses = Object.values(classes);
  return outbox.watch(fileId, (record) => {
    for (const cls of allClasses) iconEl.classList.remove(cls);
    iconEl.classList.add(classes[record?.status] ?? classes.pending);
    iconEl.title = record?.status === 'failed' && record.error ? record.error : '';
  });
}

const DEFAULT_CLASSES = Object.freeze({ pending: 'qu-upload-pending', uploading: 'qu-upload-uploading', done: 'qu-upload-done', failed: 'qu-upload-failed' });
