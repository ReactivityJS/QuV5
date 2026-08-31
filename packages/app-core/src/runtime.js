/**
 * APP RUNTIME — interprets the Application Content a `ContentResolver` can
 * reach (docs/app-shell-arbeitsauftrag.md §22): given a route, resolves
 * the Manifest, the matching Page, that Page's (or the Manifest's root)
 * Template, and the Manifest's theme Style into one plan an outer, DOM-aware
 * caller (`@qu/app-shell`'s `boot.js`) hands straight to `@qu/app-renderer`'s
 * `renderPage()`.
 *
 * Deliberately has ZERO DOM dependency, same "UI-agnostic core" posture
 * `architecture.md` §1 already commits the whole framework to - this class
 * is unit-testable with nothing but an in-process `Space` (see
 * test/runtime.test.js), no jsdom needed. `@qu/app-shell` is the one place
 * that actually touches `document`/`window`.
 */
import { ContentResolver } from './resolver.js';

export class AppRuntime {
  /** @param {import('@qu/space-core').Space} space @param {{appAdminPub: Uint8Array|string, kinds?: object}} params - `kinds` forwarded to `ContentResolver` unchanged, see its own doc comment. */
  constructor(space, { appAdminPub, kinds }) {
    this._resolver = new ContentResolver(space, { appAdminPub, kinds });
  }

  /** @returns {Promise<object|null>} See `ContentResolver.resolveManifest()`. */
  resolveManifest(options) {
    return this._resolver.resolveManifest(options);
  }

  /** @returns {Promise<Array<{route, title}>>} See `ContentResolver.resolveRoutes()`. */
  resolveRoutes(options) {
    return this._resolver.resolveRoutes(options);
  }

  /** @returns {Promise<Array<{name}>>} See `ContentResolver.resolveTemplateNames()`. */
  resolveTemplateNames(options) {
    return this._resolver.resolveTemplateNames(options);
  }

  /** @returns {Promise<Array<{name}>>} See `ContentResolver.resolveStyleNames()`. */
  resolveStyleNames(options) {
    return this._resolver.resolveStyleNames(options);
  }

  /**
   * Resolves everything needed to render one route in one call: the
   * Manifest (for `theme`/`defaultRoute`/the fallback root template), the
   * matching Page (`null` = no such route - the caller's cue to render a
   * "not found" fallback, docs §16's "Framework Default"), that Page's own
   * `template` (falling back to the Manifest's `rootTemplate` if the Page
   * didn't declare one), and the Manifest's `theme` stylesheet.
   * @param {string} route
   * @returns {Promise<{manifest: object|null, page: object|null, templateHtml: string|null, css: string}>}
   */
  async resolveRoute(route, options) {
    const manifest = await this._resolver.resolveManifest(options);
    const page = await this._resolver.resolvePage(route, options);
    const templateName = page?.template ?? manifest?.rootTemplate ?? null;
    const [templateHtml, css] = await Promise.all([
      templateName ? this._resolver.resolveTemplate(templateName, options) : null,
      manifest?.theme ? this._resolver.resolveStyle(manifest.theme, options) : '',
    ]);
    return { manifest, page, templateHtml, css };
  }
}
