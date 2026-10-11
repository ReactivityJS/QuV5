# Qu Lite – Umzug in ein eigenes Repository

Diese Anleitung richtet sich an die **nächste Session** (Mensch oder Claude), die
`packages/lite` aus QuV5 in ein neues, eigenes Repository überführt. Sie ist so
geschrieben, dass sie ohne den Chatverlauf der Entwicklungssession funktioniert.

## 1. Ausgangslage

| | |
|---|---|
| Quelle | `https://github.com/ReactivityJS/QuV5`, Verzeichnis `packages/lite` |
| Branch | **`claude/tender-hawking-hlhu1i`** – der Code ist (Stand dieser Anleitung) **noch nicht in `main`** gemergt. Immer diesen Branch lesen, solange kein Merge erfolgt ist. |
| Paket | `@qu/lite` 0.1.0, MIT, Node ≥ 22.5, einzige Laufzeitabhängigkeit `ws` (nur Node) |
| Umfang | ~3.750 Codezeilen ohne optionale Teile (davon ~450 vendored Negentropy), optional ~820 (Text-CRDT, WebRTC, SSE-Fallback); 39 Testdateien, 134 Tests |
| Unabhängigkeit | Teilt **keinen** Code mit dem Rest von QuV5 (kein `@qu/core`, `@qu/events`, Yjs). Es gibt keine Importe außerhalb von `packages/lite`. |

Das Paket ist bereits **eigenständig vorbereitet**: eigenes `package.json` (Skripte,
devDependencies), eigenes `package-lock.json`, `Dockerfile` und `docker-compose.yml`
mit dem Paket als Build-Kontext, `.gitignore`, `.dockerignore`, `LICENSE`,
GitHub-Actions-Workflow (`.github/workflows/test.yml`), `CLAUDE.md` und
`docs/DECISIONS.md`. Ein Probe-Export wurde geklont und dort mit `npm ci` und
`npm test` (134/134 grün, inkl. 2 Playwright-Browser-Tests) geprüft.

## 2. Was überführt wird

**Alles in `packages/lite/` – und nur das.** Es wird zur Wurzel des neuen Repos:

```
.github/workflows/test.yml   CI: Tests (mit Chromium) + Docker-Build
.gitignore  .dockerignore
CLAUDE.md                    Konventionen für Sessions im neuen Repo
Dockerfile  docker-compose.yml
LICENSE                      MIT (+ Hinweis auf src/sync/NEGENTROPY-LICENSE)
README.md                    Überblick, Quickstart, Größe, ein Abschnitt pro Meilenstein
bin/mirror.mjs               Relay/Mirror-CLI (qu-lite-mirror)
demo/                        Browser-Demo (index.html, app.js, build.mjs)
docs/DECISIONS.md            Anforderungen und Designentscheidungen
package.json  package-lock.json
src/                         der Code
test/                        node:test-Suites + Playwright-E2E
```

**Nicht** überführt werden (bleiben in QuV5 oder entfallen):

- `docker-compose.lite.yml` im QuV5-Root (ersetzt durch `docker-compose.yml` im Paket)
- die Root-Skripte `lite:mirror` / `lite:demo` in QuV5s `package.json` (ersetzt durch `npm run mirror` / `npm run demo`)
- `scripts/export-lite.sh` (Werkzeug für genau diesen Umzug)
- diese Anleitung

## 3. Weg A – mit Git-Historie (empfohlen)

Erhält alle Commits, die `packages/lite` betreffen (Meilensteine 1–12 und die
Vorbereitung), mit Autoren und Nachrichten.

Voraussetzung: ein **vollständiger** (nicht flacher) Clone von QuV5 und
Schreibzugriff auf das neue Repo.

```sh
git clone https://github.com/ReactivityJS/QuV5 quv5 && cd quv5
git fetch origin claude/tender-hawking-hlhu1i
git checkout claude/tender-hawking-hlhu1i
git fetch --unshallow 2>/dev/null || true      # falls doch flach geklont

# erzeugt den Branch lite-standalone (packages/lite als Wurzel, mit Historie)
scripts/export-lite.sh
# … und pusht ihn als main ins neue Repo:
scripts/export-lite.sh https://github.com/ORG/NEUES-REPO.git
```

Ohne das Skript (identisch): `git subtree split --prefix=packages/lite -b lite-standalone`
und `git push <neue-url> lite-standalone:main`.

**In einer Claude-Code-Cloud-Session**, die im neuen Repo läuft und QuV5 nur lesen
kann: QuV5 als zusätzliches Repo anhängen (lesend), vollständig klonen, den Split
dort erzeugen und dann **im neuen Repo** übernehmen:

```sh
# im Arbeitsverzeichnis des neuen Repos
git remote add quv5 /pfad/zum/quv5-clone          # lokaler Pfad des QuV5-Clones
git fetch quv5 lite-standalone
git merge --allow-unrelated-histories quv5/lite-standalone   # leeres neues Repo: oder reset --hard
git remote remove quv5
```

Ist das neue Repo noch leer (nur ggf. eine README/LICENSE vom Anlegen), ist
`git reset --hard quv5/lite-standalone` sauberer als ein Merge; danach normal
pushen (bei bereits vorhandenen Commits im neuen Repo: Force-Push nur nach
Rücksprache).

## 4. Weg B – ohne Historie (Fallback)

Wenn ein Split nicht möglich ist (z. B. nur flacher Zugriff):

```sh
cp -r quv5/packages/lite/. neues-repo/        # inkl. versteckter Dateien (.github, .gitignore, .dockerignore)
cd neues-repo && rm -rf node_modules demo/dist
git add -A && git commit -m "Import Qu Lite from QuV5 (packages/lite @ <commit>)"
```

Im Commit den QuV5-Commit-Hash nennen, von dem kopiert wurde
(`git -C quv5 rev-parse HEAD`), damit die Herkunft nachvollziehbar bleibt.

## 5. Prüfen im neuen Repo

```sh
npm ci                         # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, wenn Chromium schon vorhanden ist
npm test                       # erwartet: 134 pass, 0 fail
npm run test:unit              # ohne die 2 Browser-Tests
npm run demo                   # http://localhost:8787/?name=alice und ?name=bob
docker compose up --build      # gleiche Demo im Container (Kontext = Repo-Wurzel)
```

Hinweise:

- Die Browser-Tests (`test/demo.e2e.test.js`) suchen Chromium über Playwright, dann
  `$QU_CHROMIUM`, dann `/opt/pw-browsers/chromium`; ohne Browser werden sie übersprungen.
  In der CI installiert `npx playwright install --with-deps chromium` ihn.
- Ein Status-Test (`status.test.js`, „newcomer … visible both ways“) ist zeitkritisch
  (3 s) und kann unter starker Last selten scheitern; einzeln läuft er stabil.
- `node:sqlite` gibt unter Node 22 eine ExperimentalWarning aus – erwartet.
- Wurde die CI im neuen Repo aktiviert: der erste Lauf muss grün sein (Tests + Docker-Build).

## 6. Danach anpassen (im neuen Repo)

- [ ] **Repository-Metadaten** in `package.json`: `repository`, `homepage`, `bugs` ergänzen.
- [ ] **Paketname** entscheiden: `@qu/lite` behalten oder neuer Name/Scope (vor einer npm-Veröffentlichung). Bei Umbenennung: `package.json`, README-Importe (`from '@qu/lite'`), Kommentare in `src/node.js`, `src/peer.js`, `src/drivers/sqlite.js`, `src/net/ws-server.js`, `demo/build.mjs`.
- [ ] **LICENSE**: Copyright-Inhaber steht als „the Qu Lite authors“ – ggf. durch Person/Firma ersetzen.
- [ ] README-Satz „Started as `packages/lite` in QuV5“ ggf. um den Link auf QuV5 ergänzen.
- [ ] Optional: Text-CRDT (`src/text.js`) als „Extra/Demo“ kennzeichnen oder nach `src/extras/` verschieben (Code und Bundle-Größe ändern sich dadurch nicht; er wird nur gebündelt, wenn importiert).

## 7. Danach in QuV5 aufräumen (eigene Änderung in QuV5)

Erst, wenn das neue Repo steht und grün ist:

- [ ] `packages/lite/` entfernen **oder** durch eine kurze `README.md` mit Verweis auf das neue Repo ersetzen.
- [ ] `docker-compose.lite.yml` entfernen.
- [ ] Root-`package.json`: Skripte `lite:mirror` und `lite:demo` entfernen; `npm install` im Root ausführen, damit `package-lock.json` den Workspace nicht mehr enthält.
- [ ] `scripts/export-lite.sh` und diese Anleitung entfernen (oder als Historie behalten).
- [ ] QuV5-Tests laufen lassen (`npm test` im Root) – sie hängen nicht von `packages/lite` ab.

## 8. Wo was steht (für den Einstieg)

| Thema | Datei |
|---|---|
| Überblick, API-Beispiele, ein Abschnitt pro Meilenstein | `README.md` |
| Warum es so gebaut ist, Anforderungen, Grenzen | `docs/DECISIONS.md` |
| Arbeitsweise im Repo (Tests, Commits, Stil) | `CLAUDE.md` |
| Kernel / Bus / Mounts | `src/qu.js`, `src/bus.js`, `src/mount.js` |
| Umschlag, Spaces, Grants | `src/envelope.js`, `src/space.js` |
| Blind-Layer (alle Peers + Mirror) | `src/envelopes.js`, `src/gc.js` |
| Lesen/Schreiben, Indexe, Tombstones | `src/records.js`, `src/writeset.js` |
| Sync (Negentropy, Outbox, Pending) | `src/sync/sync.js`, `src/sync/negentropy.js` |
| Mitglieder, User-Node, Inbox, Status | `src/members.js`, `src/user.js`, `src/inbox.js`, `src/signals.js`, `src/status.js` |
| Löschen/Kompaktieren | `src/compaction.js` |
| Mirror, Limits | `src/mirror.js`, `src/limits.js`, `bin/mirror.mjs` |
| Transporte | `src/net/*` (link, ws, ws-server, sse*, relay, webrtc, topology, inproc) |
| Optional: Text-CRDT | `src/text.js` |
