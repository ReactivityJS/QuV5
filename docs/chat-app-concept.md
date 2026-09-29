# Messenger/Chat — Konzept

Antwort auf den Wunsch nach einer Telegram/Signal/WhatsApp/Tinode-artigen
Chat-App: Text, Bilder mit Lightbox, Video/Audio mit Player, Datei-Upload
mit Status (lokal/synced/gelesen), Zugestellt-/Gelesen-Haken, Typing- und
Online-Anzeige. Dieses Dokument ist **das Konzept** (Schritt 1 von 3:
Konzept → Framework erweitern → Chat bauen) - keine der hier
vorgeschlagenen Kind-Schemas/Erweiterungen ist bereits implementiert.

## Entschiedene Punkte

- **Nachrichten-Modell**: ein `ListField` PRO CHAT (nicht ein globales
  `sharedListKind` wie im einfachen öffentlichen Beispiel in
  `docs/example-apps.md` §4) - einfacher, robust genug für v1.
- **Umfang**: 1:1 UND Gruppen-Chats von Anfang an.
- **Mitgliedschaft lebt in einer echten `groupKind`-Group, nicht in einem
  privaten `participants`-Feld auf `chatKind` selbst** (Nachtrag - ursprünglich
  war `participants` als eigenes verschlüsseltes Feld auf `chatKind` geplant,
  siehe §2 für die Begründung des Wechsels: Mitglieder-ENTFERNEN braucht einen
  lebendigen, widerrufbaren Mitgliedschafts-Check, den ein statisches Feld +
  `grantWriter()` nicht bietet).
- **Mitglieder hinzufügen UND entfernen, wirksam AB DEM ZEITPUNKT der
  Änderung, OHNE bestehende Daten anzufassen** (Nachtrag, User-Entscheidung):
  kein Neuverschlüsseln der Historie bei Mitgliederwechsel - deckt sich
  1:1 mit dem bereits bestehenden, bereits getesteten `groupKind`/
  `privatePageKind`-Verhalten (siehe nächster Punkt), erfordert also KEINE
  neue Krypto-Arbeit, nur einen widerrufbaren Schreibzugriff (§2/Phase 2
  Punkt 5).
- **Verschlüsselung**: echtes Ende-zu-Ende, `recipients`-beschränkt auf die
  aktuellen Teilnehmer - inkl. der bewussten Einschränkung, dass ein
  später hinzugefügtes Gruppenmitglied die Historie davor NICHT
  rückwirkend lesen kann, UND dass ein entferntes Mitglied bereits
  empfangene/entschlüsselte Nachrichten nicht "vergisst" (echtes
  E2E-Verhalten, keine zu behebende Lücke - siehe `architecture.md`s
  eigene "Not retroactive, by design" Passage zu `groupKind`/
  `privatePageKind`, `group-private-content.test.js` beweist das bereits
  Ende-zu-Ende).
- **Freigabe alter Historie für ein NEUES (oder wieder-hinzugefügtes)
  Mitglied - bewusst NICHT Teil dieses Konzepts, und bewusst NICHT
  Framework/Core-Arbeit** (Nachtrag, User-Entscheidung): braucht keinen
  neuen Framework-Mechanismus - ein bereits berechtigtes Mitglied kann die
  Historie (die es ja selbst lesen kann) jederzeit als App-Feature erneut
  mit einer erweiterten Empfängerliste "weiterreichen" (ein gewöhnlicher
  Re-Write mit neuen `recipients`, dieselbe Grundoperation, die
  `editPrivatePage()` heute schon anbietet - kein neues Primitiv). Ob/wie
  eine App das für ehemalige Mitglieder anbietet, ist eine App-Policy-
  Entscheidung, keine Core-Frage - siehe Phase 4/`@qu/extensions` für die
  gleiche "App-Ebene, nicht Core" Haltung bei Reaktionen/Antworten.
- **Raum-Adressierung**: `#/<app-prefix>/<raumId>/` (verschachtelt unter der
  Chat-App, wie Forums `#/forum/topic/123`), NICHT eine neue flache
  Top-Level-Route `#/<raumId>/` (wie der bestehende Bare-Pubkey-Fallback für
  Nutzer/Apps) - siehe §2a für die Begründung. Ein Raum ist dabei technisch
  KEINE zweite `Space`-Instanz (die bleibt 1:1 an eine Relay-Verbindung
  gebunden) - "Raum" heißt hier: eine eigene, self-certifying Node-Adresse
  innerhalb derselben, bereits verbundenen Space, exakt wie jede andere
  App-eigene Route auch.
- **Zugestellt-Status**: wird als eigener Zwischenzustand (zwischen
  "gesendet" und "gelesen") mit aufgenommen.
- **Blob-Storage**: dreistufiges Modell - lokal → Relay (der Relay wirkt
  als durables Storage-Mirror, genau wie er es für strukturierte
  CRDT-Daten bereits tut) → von dort aus weiter zu jedem Empfänger
  synchronisiert. Kein externer Objektspeicher für v1.
- **Online/Offline**: echte Live-Verbindung, nicht nur der
  selbstgemeldete Wert - UND zusätzlich eine GLOBALE, profilweite
  Sichtbarkeit (nicht nur "online in diesem einen Chat"), mit einer
  Privatsphäre-Einstellung (öffentlich sichtbar vs. nur für Kontakte/
  Chat-Teilnehmer).
- **Reaktionen, Antworten/Zitieren, Anheften (Pin) usw.**: bewusst NICHT
  Teil des Kern-Nachrichtenmodells - werden SPÄTER über das bestehende
  Slots/Actions-System (`@qu/extensions`, siehe §5) nachgerüstet, damit
  der Chat-Kern schlank bleibt und diese Features optional/erweiterbar
  sind statt fest eingebacken.
- **Nachrichtenform**: robust und erweiterbar gestalten (siehe §2) - kein
  starres, geschlossenes Schema, das bei jedem neuen Feature (Reaktion,
  Zitat-Referenz, ...) angefasst werden muss.

## 1. Bestandsaufnahme - was schon da ist

Vier Bausteine existieren bereits und werden wiederverwendet, kein neues
Rad:

- **`presenceKind`** (`packages/space-core/src/presence.js`) - `online`
  (selbstgemeldet), `status`, `updatedAt`, **`typingIn`/`typingAt`** (zeigt
  auf eine Node-Id). `setTyping(space, chatNodeId, true/false)` existiert
  schon - Typing-Indikatoren sind also KEINE neue Framework-Arbeit, nur
  Chat-UI, die es abonniert.
- **`PresenceTracker`** (`packages/space-transport/src/presence-tracker.js`)
  - die ECHTE "wer hat gerade eine offene Verbindung"-Information, aber
  bisher rein relay-intern (nur für Push-Routing genutzt), für Clients
  nicht abonnierbar. **Muss für "echtes" Online/Offline erweitert werden
  (Phase 2, Punkt 1) - jetzt zusätzlich mit einer profilweiten, privaten
  ODER öffentlichen Sichtbarkeitsoption.**
- **`readReceiptKind`** (`packages/space-core/src/delivery-status.js`) -
  generisches "gelesen bis X"-Muster (`markRead()`/`watchReadReceipts()`),
  bereits genutzt für Datei-Empfangsbestätigungen. Direkt wiederverwendbar
  für "Nachricht gelesen", plus die neue `deliveredUpTo`-Erweiterung.
- **`UploadOutbox`** (`packages/space-plugins/src/upload-outbox.js`) -
  Zustandsautomat `pending → uploading → done → synced` (+ `failed` mit
  Retry), lokale Warteschlange, bereits an generische DOM-Bindings
  gekoppelt (`@qu/space-ui`s `bindFileInput()`/`bindUploadStatusIcon()`).
  Kennt aber **kein Ergebnis-Feld** für die fertige Datei (z.B. eine URL)
  und **kein Blob-Storage-Backend** - beides fehlt noch (Phase 2, Punkte 2+3).
- **`groupKind`/`privatePageKind`** (`packages/app-core/src/kinds.js`) -
  das Muster für "eine Node, die nur bestimmten Personen gehört/lesbar
  ist": `acl.write: 'content'` (selbstzertifizierend, Owner kann gezielt
  `grantWriter()` an weitere Identitäten vergeben) + `visibility:
  'encrypted'` Felder + optional `recipients` beim Schreiben (verschlüsselt
  dann NUR für die genannten Empfänger, nicht die ganze Space). Das ist der
  fehlende Baustein für **private 1:1-/Gruppen-Chats** (siehe Datenmodell) -
  `groupKind` ist dabei nicht nur die Empfänger-QUELLE fürs Verschlüsseln,
  sondern (Nachtrag) auch die MITGLIEDSCHAFTS-Quelle des Raums selbst, siehe
  §2a: `editGroup()` (bereits vorhanden, `dev.js`) ersetzt die ganze
  Mitgliederliste wholesale - "jemanden entfernen" ist damit bereits ein
  einziger, bestehender Aufruf; was NOCH fehlt, ist NICHT die
  Mitgliederverwaltung selbst, sondern ein Weg, den Nachrichten-Schreibzugriff
  LIVE gegen die jeweils aktuelle Gruppenmitgliedschaft zu prüfen, statt
  gegen einen (laut `grant.js`s eigenem Doc-Kommentar bewusst NICHT
  widerrufbaren) `grantWriter()`-Grant - siehe §2a.
- **`ListField`** (`packages/space-core/src/field.js`) - Anhängen ist
  konfliktfrei per Yjs-CRDT, `observe()` liefert Live-Updates ohne Polling,
  `slice()` erlaubt "letzte N Nachrichten"-artiges Lesen. Passt gut als
  Nachrichten-Log pro Chat.
- **`@qu/extensions`' `ExtensionPointHost`** (`packages/extensions/src/
  extension-points.js`) - `contribute(point, {id, handler, ...})`/
  `collect(point, context)`/`renderSlot()` - das V3-Slots/Actions-Prinzip,
  bewusst klein gehalten, aktuell 2 Verwender (`admin-sections.js`,
  `cms-actions.js`s `cms.pageActions`). Genau das richtige Werkzeug für
  Reaktionen/Antworten/Pin als SPÄTERE, optionale Erweiterungspunkte pro
  Nachricht (`chat.messageActions` o.ä.), statt sie ins Kern-Schema zu
  gießen.
- **Die einfachste Referenz** (`docs/example-apps.md` §4, `demo/chat.mjs`)
  - ein rein öffentlicher Ein-Kanal-Chat ohne Presence/Receipts/Medien.
  Guter Kind-Schema-Ausgangspunkt, aber zu simpel für das hier Gewünschte.

**Komplett neu** (existiert nirgends im Repo): Bild-/Video-/Audio-Anhänge,
Lightbox, Player, Zugestellt-Status, "Bildschirm an halten bis synced",
profilweite Online-Sichtbarkeit, Relay-als-Blob-Mirror.

## 2. Datenmodell (Vorschlag)

### `chatKind` (Konversation)
```
acl: { write: 'group' }     // NEU (§2a) - selbstzertifizierend wie 'content', aber Mitgliedschaft
                             // wird LIVE gegen eine groupKind-Group geprüft, nicht per statischem
                             // Grant - das ist, was "Mitglied entfernen" überhaupt möglich macht.
fields:
  kind:         atomic, public      // '1:1' | 'group'
  name:         atomic, encrypted   // nur bei Gruppen relevant - RAUM-DISPLAYNAME, nicht die Raum-ID
  groupOwnerPub: atomic, public     // wer die zugehörige groupKind-Group besitzt (i.d.R. der Ersteller)
  groupName:     atomic, public     // der Name/Pfad-Schlüssel dieser Group, siehe §2a - ZUSAMMEN mit
                                     // groupOwnerPub die einzige Quelle der Wahrheit für "wer ist
                                     // gerade dabei", nie ein eigenes participants-Feld hier
  messages:     list,   encrypted   // siehe unten
  createdAt:    atomic, public
```
`participants` (ursprünglicher Entwurf) entfällt als eigenes Feld -
Mitgliedschaft lebt ausschließlich in der referenzierten `groupKind`-Group
(`ContentResolver.resolveGroup()` liest sie zurück), damit es genau EINE
Quelle der Wahrheit gibt, die auch für Verschlüsselungs-`recipients` UND
den neuen `'group'`-Schreibzugriffs-Check gleichermaßen genutzt wird.

### §2a. Mitglieder hinzufügen/entfernen - der neue Baustein

Der EINE Mechanismus, der noch nicht existiert (alles andere in diesem
Dokument ist bereits vorhandenes Framework-Primitiv): ein Kind-Schema-ACL-
Modus, dessen Schreibzugriff nicht gegen eine feste, boot-zeit-konfigurierte
Liste (wie `'members'`/`'relay-admins'` heute) oder einen unwiderruflichen
Grant (wie `'content'`/`'named'` heute, `grant.js`s eigener Kommentar:
"Revocation is deliberately out of scope here") geprüft wird, sondern gegen
die AKTUELLE Mitgliederliste einer benannten `groupKind`-Group:

- **Neuer ACL-Modus `'group'`** (`kind-schema.js`s `ACL_MODES`, sechster
  Eintrag neben `owner`/`named`/`content`/`members`/`relay-admins`).
- **Scope-Deklaration bei Erstellung** - dieselbe Notwendigkeit, die
  `'content'`-Modus bereits hat (ein `nodeId` lässt sich nicht zurück in
  seinen `path` umkehren, siehe `kind-schema.js`s eigener Kommentar) - ein
  `chatKind`-Node braucht beim Erstellen eine signierte, verifizierbare
  Erklärung "dieser Node gehört zu Group `(groupOwnerPub, groupName)`",
  analog zum bereits bestehenden transparenten Self-Grant, den
  `Space.createNode()` für `'content'`-Kinds ausstellt (`space.js` Zeile
  ~552). Relay UND Space (nie nur der Relay, gleiche "nie blind vertrauen"
  Haltung wie überall sonst) halten das in einer neuen, zu `_grants`
  parallelen Map (`nodeId -> {groupOwnerPub, groupName}`).
- **Live-Mitgliedschafts-Cache statt Lookup pro Schreibvorgang** - ein
  Membership-Check bei JEDEM Write direkt gegen die Group-Node zu lesen
  wäre teurer als der heutige O(1)-Set-Check. Empfehlung: derselbe
  "live-watched Registry"-Ansatz, den `live-app-resolver.js` für
  `qu-platform-apps` bereits nutzt - eine referenzierte Group wird einmal
  abonniert, ihr aktueller Mitgliederstand lokal gecacht, invalidiert über
  ihr eigenes `changed`-Event. Explizit vom User bestätigt: ein gewisses
  zeitliches Nachziehen beim Entfernen ist akzeptabel ("könnte eine Zeit
  gecacht werden") - ein einfacherer periodischer Refresh (statt
  Event-getrieben) ist als Fallback ausreichend, falls der Live-Watch-Ansatz
  für v1 mehr Aufwand wäre als gerechtfertigt.
- **Kein Einfluss auf bestehende Nachrichten-Verschlüsselung** - `recipients`
  beim Schreiben einer Nachricht wird weiterhin aus der Group zum
  Schreibzeitpunkt gelesen (bereits bestehendes `resolveGroup()`-Verhalten,
  "nicht rückwirkend", siehe oben) - der neue ACL-Modus entscheidet NUR, WER
  überhaupt schreiben darf, nicht FÜR WEN verschlüsselt wird. Beides bleibt
  bewusst getrennt (derselbe Split, den `kind-schema.js` schon immer macht:
  Schreib-ACL und Lese-Sichtbarkeit sind unabhängige Achsen).
- **Umfang der Arbeit**: `kind-schema.js` (`ACL_MODES` + Doku),
  `space.js`s `_isAuthorizedWriter()` (Client-Spiegel, inkl. Live-Watch
  eigener referenzierter Groups), `relay.js`s `buildWriteAcl()`
  (Server-Durchsetzung + Live-Cache), plus die neue Scope-Deklaration
  selbst (ähnlich `grant.js`, eigene kleine Signaturnachricht). Reale,
  nicht-triviale Framework-Arbeit, vergleichbar zur bereits bestehenden
  `grant`/`'content'`-Mechanik - kein kleiner Zusatz, aber auch kein neues
  Konzept (reine Erweiterung eines bereits fünfmal bewährten Musters).

### Nachrichtenform - bewusst robust/erweiterbar
Jedes Element im `messages`-`ListField` ist ein flaches, offenes Objekt -
KEIN geschlossenes, versioniertes Schema, damit spätere Erweiterungen
(Reaktionen, Zitat-Referenzen, Bearbeitungs-Historie, ...) additiv
ergänzt werden können, ohne bestehende Nachrichten zu invalidieren
(dieselbe "unbekannte Felder werden einfach ignoriert/durchgereicht"-
Haltung, die andere Kind-Schemas in diesem Repo bereits für ihre eigenen
optionalen Felder verwenden, z.B. `platformAppsKind.config`):
```
{
  id: string,                // client-generierte UUID - Referenz-Anker für
                              // Read-Receipts UND spätere Slots-Erweiterungen
                              // (Reaktionen/Antworten hängen sich an DIESE id)
  from: string,               // Absender-Pubkey (base64)
  type: string,                // 'text' | 'image' | 'video' | 'audio' | 'file' | ...
                                // (offen für künftige Typen, kein enum im Schema selbst)
  text: string | null,
  attachment: {                // nur bei type != 'text', siehe §3 Punkt 3
    fileId, name, mimeType, size, url,
    width, height,             // Bilder/Video
    duration,                  // Video/Audio
  } | null,
  sentAt: number,
  // Absichtlich KEIN "replyTo"/"reactions"/"pinned" Feld hier - siehe
  // Entscheidung oben: kommt später additiv über @qu/extensions' Slots
  // (ein Contribution-Point "chat.messageActions"/"chat.messageDecoration",
  // der zusätzliche, pro-Nachricht gespeicherte Daten in EIGENEN,
  // separaten Feldern/Kinds ablegt, referenziert über die Nachrichten-`id`
  // oben - der Chat-Kern muss diese Erweiterungen nie kennen).
}
```
**Verschlüsselung**: `messages` ist `visibility: 'encrypted'`, jeder
`push()` mit `recipients: (await resolveGroup(groupOwnerPub, groupName)).members`
(nur für die zu diesem Zeitpunkt aktuellen Gruppenmitglieder, frisch
aufgelöst bei JEDEM Push, nie gecacht/mitgeführt) - siehe "Entschiedene
Punkte" oben zur Nicht-Rückwirkung, und §2a zum davon unabhängigen
`'group'`-Schreibzugriffs-Check.

### Zugestellt/Gelesen
- **Gelesen**: `readReceiptKind` direkt wiederverwenden -
  `markRead(space, {contentNodeId: chatId, upTo: messageId})` pro Chat-
  Teilnehmer. Existiert vollständig, keine Framework-Arbeit nötig.
- **Zugestellt** (WhatsApp: ein grauer Haken, sobald das Gerät die
  Nachricht empfangen, aber noch nicht gelesen hat) - **existiert noch
  nicht** als eigener Zustand. `readReceiptKind` wird um ein zweites Feld
  `deliveredUpTo` erweitert (gleiche Struktur wie `upTo`, geschrieben
  sobald der Client die Nachricht empfangen UND lokal gespeichert hat,
  unabhängig vom tatsächlichen Lesen). Kleine, additive Erweiterung eines
  bestehenden Kinds (Phase 2, Punkt 4).

### Typing & Online
- **Typing**: `setTyping(space, chatId, true)` beim Tippen im Composer,
  automatisches Timeout (z.B. 3s ohne Tastendruck → `false`) - reine
  Chat-UI-Arbeit, keine Framework-Änderung.
- **Online (pro Chat UND profilweit)**: zwei Ebenen.
  1. Echte Live-Verbindung (`PresenceTracker`) - Phase 2, Punkt 1.
  2. Eine profilweite Sichtbarkeits-EINSTELLUNG (`presenceKind` um ein
     Feld `onlineVisibility: 'public' | 'contacts' | 'private'`
     erweitert) - steuert, WER die Live-Verbindung dieser Identität
     überhaupt sehen darf, unabhängig davon, in wie vielen gemeinsamen
     Chats man sich befindet. Das ist NEU (Phase 2, Punkt 1 muss diese
     Einstellung beim Broadcast berücksichtigen, nicht nur roh
     durchreichen).

## 3. Phase 2 — nötige Framework-Erweiterungen (VOR dem Chat selbst)

1. **`PresenceTracker` für Clients lesbar machen, MIT Sichtbarkeits-
   Filter.** Aktuell rein relay-intern (nur für Push-Routing gelesen).
   Neuer Broadcast-Mechanismus: der Relay veröffentlicht Online/Offline-
   Übergänge für Pubkeys, die ein verbundener Client explizit abonniert -
   ABER nur, wenn `presenceKind.onlineVisibility` das für DIESEN
   Abonnenten erlaubt (`'public'` → jeder, `'contacts'` → nur
   gemeinsame-Chat-Teilnehmer, `'private'` → niemand außer einem selbst).
   Muss im Detail entworfen werden (eigener kleiner Technik-Plan vor der
   Umsetzung).
2. **`UploadOutbox` um ein Ergebnis-Feld erweitern.** `_attempt()`
   (`upload-outbox.js`) verwirft aktuell den Rückgabewert von
   `upload(record, blob)`. Erweiterung: das Ergebnis (z.B. `{url}`) wird
   in den Record gemerged und steht danach über `outbox.get(id)` zur
   Verfügung - Chat-Nachrichten referenzieren dann diese `url`.
3. **Relay als Blob-Storage-Mirror.** Entschieden: kein externer Dienst.
   Ablauf: Datei liegt zuerst NUR lokal (`UploadOutbox`s `localStore`) →
   wird zum Relay hochgeladen (neuer, ACL-geprüfter HTTP-Endpunkt am
   Relay, analog zum bestehenden statischen `relay-app-server.js`-Muster)
   → der Relay hält eine DAUERHAFTE Kopie (Mirror), genau wie er es für
   strukturierte CRDT-Daten bereits tut → JEDER Chat-Teilnehmer lädt die
   Datei von DORT herunter, nicht direkt vom Absender-Gerät (das könnte
   offline sein). Erst wenn der Relay die Datei bestätigt hat, gilt der
   Upload als "synced" (Punkt 2 oben); ob ein EMPFÄNGER sie bereits
   heruntergeladen hat, ist eine separate, pro-Empfänger verfolgbare
   Information (wiederverwendet dasselbe `readReceiptKind`/
   `deliveredUpTo`-Muster wie Nachrichten selbst, nur mit der Datei-`id`
   als Anker statt einer Nachrichten-`id`).
4. **`readReceiptKind` um `deliveredUpTo` erweitern** (siehe oben) -
   kleine, additive Schema-Änderung.
5. **Neuer `'group'`-ACL-Modus (§2a) - der zentrale neue Baustein dieser
   Phase.** `chatKind` (Vorschlag oben) nutzt NICHT das bestehende
   `content`-ACL + `grantWriter()`-Muster (Nachtrag - ursprünglicher Plan,
   verworfen: `grant.js`s eigener Kommentar "Revocation is deliberately out
   of scope" macht Mitglieder-ENTFERNEN damit unmöglich), sondern einen neuen
   sechsten ACL-Modus, dessen Schreibzugriff live gegen eine `groupKind`-
   Group geprüft wird - siehe §2a für die volle Mechanik (Scope-Deklaration,
   Live-Membership-Cache, betroffene Dateien). Vor der eigentlichen
   Chat-Implementierung gezielt gegen ein 1:1- UND ein Gruppen-Szenario
   durchtesten (Einladung UND Entfernen eines dritten Teilnehmers, inkl. der
   Zusicherung "entfernt kann ab sofort nicht mehr schreiben, sieht aber
   weiterhin die Historie bis zum Zeitpunkt des Entfernens"), damit keine
   Überraschung erst beim Chat-Bau auftaucht.
6. **"Bildschirm an halten, bis synced" (Wake Lock).** Neue kleine
   Client-Hilfsfunktion (Vorschlag: `packages/space-plugins/src/sync-
   guard.js`) - hält per `navigator.wakeLock` (Screen Wake Lock API) das
   Display an, SOLANGE `UploadOutbox` Einträge im Zustand
   `pending`/`uploading` hat, gibt automatisch frei sobald alles
   `synced`/`failed` ist. **Wichtige Grenze**: Wake Lock hält nur den
   BILDSCHIRM an (verhindert Sperren/Standby) - sie kann eine Web-App
   nicht dauerhaft "am Leben" halten, wenn der Tab/die App tatsächlich in
   den Hintergrund/geschlossen wird (Browser/OS-Limits). Ein Service-
   Worker mit Background-Sync ist ein sinnvoller, aber unabhängiger
   Zusatzbaustein für "auch im Hintergrund irgendwann fertig hochladen",
   ersetzt aber die Wake-Lock-Anzeige nicht.
7. **Compaction für lange Nachrichten-Listen.** Bereits vorhandenes
   `compactIfNeeded()`/`autoCompactOnJoin()`-Muster (siehe
   `demo/chat.mjs`s eigene Nutzung) auf `chatKind.messages` anwenden,
   damit ein vielbeschriebener Chat nicht bei jedem Beitritt/Reconnect die
   komplette Historie neu repliziert.
8. **Raum-Adressierung: `#/<app-prefix>/<raumId>/`.** Kein neuer Routing-
   Mechanismus in `PlatformRuntime`/`AppRuntime` nötig - eine Chat-App
   bekommt wie jede andere (Forum: `/topic/123`, Blog: `/post/<slug>`)
   ihren `subPath` von `platform.js`s `resolveForPath()` einfach
   durchgereicht und parst ihn selbst. Bewusst KEINE neue flache
   Top-Level-Route `#/<raumId>/` (wie der bestehende Bare-Pubkey-Fallback
   für Nutzer/Apps) - das würde eine Änderung an `resolveForPath()`s
   Fallback-Kette selbst verlangen (jede Route, nicht nur Chat, betroffen)
   für vergleichsweise wenig Gewinn (kürzere URLs). Die Raum-ID selbst ist
   dieselbe, die als `groupKind`s `name`/Pfad-Parameter dient (§2a) - bewusst
   NICHT der user-sichtbare, umbenennbare `chatKind.name`, damit Umbenennen
   eines Raums nie dessen eigene Adresse verändert.

## 4. Phase 3 — der Chat selbst (Überblick, noch nicht gebaut)

Neues Referenz-App-Bundle `chat-bundle.js` (gleiches Muster wie
Guestbook/Blog/Forum), plus neue UI-Bausteine in `@qu/space-ui`/
`@qu/space-components`:
- Konversationsliste (eigene Chats, ungelesen-Zähler)
- Message-Bubble-Liste mit Datumstrennern, Auto-Scroll
- Composer mit Typing-Trigger + Datei-Anhang-Button
- Bild-Lightbox (Klick → Vollbild-Overlay)
- Audio/Video-Player (natives `<audio>`/`<video>` reicht für v1, kein
  Custom-Player nötig)
- Datei-Upload-Status-Icon (schon vorhanden: `bindUploadStatusIcon()` -
  nur einbinden)
- Online-Punkt + "zuletzt online" (Phase 2, Punkt 1 vorausgesetzt)
- Haken-Symbole gesendet/zugestellt/gelesen

## 5. Phase 4 (später, nicht Teil dieser Umsetzung) - Reaktionen/Antworten/Pin

Über `@qu/extensions`' `ExtensionPointHost`, als eigene Contribution-
Points (z.B. `chat.messageActions` für Toolbar-Buttons pro Nachricht,
`chat.messageDecoration` für zusätzlich angezeigte Daten wie eine
Zitat-Vorschau) - referenziert über die Nachrichten-`id` aus §2, ohne
dass `chatKind`/das Kern-Nachrichtenschema dafür angefasst werden muss.
Bewusst erst NACH einem funktionierenden Kern-Chat, nicht vorgezogen -
dieselbe "kein Ausbau ohne konkreten zweiten Verwender" Zurückhaltung, die
`extension-points.js`s eigener Dokumentations-Kommentar bereits für sich
beansprucht.
