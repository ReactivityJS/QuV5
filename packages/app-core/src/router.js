/**
 * HASH ROUTER — `#/<page>/subpage/...` (docs/app-shell-arbeitsauftrag.md
 * §6). Deliberately knows nothing about which routes exist - it only turns
 * `location.hash` into a route string and calls back on change; resolving
 * whether that route has a page is `ContentResolver`'s job (resolver.js),
 * kept as a separate step so this class stays trivially testable with a
 * fake `window` (see test/router.test.js) and has zero Space/network
 * dependency of its own.
 */
export class HashRouter {
  /** @param {{window: {location: {hash: string}, addEventListener: Function, removeEventListener: Function}, onChange: (route: string) => void}} params */
  constructor({ window, onChange }) {
    this._window = window;
    this._onChange = onChange;
    this._handleHashChange = () => this._onChange(this.current());
  }

  /** @returns {string} The current route, always starting with `/` (`''`/`'#'`/`'#/'` all normalize to `'/'`). */
  current() {
    const hash = this._window.location.hash ?? '';
    const route = hash.startsWith('#') ? hash.slice(1) : hash;
    return route.startsWith('/') ? route : `/${route}`;
  }

  /** Wires `hashchange` and fires `onChange` once immediately with the current route. */
  start() {
    this._window.addEventListener('hashchange', this._handleHashChange);
    this._handleHashChange();
  }

  stop() {
    this._window.removeEventListener('hashchange', this._handleHashChange);
  }

  /** @param {string} route */
  navigate(route) {
    this._window.location.hash = route.startsWith('/') ? route : `/${route}`;
  }
}
