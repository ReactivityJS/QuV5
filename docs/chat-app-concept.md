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

### §2a. Mitglieder hinzufügen/entfernen - umgesetzt

**Status: fertig implementiert** (`@qu/space-core`, `@qu/space-transport`,
`@qu/app-core`, jeweils mit End-zu-Ende-Tests über einen echten Relay). Die
folgenden Absätze sind das ursprüngliche Vorab-Konzept; zwei Stellen sind
beim tatsächlichen Bauen bewusst ANDERS gelandet als hier ursprünglich
skizziert - siehe die beiden Kästen unten für den finalen Stand.

Der EINE Mechanismus, der noch nicht existiert (alles andere in diesem
Dokument ist bereits vorhandenes Framework-Primitiv): ein Kind-Schema-ACL-
Modus, dessen Schreibzugriff nicht gegen eine feste, boot-zeit-konfigurierte
Liste (wie `'members'`/`'relay-admins'` heute) oder einen unwiderruflichen
Grant (wie `'content'`/`'named'` heute, `grant.js`s eigener Kommentar:
"Revocation is deliberately out of scope here") geprüft wird, sondern gegen
die AKTUELLE Mitgliederliste einer benannten `groupKind`-Group:

- **Neuer ACL-Modus `'group'`** (`kind-schema.js`s `ACL_MODES`, sechster
  Eintrag neben `owner`/`named`/`content`/`members`/`relay-admins`). ✅ So
  gebaut.
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

  > **❌ Anders gelandet:** Eine separate Scope-Deklaration war am Ende gar
  > nicht nötig. `groupRef: {groupOwnerPub, groupName}` reist stattdessen
  > direkt auf JEDER einzelnen Write-Nachricht mit (neben `{nodeId,
  > envelope}`, nie innerhalb des Envelopes selbst) - ein Verifizierer
  > rechnet `deriveContentNodeId(groupRef.groupOwnerPub, kind,
  > groupRef.groupName)` nach und vergleicht mit `nodeId`; eine falsche
  > Behauptung fällt bei JEDEM Write sofort durch, genau wie bei `'content'`
  > selbst. Das macht eine vorab gespeicherte Scope-Map überflüssig - weder
  > Relay noch Space müssen sich "wessen Scope ist Node X" merken, es steckt
  > selbstzertifizierend in jeder Nachricht.
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
  für v1 mehr Aufwand wäre als gerechtfertigt. ✅ So gebaut, CLIENT-seitig:
  `Space._currentGroupMembers()` liest die Group direkt (entschlüsselt/
  dekodiert wie jeder andere Read), gecacht, invalidiert über
  `space.node.<groupId>.changed`. Blockiert dabei NIE auf Netzwerk-I/O -
  ein früherer Entwurf tat das und deadlockte die eigene serialisierte
  Incoming-Queue (die Group-Daten selbst kommen über dieselbe Queue rein,
  auf die gerade gewartet würde) - siehe `space.js`s eigenen Kommentar an
  `_currentGroupMembers()` für die volle Herleitung.

  > **❌ Zusätzlich gelandet (Relay-seitig, ursprünglich nicht bedacht):**
  > Der Relay dekodiert NIE Yjs-Inhalte, auch keine `visibility: 'public'`-
  > Felder - er kann die Group also nicht einfach "mitlesen" wie ein Client.
  > Für die RELAY-seitige Durchsetzung gibt es deshalb eine eigene, separat
  > signierte Kontrollnachricht, `Space.declareGroupMembership()`
  > (`@qu/space-core`s `group-membership.js`, selbstzertifizierend wie
  > `grant`) - der Group-Owner sendet sie zusätzlich zum gewöhnlichen
  > Feld-Write; `createGroup()`/`editGroup()` (`@qu/app-core`s `dev.js`) tun
  > das automatisch. Ein `ts`-Feld verhindert, dass eine verspätet
  > eintreffende ältere Deklaration eine neuere Mitgliedschaft zurückdreht.
  > Ohne Deklaration lehnt der Relay JEDEN `'group'`-ACL-Write ab, fail-
  > closed, auch den des Group-Owners selbst.
- **Kein Einfluss auf bestehende Nachrichten-Verschlüsselung** - `recipients`
  beim Schreiben einer Nachricht wird weiterhin aus der Group zum
  Schreibzeitpunkt gelesen (bereits bestehendes `resolveGroup()`-Verhalten,
  "nicht rückwirkend", siehe oben) - der neue ACL-Modus entscheidet NUR, WER
  überhaupt schreiben darf, nicht FÜR WEN verschlüsselt wird. Beides bleibt
  bewusst getrennt (derselbe Split, den `kind-schema.js` schon immer macht:
  Schreib-ACL und Lese-Sichtbarkeit sind unabhängige Achsen). ✅ So gebaut.
- **Umfang der Arbeit**: `kind-schema.js` (`ACL_MODES` + Doku),
  `space.js`s `_isAuthorizedWriter()` (Client-Spiegel, inkl. Live-Watch
  eigener referenzierter Groups), `relay.js`s `buildWriteAcl()`
  (Server-Durchsetzung + Live-Cache), plus die neue Scope-Deklaration
  selbst (ähnlich `grant.js`, eigene kleine Signaturnachricht). Reale,
  nicht-triviale Framework-Arbeit, vergleichbar zur bereits bestehenden
  `grant`/`'content'`-Mechanik - kein kleiner Zusatz, aber auch kein neues
  Konzept (reine Erweiterung eines bereits fünfmal bewährten Musters).
  ✅ Plus ein real gefundener, unabhängiger Bug unterwegs behoben:
  `Space._releaseNode()` durfte eine Group-Node bislang bei jedem Refcount-
  Nulldurchgang abbauen (auch durch einen ganz gewöhnlichen, unbeteiligten
  `ContentResolver.resolveGroup()`-Read) - das riss dem Live-Membership-
  Cache irgendwann den Boden weg. Group-Nodes werden jetzt nie mehr
  abgebaut, sobald irgendein Code-Pfad sie einmal angefasst hat.

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
   ABER nur, wenn `onlineVisibility` das für DIESEN Abonnenten erlaubt.
   ✅ So gebaut, nach kurzer Abstimmung mit dem Nutzer (siehe unten) -
   BEWUSST NUR `'public'`/`'private'`, KEIN relay-berechnetes `'contacts'`:
   ein Cross-Space-Mitgliedschafts-Index am Relay würde genau das
   Membership-Wissen preisgeben, das mehrere ACL-Modi dieses Frameworks
   bewusst vom Relay fernhalten (private Gruppen!) - siehe
   `presence-visibility.js`'s eigenen Kommentar dazu. Mechanik, identisch
   zum `'group'`-ACL-Muster (§2a): eine SEPARATE signierte Deklaration
   (`Space.declareOnlineVisibility()`/`presence.js`s `declareOnlineVisibility()`,
   setzt zusätzlich das app-lesbare `presenceKind.onlineVisibility`-Feld),
   da der Relay niemals Yjs-Inhalte decodiert, auch keine `'public'`-Felder.
   Abonniert wird NICHT über einen neuen globalen Kanal, sondern über die
   ohnehin schon offene Space-Verbindung (`Space.watchLivePresence(pub)`/
   `unwatchLivePresence()`/`isLiveOnline()`, reaktiv über
   `presence.js`s neuen `LivePresenceWatcher` und den Bus-Topic
   `space.presence.live.changed`) - ein FREMDER (kein gemeinsames Space-
   Mitglied) kann trotzdem abonnieren, solange er den Pubkey kennt und
   dieser `'public'` deklariert hat, exakt der "profilweite Einstellung"-
   Anspruch aus der Analyse unten. Undeklarierte/`'private'`-Pubkeys sind
   fail-closed (keine Antwort, nicht unterscheidbar von "gerade offline").
   Ein weiterhin per-Space/per-App gepflegter, self-reported
   `presenceKind.online` (bestehend, unverändert) bleibt der "App-
   spezifische Override" für Chat-lokale Anwesenheit.
2. **`UploadOutbox` um ein Ergebnis-Feld erweitern.** `_attempt()`
   (`upload-outbox.js`) verwirft aktuell den Rückgabewert von
   `upload(record, blob)`. Erweiterung: das Ergebnis (z.B. `{url}`) wird
   in den Record gemerged und steht danach über `outbox.get(id)` zur
   Verfügung - Chat-Nachrichten referenzieren dann diese `url`. ✅ So gebaut.
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
   als Anker statt einer Nachrichten-`id`). ✅ So gebaut:
   `@qu/space-core`s `blob-auth.js` (`deriveBlobId(ownerPub, localId)` -
   selbstzertifizierend, exakt dasselbe "id neu herleiten und vergleichen"
   Muster wie `grant.js`, kein Relay-Register nötig) +
   `@qu/space-transport`s `relay-blob-server.js` (`PUT`/`GET
   /blob/<blobId>` auf demselben HTTP-Port wie `relay-app-server.js`,
   ACL-Check via Signaturprüfung OHNE jeden Registry-Zustand) +
   `@qu/space-storage`s `createBlobFileStore()`/`createMemoryBlobStore()`
   (dieselbe Adapter-Konvention wie `createFileStore()`, nur für rohe
   Bytes statt Envelopes) + `@qu/space-plugins`s `uploadToRelayBlob(space,
   relayHttpUrl, localId, blob)` - direkt als `UploadOutbox`s `upload()`-
   Callback einsetzbar, ihr Rückgabewert `{url}` landet automatisch im
   Record (Punkt 2 oben). In `relay-server.js` (die generische
   `@qu/space-transport`-Referenz-Relay) verdrahtet, unter
   `QU_RELAY_DATA_DIR/blobs`; `app-shell`s eigener Relay-Entrypoint noch
   NICHT verdrahtet (App-spezifische Integration, kein Phase-2-Scope).
   Download bewusst UNAUTHENTIFIZIERT (der `blobId` selbst - ein SHA-256-
   Digest - ist die Zugriffskontrolle, dieselbe Capability-URL-Haltung wie
   bei gewöhnlichem Objekt-Storage).
4. **`readReceiptKind` um `deliveredUpTo` erweitern** (siehe oben) -
   kleine, additive Schema-Änderung. ✅ So gebaut: `marks[contentNodeId]`
   trägt jetzt zusätzlich `{deliveredUpTo, deliveredAt}` neben `{upTo, at}`,
   beide über einen gemeinsamen, mergenden `_patchMark()`-Helfer gesetzt
   (`markRead()`/`markDelivered()` überschreiben sich gegenseitig nie).
   `markFileReceived()` nutzt jetzt `markDelivered()` statt `markRead()` -
   siehe Fußnote oben zu Punkt 3.
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
   Client-Hilfsfunktion (`packages/space-plugins/src/sync-guard.js`) - hält
   per `navigator.wakeLock` (Screen Wake Lock API) das Display an, SOLANGE
   `UploadOutbox` Einträge im Zustand `pending`/`uploading` hat, gibt
   automatisch frei sobald alles `synced`/`failed` ist. **Wichtige Grenze**:
   Wake Lock hält nur den BILDSCHIRM an (verhindert Sperren/Standby) - sie
   kann eine Web-App nicht dauerhaft "am Leben" halten, wenn der Tab/die App
   tatsächlich in den Hintergrund/geschlossen wird (Browser/OS-Limits). Ein
   Service-Worker mit Background-Sync ist ein sinnvoller, aber unabhängiger
   Zusatzbaustein für "auch im Hintergrund irgendwann fertig hochladen",
   ersetzt aber die Wake-Lock-Anzeige nicht. ✅ So gebaut: `guardSync(outbox)`
   nutzt `UploadOutbox`s neue `.watchAll()` (reaktiv, alle Records auf
   einmal), holt sich den Lock bei jedem in-flight-Übergang neu und legt
   zusätzlich einen `visibilitychange`-Listener an, da der Browser einen
   Wake Lock beim Hintergrundstellen des Tabs selbst freigibt - fehlende
   `navigator.wakeLock`-Unterstützung degradiert zu einem stillen No-op.
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

## 4. Phase 3 — der Chat selbst

**Status: Stufe 1 (Text-Kern: 1:1 + Gruppen, Haken, Typing, Online,
Konversationsliste) fertig implementiert** (`@qu/app-core`s
`messenger.js`, `apps/chat/`). Bild-/Datei-/Sprachnachrichten-Anhänge,
Lightbox, Player, Standort statisch/live - bewusste, vom Nutzer
entschiedene Folge-Stufen, hier noch NICHT gebaut (siehe §4b). Die
folgenden Absätze sind der ursprüngliche Vorab-Entwurf; mehrere Stellen
sind beim tatsächlichen Bauen bewusst ANDERS gelandet - siehe §4a für den
finalen Stand.

Referenz-App `apps/chat/` (gleiches `/apps/*`-Entdeckungs-Muster wie
Guestbook/Blog/Forum, aber - anders als die drei - KEIN CMS-Page-
gestütztes Bundle, siehe §4a), geplante UI-Bausteine:
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

### §4a. Stufe 1 (Text-Kern) - umgesetzt, was anders lief als hier skizziert

> **❌ Anders gelandet: EIN Datenmodell für 1:1 UND Gruppen, keine
> Besitzer-Asymmetrie zu lösen.** Dieses Dokument (§2) ließ offen, WER die
> `chatKind`/`groupKind`-Nodes für ein 1:1-Gespräch anlegen darf. Die
> Auflösung (Nutzer-Korrektur, bestätigt): es gibt gar kein echtes
> Asymmetrie-Problem - genau wie bei Matrix ist ein 1:1 einfach ein Raum
> mit zwei Mitgliedern. WER AUCH IMMER ein Gespräch beginnt, legt die
> `groupKind`-Group + den `chatKind`-Node unter der EIGENEN Pubkey an und
> nennt die Gegenseite sofort als Mitglied - exakt wie beim
> Gruppen-Erstellen, nur mit einem Mitglied weniger. Die verbleibende
> Frage "wo lebt dieses Gespräch" löst `directChatGroupName()`
> (`messenger.js`): ein deterministischer Hash BEIDER Pubkeys, sortiert -
> jede Seite berechnet denselben `groupName`, ohne vorherigen
> Roundtrip. `getOrCreateDirectChat()` prüft beide möglichen
> Besitzer-Slots (eigene Pubkey zuerst, dann die der Gegenseite) über
> `resolveGroup()`, bevor es ein neues Gespräch anlegt - wer zuerst
> beginnt, wird von der Gegenseite gefunden, nie dupliziert. Akzeptiertes
> Restrisiko (dokumentiert, nicht gelöst): starten beide Seiten im exakt
> selben Moment, bevor eine der beiden Group-Nodes synced ist, können
> theoretisch zwei getrennte Gesprächs-Paare entstehen - dieselbe
> "last write wins"-Abwägung, die `createGroup()` ohnehin schon akzeptiert.
>
> **❌ Anders gelandet: `chatKind` trägt NUR `name`/`messages`, kein
> `kind`/`groupOwnerPub`/`groupName`/`createdAt`-Feld.** §2s ursprünglicher
> Entwurf wiederholte die Routing-Information (`groupOwnerPub`/`groupName`)
> auch auf `chatKind` selbst. Tatsächlich ist die referenzierte
> `groupKind`-Group bereits die vollständige Existenz-/Mitgliedschafts-
> Quelle - jeder Aufrufer adressiert `chatKind` ohnehin immer explizit über
> genau dieses Paar (`chatNodeId(groupOwnerPub, groupName)`), eine zweite
> Kopie auf `chatKind` selbst wäre nur eine redundante zweite
> Wahrheitsquelle. Nebeneffekt mit echtem technischem Gewinn: `chatKind`s
> Felder sind dadurch ALLE `'encrypted'` (einheitliche Sichtbarkeit) - das
> ist, was es `Space.compactNode()` überhaupt erlaubt, den gesamten Node zu
> kompaktieren (siehe nächster Punkt).
>
> **➕ Zusätzlich gebaut (im Entwurf nicht bedacht): `compactNode()` um ein
> `recipients`-Override erweitert - schließt eine echte Yjs-Kausallücke
> beim Mitglieder-Hinzufügen.** Yjs integriert die Updates EINES Autors pro
> Node als strikt geordnete, lückenlose Sequenz - ein neu hinzugefügtes
> Gruppenmitglied, das ein FRÜHERES Update eines Autors nicht entschlüsseln
> kann (weil es damals noch kein Empfänger war), kann dadurch NIE wieder
> irgendein SPÄTERES Update desselben Autors integrieren, selbst nach dem
> Beitritt nicht (bereits bestehendes, von `group-private-content.test.js`
> bewiesenes Framework-Verhalten). `addGroupChatMembers()` behebt das: nach
> `editGroup()` ruft es `space.compactNode(chatId, {recipients:
> updatedMembers.map(m => m.xPub)})` - versiegelt den gesamten aktuellen
> Node-Zustand als EIN Envelope für die neue Mitgliederliste, gibt jedem
> (auch dem gerade beigetretenen Mitglied) eine lückenfreie Basis für
> ZUKÜNFTIGE Nachrichten. Alte Nachrichten (vor dem Beitritt) bleiben
> bewusst unerreichbar - echtes E2E-Verhalten, keine zu schließende Lücke
> (siehe "Entschiedene Punkte" oben). `compactNode()` selbst musste dafür
> zweifach erweitert werden: (1) ein optionales `recipients`-Override statt
> immer der flachen Space-Mitgliederliste zu versiegeln (sonst Leck an
> Space-Mitglieder außerhalb der Gruppe, oder harter Fehlschlag ohne
> konfigurierte flache Mitgliederliste), (2) das versiegelte Envelope muss
> auf dem Wire denselben `groupRef` tragen wie jeder andere `'group'`-ACL-
> Write auch - ohne das lehnt der Relay die Kompaktions-Snapshot genauso ab
> wie jeden anderen `groupRef`-losen `'group'`-Write.
>
> **➕ Zusätzlich gebaut: Kontakte-first statt Push/Notify.** Vom Nutzer
> explizit entschieden (gegen einen neuen Push-Mechanismus): ein Gespräch
> wird erst erreichbar, sobald BEIDE Seiten die Pubkey der Gegenseite schon
> kennen - ein geteilter Profil-Link, das bestehende opt-in
> `listed`-Nutzerverzeichnis, oder `contactsKind` (neu, `'owner'`-ACL,
> rein lokal/privat pro Identität, `addContact()`/`listContacts()`).
> `conversationsKind` (ebenfalls neu, gleiches ACL) ist der dazu passende,
> rein lokale Index "meine offenen Chats" - es gibt keine andere Möglichkeit,
> "meine Chats" aufzuzählen, da jeder Chat ein unabhängig adressierter,
> `'group'`-ACL-Node ohne gemeinsames Register ist. Konsequenz: wer ein
> 1:1-Gespräch beginnt, sieht es sofort in der eigenen Konversationsliste -
> die Gegenseite erst, NACHDEM sie selbst (unabhängig) denselben Kontakt
> hinzugefügt und das Gespräch gestartet hat (`getOrCreateDirectChat()`s
> "gefunden, nicht dupliziert"-Zusicherung sorgt dafür, dass beide dann im
> selben Raum landen).
>
> **➕ Zusätzlich gefunden und behoben (Framework-Lücken, erst durch den
> echten Messenger als ersten `'group'`-ACL-Konsumenten sichtbar
> geworden):** `createAppResolveKindSchema()` (`@qu/app-core`s
> `relay-resolver.js`) kannte `'group'`-ACL-Kinds überhaupt nicht - jede
> `chatKind`-Node wäre über den ECHTEN Relay-Deployment-Pfad (nicht nur
> handgebaute Test-Resolver) fälschlich als `'content'`-ACL klassifiziert
> und abgelehnt worden. Neuer `groupKinds`-Parameter (analog zu
> `collectionRegistryKinds`) + `createLiveAppResolveKindSchema()`
> (`@qu/app-shell`) liefert jetzt standardmäßig `[chatKind]` mit aus - ihr
> eigener `resolveKindSchema`-Wrapper gab zusätzlich den `groupRef`
> überhaupt nie weiter, ein separater, ebenfalls behobener Bug. Derselbe
> dynamische Klassifikations-Mechanismus kannte außerdem
> `@qu/space-core`s `userKind` (Nutzerprofile/`epub`) nicht - jeder
> Kontakt-Hinzufügen-Lookup (siehe oben: `epub` auflösen statt die
> Signatur-Pubkey fälschlich wiederzuverwenden) schlug deshalb über den
> echten Relay fehl, bis ergänzt.
>
> **➕ Zusätzlich gebaut: `subPath`-Durchreichung + `templateNames`-
> Deskriptorfeld für `/apps/*`-Apps.** `wireInstalledApps()`/`boot.js`
> reichten den aktuellen Route-Teilpfad bisher an keine entdeckte
> `/apps/*`-App weiter - für Gästebuch/Blog/Forum nie nötig (rein
> CMS-Page-getrieben), für einen code-getriebenen Messenger mit echten
> Unterrouten (`#/<prefix>/room/<roomId>`) zwingend. Jetzt threaded.
> Zusätzlich kann ein `/apps/*`-Deskriptor jetzt `templateNames` angeben
> (wie `viewNames`/`sharedLists` schon konnten) - nötig, weil `apps/chat/`
> als ERSTE Datei-App ein eigenes globales Root-Template braucht (die
> Sidebar+Hauptbereich-Chrome, siehe §4b), das über JEDE eigene Unterroute
> hinweg bestehen bleiben muss, nicht nur über CMS-Page-Routen.

### §4b. Route-Adressierung und Chrome - konkrete Umsetzung von §3 Punkt 8

`roomId` = `base64url(groupOwnerPub) + '.' + groupName` (trivial
umkehrbar, NIE die rohe `chatKind`-Node-Id selbst) - die Route lautet
`#/<prefix>/room/<roomId>`, exakt das in §3 Punkt 8 skizzierte Muster
(`subPath` von `AppRuntime.resolveRoute()` durchgereicht, selbst
geparst). `apps/chat/bundle.js` installiert dafür ein eigenes globales
Root-Template (`chat-shell`, via `createGlobalApp()`/
`createGlobalTemplate()`) statt einer einzelnen CMS-Page - die
Sidebar+Hauptbereich-Chrome bleibt dadurch über JEDEN `subPath` hinweg
bestehen (auch für Routen ohne passende CMS-Page), `apps/chat/actions.js`s
`wireChat()` füllt den Hauptbereich rein code-/reaktiv-getrieben.

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
