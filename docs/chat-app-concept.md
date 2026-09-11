# Messenger/Chat — Konzept

Antwort auf den Wunsch nach einer Telegram/Signal/WhatsApp/Tinode-artigen
Chat-App: Text, Bilder mit Lightbox, Video/Audio mit Player, Datei-Upload
mit Status (lokal/synced/gelesen), Zugestellt-/Gelesen-Haken, Typing- und
Online-Anzeige. Dieses Dokument ist bewusst **nur das Konzept** (Schritt 1
von 3: Konzept → Framework erweitern → Chat bauen) - keine der hier
vorgeschlagenen Kind-Schemas/Erweiterungen ist bereits implementiert.

Bereits mit dem Nutzer geklärt:
- **Nachrichten-Modell**: ein `ListField` PRO CHAT (nicht ein globales
  `sharedListKind` wie im einfachen öffentlichen Beispiel in
  `docs/example-apps.md` §4) - einfacher, robust genug für v1.
- **Online-Status**: echte Live-Verbindung soll sichtbar sein (nicht nur
  der selbstgemeldete Wert) - das relay-interne `PresenceTracker`-Wissen
  muss dafür clientseitig lesbar werden (Phase 2, siehe unten).

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
  (Phase 2, Punkt 1).**
- **`readReceiptKind`** (`packages/space-core/src/delivery-status.js`) -
  generisches "gelesen bis X"-Muster (`markRead()`/`watchReadReceipts()`),
  bereits genutzt für Datei-Empfangsbestätigungen. Direkt wiederverwendbar
  für "Nachricht gelesen".
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
  fehlende Baustein für **private 1:1-/Gruppen-Chats** (siehe Datenmodell).
- **`ListField`** (`packages/space-core/src/field.js`) - Anhängen ist
  konfliktfrei per Yjs-CRDT, `observe()` liefert Live-Updates ohne Polling,
  `slice()` erlaubt "letzte N Nachrichten"-artiges Lesen. Passt gut als
  Nachrichten-Log pro Chat.
- **Die einfachste Referenz** (`docs/example-apps.md` §4, `demo/chat.mjs`)
  - ein rein öffentlicher Ein-Kanal-Chat ohne Presence/Receipts/Medien.
  Guter Kind-Schema-Ausgangspunkt, aber zu simpel für das hier Gewünschte.

**Komplett neu** (existiert nirgends im Repo): Bild-/Video-/Audio-Anhänge,
Lightbox, Player, Zugestellt-Status (nur "gelesen" existiert bisher),
"Bildschirm an halten bis synced".

## 2. Datenmodell (Vorschlag)

### `chatKind` (Konversation)
```
acl: { write: 'content' }   // selbstzertifizierend + gezielte grantWriter()-Einladungen
fields:
  kind:         atomic, public      // '1:1' | 'group'
  name:         atomic, encrypted   // nur bei Gruppen relevant
  participants: atomic, encrypted   // Array<pubkey base64> - wer ist dabei
  messages:     list,   encrypted   // siehe unten
  createdAt:    atomic, public
```
Jede Nachricht ist ein Element im `messages`-`ListField`:
```
{
  id: string,               // client-generierte UUID, für Read-Receipt-Referenz
  from: string,              // Absender-Pubkey (base64)
  type: 'text' | 'image' | 'video' | 'audio' | 'file',
  text: string | null,
  attachment: {              // nur bei type != 'text'
    fileId, name, mimeType, size,
    url,                     // NEU - siehe Phase 2 Punkt 2
    width, height,           // Bilder/Video
    duration,                 // Video/Audio
  } | null,
  sentAt: number,
}
```
**Verschlüsselung**: `messages` ist `visibility: 'encrypted'`, jeder
`push()` mit `recipients: participants` (nur für die aktuellen
Teilnehmer). Das bedeutet - identisch zum bereits dokumentierten
Trade-off in `docs/example-apps.md` §4 - ein SPÄTER zur Gruppe
hinzugefügter Teilnehmer sieht die Historie davor NICHT rückwirkend. Das
ist echtes E2E-Verhalten (wie Signal), keine Einschränkung, die "behoben"
werden muss - aber es muss der UI klar kommuniziert werden.

### Zugestellt/Gelesen
- **Gelesen**: `readReceiptKind` direkt wiederverwenden -
  `markRead(space, {contentNodeId: chatId, upTo: messageId})` pro Chat-
  Teilnehmer. Existiert vollständig, keine Framework-Arbeit nötig.
- **Zugestellt** (WhatsApp: ein grauer Haken, sobald das Gerät die
  Nachricht empfangen, aber noch nicht gelesen hat) - **existiert noch
  nicht** als eigener Zustand. Vorschlag: `readReceiptKind` um ein
  zweites Feld `deliveredUpTo` erweitern (gleiche Struktur wie `upTo`,
  geschrieben sobald der Client die Nachricht empfangen UND lokal
  gespeichert hat, unabhängig vom tatsächlichen Lesen). Kleine, additive
  Erweiterung eines bestehenden Kinds (Phase 2, Punkt 4).

### Typing & Online
- **Typing**: `setTyping(space, chatId, true)` beim Tippen im Composer,
  automatisches Timeout (z.B. 3s ohne Tastendruck → `false`) - reine
  Chat-UI-Arbeit, keine Framework-Änderung.
- **Online**: `presenceKind.online` reicht NICHT für "echte" Live-Anzeige
  (ein abgestürzter Client meldet sich nie ab). Der Nutzer hat sich
  explizit für die robustere Variante entschieden → Phase 2, Punkt 1.

## 3. Phase 2 — nötige Framework-Erweiterungen (VOR dem Chat selbst)

1. **`PresenceTracker` für Clients lesbar machen.** Aktuell rein
   relay-intern (`packages/space-transport/src/presence-tracker.js`, nur
   für Push-Routing gelesen). Vorschlag: ein neuer, kleiner,
   `'relay-admins'`-unabhängiger Broadcast-Mechanismus - der Relay
   veröffentlicht Online/Offline-Übergänge für Pubkeys, die ein
   verbundener Client explizit abonniert (ähnlich der bestehenden
   `hello`-Mechanik, aber client-seitig konsumierbar), ODER einfacher: ein
   periodischer/ereignisgetriebener `{type:'presence', pub, online}`
   Broadcast an alle, die diesen Pubkey "beobachten". Muss noch im Detail
   entworfen werden - bewusst als offener Punkt markiert, siehe unten.
2. **`UploadOutbox` um ein Ergebnis-Feld erweitern.** `_attempt()`
   (`upload-outbox.js`) verwirft aktuell den Rückgabewert von
   `upload(record, blob)`. Erweiterung: das Ergebnis (z.B. `{url}`) wird
   in den Record gemerged und steht danach über `outbox.get(id)` zur
   Verfügung - Chat-Nachrichten referenzieren dann diese `url`.
3. **Blob-Storage-Backend entscheiden.** `UploadOutbox` delegiert das
   tatsächliche Hochladen bewusst an eine caller-seitige `upload()`-
   Funktion - es existiert aber noch KEIN konkretes Ziel dafür. Zwei
   Optionen, **Entscheidung steht noch aus**:
   - (a) Der Relay bekommt einen einfachen, ACL-geprüften HTTP-Endpunkt
     zum Hoch-/Runterladen (analog zum bestehenden statischen
     `relay-app-server.js`-Muster) - kein zusätzlicher Dienst nötig, aber
     mehr Verantwortung/Storage-Kosten beim Relay.
   - (b) Ein externer, S3-kompatibler Objektspeicher wird als
     konfigurierbare Option unterstützt - skaliert besser, aber ein
     zusätzlicher Deployment-Baustein.
4. **`readReceiptKind` um `deliveredUpTo` erweitern** (siehe oben) -
   kleine, additive Schema-Änderung.
5. **Private Chat-ACL verifizieren/dokumentieren.** `chatKind` (Vorschlag
   oben) nutzt das bestehende `content`-ACL + `grantWriter()`-Muster - vor
   der Implementierung einmal gezielt gegen ein 1:1- UND ein
   Gruppen-Szenario durchgetestet werden (Einladung eines dritten
   Teilnehmers, Entzug), damit keine Überraschung erst beim Chat-Bau
   auftaucht.
6. **"Bildschirm an halten, bis synced" (Wake Lock).** Neue kleine
   Client-Hilfsfunktion (Vorschlag: `packages/space-plugins/src/sync-
   guard.js`) - hält per `navigator.wakeLock` (Screen Wake Lock API) das
   Display an, SOLANGE `UploadOutbox` Einträge im Zustand
   `pending`/`uploading` hat, gibt automatisch frei sobald alles
   `synced`/`failed` ist. **Wichtige Grenze, die dem Nutzer klar sein
   sollte**: die Wake Lock API hält nur den BILDSCHIRM an (verhindert
   Sperren/Standby) - sie kann eine Web-App nicht dauerhaft "am Leben"
   halten, wenn der Tab/die App tatsächlich in den Hintergrund/geschlossen
   wird (Browser/OS-Limits, kein natives Vordergrund-Service-Äquivalent
   ohne eigene native App). Ein Service-Worker mit Background-Sync ist ein
   sinnvoller, aber unabhängiger Zusatzbaustein für "auch im Hintergrund
   irgendwann fertig hochladen", ersetzt aber die Wake-Lock-Anzeige nicht.
7. **Compaction für lange Nachrichten-Listen.** Bereits vorhandenes
   `compactIfNeeded()`/`autoCompactOnJoin()`-Muster (siehe
   `demo/chat.mjs`s eigene Nutzung) auf `chatKind.messages` anwenden,
   damit ein vielbeschriebener Chat nicht bei jedem Beitritt/Reconnect die
   komplette Historie neu repliziert.

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

## 5. Offene Entscheidungen

Bevor Phase 2 sinnvoll beginnen kann, brauche ich von dir:

1. **1:1 zuerst, oder von Anfang an auch Gruppen?** (Gruppen sind nicht
   viel mehr Aufwand dank `chatKind.participants`, aber mehr zu testen.)
2. **Blob-Storage**: eigener Relay-Endpunkt oder externer Dienst (S3 o.ä.)?
3. **Verschlüsselung**: wie oben vorgeschlagen (echtes E2E, `recipients`-
   beschränkt) - damit einverstanden, inkl. der "kein rückwirkendes
   Lesen für neue Gruppenmitglieder"-Einschränkung?
4. Reicht **"zugestellt" als reine Zusatz-Anzeige** (Punkt 4 oben), oder
   ist sie für v1 verzichtbar (nur "gesendet"/"gelesen", kein
   Zwischenzustand)?
