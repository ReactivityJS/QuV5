# QuV5 vs. QuV3 — Architekturvergleich & Entscheidung (kein QuV6)

> Status: Entscheidungsdokument, Stand 2026-09-13. Grundlage für Folge-Arbeitspakete; als Living-Doc neben `architecture.md` gedacht — bei größeren Architektur-Änderungen hier nachziehen.

## Ausgangsfrage

Beim Arbeiten in QuV5 (u. a. an einer Chat-App) entstand der Eindruck, dass beim Wechsel von QuV3 (QuBit/Peer/Mountpoint-Modell, flacher signierter Log-Sync) zu QuV5 (Yjs-CRDT-Sync) zentrale Architekturideen verloren gegangen sind — insbesondere das Actions/Slots-Hook-System, die Peer-Abstraktion, Mountpoints und das flache QuBit-Datenmodell. Daraus die Grundsatzfrage: Braucht es ein QuV6? Sollte Yjs infrage gestellt werden? Zurück zu QuV3?

**Ergebnis der Analyse:** Die Lage ist deutlich besser als der erste Eindruck. Die meisten "verlorenen" Konzepte wurden entweder bewusst und sauber nach QuV5 portiert (teils sogar verbessert), oder sie existierten in QuV3 nie exakt so, wie in Erinnerung. Es gibt aber zwei echte, klar behebbare Lücken.

**Entscheidung: Kein QuV6, keine Rückkehr zu QuV3.** Stattdessen gezieltes Nachrüsten von QuV5 (sechs Arbeitspakete, siehe unten).

## Methodik

Drei Code-Explorationen wurden durchgeführt:
1. QuV5-Kernarchitektur (Peer/QuBit/Space/ACL/Mountpoint/Adapter-Konzepte im aktuellen Code).
2. QuV5-Event-/Sync-/UI-Schicht (EventBus, Yjs-Datenfluss, Actions/Slots-Nutzung).
3. QuV3-Referenzarchitektur (Repo `ReactivityJS/QuV3`, read-only geklont zum Vergleich).

## Gegenüberstellung

| Bereich | QuV3 | QuV5 (heute) | Bewertung |
|---|---|---|---|
| **Peer-Abstraktion** | Keine literale gemeinsame `Peer`-Klasse; aber **eine** `SyncEngine`-Klasse (`packages/sync/src/sync-engine.js`) läuft symmetrisch auf Client *und* Relay (nur andere Transport/Options) → Peer ist eine Rolle, kein Typ | `Space` (Client, `space-core/src/space.js`) und `Relay` (`space-transport/src/relay.js`) sind komplett getrennte Klassen, kein gemeinsamer Code-Pfad mehr | **Echter, aber kleinerer Verlust** als gedacht — QuV3 hatte auch keine echte Peer-Klasse, nur symmetrischen Code. QuV5 hat diese Symmetrie aufgegeben. |
| **Datenmodell** | `QuBit {path, val, ts, pub, sig}` (`packages/core/src/qubit.js`) — flaches, 5-Felder-JSON, Signatur über Klartext-Hash | `Node` = `Y.Doc`, `Field` wrapt `Y.Map/Text/XmlFragment/Array` (`space-core/src/node.js`, `field.js`); QuBit explizit entfernt (Kommentar im Code verweist ausdrücklich auf die Ablösung) | **Bewusster Trade-off**, kein Fehler: Yjs ermöglicht echtes konfliktfreies Merging (z. B. Rich-Text), das ein flacher LWW-Log strukturell nicht kann. Kostet: Debugbarkeit/Query-Fähigkeit von JSON, binäre Updates. |
| **User/Space + pub/epub** | Kein literales "User = Space mit alias/pub/epub". Tatsächlich: `Actor` (Ed25519+X25519-Keypair, HD-derived über `packages/identity/src/identity.js`), `Space` = reine Pfad-Namespace-Konvention. `pub` + `xPublicKey` (≈ epub) werden in einem signierten Profil publiziert. | `Space` = "Peer-Sicht auf Nodes + Transport/Storage"; Identität separat über `alias.js`/`identity.js` in `app-shell`/`space-core` | Das ursprünglich angenommene "User=Space+alias/pub/epub"-Muster (eher GunDB/SEA-Stil) gab es **so auch in QuV3 nicht 1:1** — die Erinnerung weicht leicht vom tatsächlichen Code ab. In beiden Basen sauber nachrüstbar. |
| **ACL** | An Pfad-Konvention gebunden (`/store/<space>/acl/<kind>/<id>`, `packages/engines/src/access-engine.js`), global vor anderen Engines geprüft | An **Kind-Schema** gebunden (`kind-schema.js`, `ACL_MODES`), client- **und** relayseitig durchgesetzt | **Verbesserung** in QuV5 — strukturierter, Schema+ACL zusammen ist eine bessere Grundlage für spätere Views. |
| **Mountpoints / Adapter (Pfad→Adapter)** | `QuMount.resolve(path)` (`packages/core/src/mount.js`): erstes Pfadsegment wählt den Adapter (`store`/`blob`=persistent, `event`/`net`=volatile, `temp`=memory, `session`/`local`) — generische, durchgängige Konvention | **Komplett entfernt.** Storage-Adapter (memory/durable/file/indexeddb, `space-storage`) existieren noch, aber es gibt keine generische Pfad→Adapter-Registry mehr; Transports/Storages werden ad hoc im App-Bootstrap-Code verdrahtet | **Echter, unkompensierter Verlust.** |
| **Sync-Mechanik** | Signierter Flat-Log, Replikation via `SyncEngine` + `Outbox` (`packages/sync/src/outbox.js`), Konfliktlösung explizit LWW-by-timestamp | Yjs-CRDT-Updates, subscribe-basiert (Relay verfolgt Subscriber pro Node), Resync-on-Reconnect statt Diff-Protokoll (da Yjs-Updates idempotent replaybar sind) | Sync-Philosophie (subscribe statt Polling, Offline-first, lokal-zuerst) ist **konsistent fortgeführt**; nur der Konfliktlösungs-/Datenformat-Layer wurde ausgetauscht. |
| **Events** | Zwei getrennte Busse: `QuEvents` (lokal, auch hinter `/net`-Mount für Remote) + `HookBus` (`packages/foundation/src/hooks.js`, rein in-process, nie netzwerkübergreifend) | **Eine** `EventBus`-Klasse (`packages/events/src/event-bus.js`), explizit als bewusste Verschmelzung beider QuV3-Busse dokumentiert, mit `emit`/`run` (Pipeline-Transform) /`collect` (Gather-Results) + Wildcard-Topics (`*`, `**`) | **Verbesserung** — sauberer als QuV3, nicht verloren. |
| **Actions/Slots (Hook-System)** | `actions[]` (Daten-Slots) + `contributes[]`/`ExtensionPointHost` (Code-Slots, `packages/foundation/src/extension-points.js`): **31 Deklarationen in 10 von 19 Apps, 26 Call-Sites in 8 Dateien** — treibt Message-Kontextmenü, Composer-„+“-Menü, Room-Menü, App-übergreifende Suche, Referenz-Auflösung, User-Settings-Panels. Der eigentliche Clou: Reactions/Pins/Bookmarks/Calendar klinken sich ein, ohne dass Chat/Forum sie kennen. | `ExtensionPointHost` **1:1 als Klasse portiert** (`packages/extensions/src/extension-points.js`, Code-Kommentar verweist explizit auf QuV3-Herkunft), aber Nutzung auf **1 Contributor + 1 Consumer** (Admin-Sections, eine CMS-Action-Liste) zusammengeschrumpft. Keine der Bundles (Blog/Forum/Guestbook/Chat) speist noch in Slots ein. | **Die eigentliche, größte Regression** — aber ein reines Verdrahtungs-Problem, kein Architekturproblem. Die Maschine steht, sie wird nur nicht mehr benutzt. |
| **Adapter allgemein** | Formalisiert pro Konzern: Storage duck-typed über `QuMount`, Transport über abstrakte `Transport`-Klasse — zwei parallele, aber klare Konventionen | Storage-Adapter faithfully erhalten; generische Transport-/Pfad-Adapter-Abstraktion fehlt | Teilverlust, siehe Mountpoint-Zeile oben. |

## Entscheidung im Detail: Kein QuV6, kein Zurück zu QuV3

QuV5 ist architektonisch überwiegend gesund und in Teilen (Events, ACL/Schema-Bindung) sogar besser als QuV3. Ein Rewrite würde die echten Verbesserungen (Yjs-Merge-Semantik, saubere EventBus, Schema+ACL) wegwerfen, um zwei Lücken zu schließen, die sich additiv nachrüsten lassen.

## Arbeitspakete (Empfehlung, priorisiert)

1. **Actions/Slots reaktivieren** (höchster Impact, geringster Aufwand). Die QuV3-Slot-Namen und Call-Sites (`content.messageFooter`, `content.messageMenu`, `content.composerActions`, `content.search`, `content.resolveReference`, `userSettings.contributions`, …) als Referenzmuster in die QuV5-Bundles (Chat/Forum/Blog/Guestbook) zurückverdrahten. Das ist der Hebel, der Plugin-Komposition (Reactions/Pins/Bookmarks/Calendar) in QuV5 wiederherstellt.
2. **Mountpoint/Adapter-Registry wieder einführen.** Dünne generische Schicht über dem bestehenden Space/Transport/Storage-Split, die Pfade explizit auf Adapter mappt (analog `QuMount`) — macht Verdrahtung deklarativ statt ad hoc im Bootstrap-Code.
3. **Sync-Modus pro Kind-Schema wählbar machen.** Nicht jedes Datenmodell braucht CRDT-Overhead. Yjs bleibt für Felder mit echtem Merge-Bedarf (Rich-Text, gemeinsame Listen); für einfache LWW-Daten (Presence, Blog-Posts, einzelne Werte) einen leichtgewichtigen Flat-Log-Adapter (QuV3-Stil: signiert, `ts`-LWW) als **Alternative hinter derselben Schema-Schnittstelle** anbieten. Antwort auf die offene "Yjs raus oder Adapter"-Frage: **Yjs bleibt, wird aber zur austauschbaren Option statt Kernannahme.**
4. **Peer-Rolle konzeptionell festschreiben** (nicht zwingend als Klasse). Ein gemeinsames Lifecycle-Interface für Space und Relay dokumentieren/idealerweise einführen, im Sinne von QuV3s symmetrischer SyncEngine-Nutzung — für spätere Portabilität (z. B. Mesh/WebRTC-Peers).
5. **User/alias/pub/epub-Semantik einmal sauber entscheiden und bauen** — aufbauend auf den vorhandenen `alias.js`/`identity.js`-Bausteinen in QuV5, statt in QuV3 zurückzugreifen (dort existierte es auch nicht exakt in der gewünschten Form).
6. **Drupal-Views-Ambition.** QuV5s Kind-Schema+ACL-Bindung ist eine *bessere* Grundlage für eine spätere Views-artige Query-/Listen-Schicht als QuV3s schemalose Pfadkonvention — als QuV5-Erweiterung einplanen, kein Rückkehr-Argument.

Die Arbeitspakete sind unabhängig voneinander beauftragbar. Empfohlene Reihenfolge: 1 → 2 → 3, da 1 den größten sofortigen Nutzen mit geringstem Risiko bringt; 4–6 sind mittelfristig.

## Referenzen

- QuV5-Repo: `ReactivityJS/QuV5` (dieses Repo), insb. `packages/space-core`, `packages/space-transport`, `packages/events`, `packages/extensions`, `packages/app-shell`.
- QuV3-Repo: `ReactivityJS/QuV3`, insb. `packages/core` (QuBit/Store/Mount/Crypto/Events), `packages/sync` (SyncEngine/Outbox/Transport), `packages/foundation` (Actions/ExtensionPointHost/HookBus), `packages/engines/access-engine.js`, `packages/identity`.
