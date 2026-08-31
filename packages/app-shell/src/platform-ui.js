/**
 * PLATFORM UI — the two pages `boot.js`'s `startPlatform()` renders that
 * are NOT Space app content: the relay-admin console (`#/admin/relay`)
 * and a plain landing page listing installed apps when no route prefix
 * matches. Framework-built-in UI, not `@qu/app-renderer`'s sanitize/slot
 * pipeline - nothing here is sourced from an app's own Space content, so
 * there is nothing to sanitize; Space-sourced VALUES (an already-
 * registered app's own `name`) are still rendered via `textContent`,
 * never `innerHTML`, on principle (same rule `demo/web/main.js` already
 * follows for message bodies) - the markup itself is a fixed string this
 * file owns, never interpolated from anything external.
 *
 * WRITE-ACL, not UI, is what actually gates the admin console:
 * `registerApp()` (`@qu/app-core`) writes `qu-platform-apps`, a
 * `'named'`-ACL Kind only the relay-admin identity can sign for - a
 * visitor without that key sees the SAME page (nothing secret about its
 * markup) but their own registration attempt is silently rejected by the
 * relay, exactly like any other unauthorized write in this framework. The
 * "you are not the relay-admin" banner below is a courtesy, not the
 * actual enforcement - never rely on it for anything security-relevant.
 */
import { QuCrypto } from '@qu/core';
import { registerApp } from '@qu/app-core';

const PAGE_STYLE = 'font-family: sans-serif; max-width: 40rem; margin: 2rem auto; line-height: 1.5; padding: 0 1rem;';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, relayAdminPub: Uint8Array, platform: import('@qu/app-core').PlatformRuntime}} params */
export async function renderAdminPage({ mountEl, doc, space, relayAdminPub, platform }) {
  const isAdmin = QuCrypto.toBase64(space.identity.signingPub) === QuCrypto.toBase64(relayAdminPub);
  const apps = await platform.resolveApps({ timeout: 500 });

  const container = doc.createElement('div');
  container.style.cssText = PAGE_STYLE;

  const h1 = doc.createElement('h1');
  h1.textContent = 'Relay-Admin';
  container.appendChild(h1);

  if (!isAdmin) {
    const warning = doc.createElement('p');
    warning.textContent = 'Du bist nicht als Relay-Admin angemeldet - du kannst diese Seite ansehen, aber jede Änderung wird vom Relay abgelehnt (Schreibrecht ist kryptographisch an die Relay-Admin-Identity gebunden, nicht an diese Seite).';
    warning.style.color = '#a00';
    container.appendChild(warning);
  }

  const h2 = doc.createElement('h2');
  h2.textContent = 'Installierte Apps';
  container.appendChild(h2);

  const list = doc.createElement('ul');
  for (const app of apps) {
    const li = doc.createElement('li');
    li.textContent = `#/${app.prefix} — ${app.name} (${QuCrypto.toBase64(app.appAdminPub).slice(0, 20)}…)`;
    list.appendChild(li);
  }
  if (apps.length === 0) {
    const li = doc.createElement('li');
    li.textContent = '(noch keine App registriert)';
    list.appendChild(li);
  }
  container.appendChild(list);

  const h2b = doc.createElement('h2');
  h2b.textContent = 'App registrieren';
  container.appendChild(h2b);
  const hint = doc.createElement('p');
  hint.textContent = 'Setzt voraus, dass die App bereits installiert wurde (z.B. über installAppBundle() / demo/install-app-shell-demo.mjs) - hier wird sie nur unter einem Pfad-Präfix eingehängt.';
  container.appendChild(hint);

  const form = doc.createElement('form');
  const prefixLabel = doc.createElement('label');
  prefixLabel.textContent = 'Pfad-Präfix (z.B. "forum"): ';
  const prefixInput = doc.createElement('input');
  prefixInput.name = 'prefix';
  prefixInput.required = true;
  prefixInput.pattern = '[a-z0-9-]+';
  prefixLabel.appendChild(prefixInput);
  form.appendChild(prefixLabel);
  form.appendChild(doc.createElement('br'));

  const pubLabel = doc.createElement('label');
  pubLabel.textContent = 'App-Admin-Pubkey (base64): ';
  const pubInput = doc.createElement('input');
  pubInput.name = 'appAdminPub';
  pubInput.required = true;
  pubInput.size = 48;
  pubLabel.appendChild(pubInput);
  form.appendChild(pubLabel);
  form.appendChild(doc.createElement('br'));

  const nameLabel = doc.createElement('label');
  nameLabel.textContent = 'Name: ';
  const nameInput = doc.createElement('input');
  nameInput.name = 'name';
  nameInput.required = true;
  nameLabel.appendChild(nameInput);
  form.appendChild(nameLabel);
  form.appendChild(doc.createElement('br'));

  const submitButton = doc.createElement('button');
  submitButton.type = 'submit';
  submitButton.textContent = 'Registrieren';
  if (!isAdmin) submitButton.disabled = true;
  form.appendChild(submitButton);

  const status = doc.createElement('p');
  form.appendChild(status);
  container.appendChild(form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    try {
      const appAdminPub = QuCrypto.fromBase64(pubInput.value.trim());
      await registerApp(space, { prefix: prefixInput.value.trim(), appAdminPub, name: nameInput.value.trim() });
      status.textContent = 'Gesendet. Falls du der Relay-Admin bist, ist die App jetzt registriert - Seite neu laden, um die Liste zu aktualisieren.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });

  mountEl.replaceChildren(container);
}

/** @param {{mountEl: Element, doc: Document, platform: import('@qu/app-core').PlatformRuntime}} params - shown when no registered app's prefix matches the current route. */
export async function renderLandingPage({ mountEl, doc, platform }) {
  const apps = await platform.resolveApps({ timeout: 1500 });

  const container = doc.createElement('div');
  container.style.cssText = PAGE_STYLE;

  const h1 = doc.createElement('h1');
  h1.textContent = 'Qu App Shell';
  container.appendChild(h1);

  const p = doc.createElement('p');
  p.textContent = apps.length > 0 ? 'Verfügbare Anwendungen:' : 'Noch keine Anwendung auf dieser Plattform installiert.';
  container.appendChild(p);

  const list = doc.createElement('ul');
  for (const app of apps) {
    const li = doc.createElement('li');
    const a = doc.createElement('a');
    a.href = `#/${app.prefix}/`;
    a.textContent = app.name;
    li.appendChild(a);
    list.appendChild(li);
  }
  container.appendChild(list);

  mountEl.replaceChildren(container);
}
