/**
 * SLOTS — resolves `<qu-slot name="...">` placeholders in a Template's HTML
 * (docs/app-shell-arbeitsauftrag.md §10/§11): each named slot is replaced
 * by the matching entry in `slotContents`, or - if none was supplied -
 * by the `<qu-slot>` element's OWN fallback children (a Template author's
 * default content for that slot), same as a native `<slot>` element's
 * fallback-content behavior. `slotContents` values are assumed ALREADY
 * sanitized (see sanitizer.js) - this module only composes markup, it
 * never decides what's safe to insert.
 *
 * Deliberately a single, non-recursive pass: a slot's filler content is
 * inserted as-is, its own `<qu-slot>` tags (if any) are NOT re-resolved.
 * Recursive template composition (a Component's template containing slots
 * of its own) is real, later work - see docs' own "Nicht-Ziele" - not
 * something this Phase-1 renderer needs to solve to load one Page through
 * one Template.
 */
export function resolveSlots(templateHtml, slotContents = {}, doc = globalThis.document) {
  const container = doc.createElement('div');
  container.innerHTML = templateHtml ?? '';

  for (const slotEl of [...container.querySelectorAll('qu-slot')]) {
    const name = slotEl.getAttribute('name') ?? 'default';
    if (Object.hasOwn(slotContents, name)) {
      const filler = doc.createElement('div');
      filler.innerHTML = slotContents[name] ?? '';
      slotEl.replaceWith(...filler.childNodes);
    } else {
      slotEl.replaceWith(...slotEl.childNodes); // no content supplied - keep the template's own fallback children.
    }
  }

  return container.innerHTML;
}
