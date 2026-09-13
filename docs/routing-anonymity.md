# Routing-Anonymität: was ein Relay/Netzwerk-Beobachter tatsächlich sieht

> Fortsetzung von Arbeitspaket 4 (`docs/quv5-vs-quv3-decision.md`) — die
> Frage, die den Ausschlag gab: "Ein Message-Versand via Netzwerk soll
> möglichst wenig über Empfänger, Sender und Inhalt preisgeben." Dieses
> Dokument trennt bewusst drei Zustände: **gelöst** (Code existiert,
> getestet), **gelöst, aber nur als Rezept dokumentiert** (kein neuer Code
> nötig), und **vorgeschlagen, noch nicht umgesetzt** (bewusst erst nach
> Rückmeldung, da sicherheitsrelevant).

## Der Befund: was heute pro Envelope sichtbar ist

Grundlage: `@qu/space-core`'s `envelope.js`/`@qu/core`'s `crypto.js`. Für
JEDEN `mode: 'encrypted'`-Envelope (der Normalfall):

| Feld | Sichtbar für Relay/Beobachter? | Warum |
|---|---|---|
| Inhalt (`ct`) | **Nein** | AES-GCM, Relay hält nie einen privaten X25519-Key. |
| `pub` (Signierer) | **Ja, immer** | Der Relay muss die ACL gegen DIESEN Pubkey prüfen (`verifyEnvelope()`). |
| `senderXPub` | **Ja, immer** | Für ECDH nötig — steht unverschlüsselt neben der Chiffre. |
| `to` (Empfänger-Pubkeys) | **Ja, immer** | Jeder Empfänger muss seinen eigenen Eintrag finden können. |
| `nodeId` | **Ja** | Routing-Adresse — steht außerhalb des Envelopes in der Wire-Nachricht. |
| `ts` | **Ja** | Klartext-Timestamp. |

Für `mode: 'public'` ist ALLES sichtbar — by design, kein Leck (siehe
kind-schema.js's `'public'`-Visibility-Begründung).

## 1. Sender-Anonymität — GELÖST, jetzt als allgemeines Rezept

**Befund:** `envelope.pub` verrät IMMER den echten Signierer — außer die
signierende Identität ist selbst schon eine Pseudo-Identität. Das leistet
`@qu/space-core`'s `alias.js` bereits, bisher aber nur für
`acl.write: 'owner'`/`'named'`/`'content'`-Kinds dokumentiert.

**Das "toter Briefkasten"-Modell, präzisiert:** Ein Alias ist KEIN von
beiden Seiten gehaltenes Schlüsselpaar — nur die REALE Identität besitzt
jemals den privaten Schlüssel des Alias (`deriveAliasIdentity()` leitet ihn
aus dem eigenen privaten Schlüssel ab; niemand sonst kann das). Ein
Korrespondent braucht ihn auch nicht — er interagiert mit dem Alias genauso
wie mit jeder anderen Identität (liest dessen Nodes, empfängt dessen
signierte Writes). Was den Alias zu einem "Briefkasten mit verstecktem
Besitzer" macht, ist `AliasRegistry`: ein verschlüsselter Registry-Eintrag
(`aliasPub -> realPub`), lesbar NUR für aktuelle Space-Mitglieder — **die
Auflösung "wer steckt wirklich dahinter" passiert ausschließlich lokal,
client-seitig**, nie beim Relay (der hält nie den Decryption-Key für diesen
Eintrag).

**Neu:** `@qu/bootstrap`'s `bootstrapAliasSpace(realSpace, spaceId, config)`
— verpackt `publishAlias()` + `bootstrapSpace()` in einem Aufruf:

```js
import { bootstrapAliasSpace } from '@qu/bootstrap';

const { space: aliasSpace } = await bootstrapAliasSpace(realSpace, 'my-space', {
  registry,
  transport: { adapter: 'in-process', hub, peerId: 'alice-alias' }, // eine EIGENE Verbindung - siehe "Restrisiko" unten.
});
await aliasSpace.createNode(myOwnerKind, { ... }); // signiert als Alias, nicht als die reale Identität.
```

**Deckt ab:** jedes `'owner'`/`'named'`/`'content'`-ACL-Kind — zero
Relay-seitiges Setup, self-certifying, funktioniert sofort.

**Deckt NICHT automatisch ab:** anonymes Schreiben in ein flaches
`acl.write: 'members'`-Kind — dafür muss der Alias-Pubkey ERST als
Space-Mitglied registriert werden (WIE, ist Deployment-spezifisch — bei
`@qu/app-shell` z. B. `joinSpace({identity: aliasIdentity, ...})`, derselbe
`POST /join`, den die reale Identität auch nutzt). Das bleibt bewusst
außerhalb von `@qu/bootstrap`, da der konkrete Join-Mechanismus pro Relay-
Implementierung unterschiedlich sein kann.

**Restrisiko, ehrlich benannt:** `bootstrapAliasSpace()` verlangt bewusst
eine EIGENE Transport-Verbindung (nicht dieselbe wie die reale Identität) —
aber ein Relay, der IP-Adresse/Socket-Timing mitprotokolliert, kann zwei
Verbindungen von DERSELBEN Quelle trotzdem korrelieren, selbst wenn beide
unterschiedliche Pubkeys verwenden. Identitäts-Pseudonymität löst das
KRYPTOGRAFISCHE Verknüpfungsproblem (Inhalt/Signatur), nicht das
NETZWERK-Korrelationsproblem — echte Transport-Unverknüpfbarkeit bräuchte
unterschiedliche Netzwerkpfade (z. B. über ein künftiges Mesh, `docs/peer-
transport-contract.md`'s §"Mesh" — nicht etwas, das dieses Dokument löst).

## 2. Empfänger-Anonymität bei 1:n-Gruppen — VORGESCHLAGEN, noch nicht umgesetzt

**Befund (aus der letzten Runde):** für eine GEWÖHNLICHE `'members'`-Breit-
seite ist `envelope.to` kein neues Leck (die Mitgliederliste ist über
`/members.json` ohnehin öffentlich). Sobald `field.set(value, {recipients})`
aber auf eine Teilmenge einschränkt (Arbeitspaket 5's Gruppenverschlüsselung),
verrät `envelope.to` dem Relay GENAU diese Teilmenge — der Inhalt bleibt
geheim, aber "wer darf das hier lesen" nicht.

**Vorschlag (Design, nicht implementiert):** `envelope.to` immer auf die
VOLLE Space-Mitgliederliste auffüllen — echte gewrappte Schlüssel für die
tatsächlichen Empfänger, ununterscheidbare Zufallsbytes gleicher Länge für
jedes andere Mitglied. Kosten: O(Mitgliederzahl) statt O(Empfängerzahl)
Bytes pro eingeschränktem Write. Ändert das Envelope-Format in `@qu/core`/
`envelope.js` — **wartet auf explizite Freigabe**, siehe unten.

## 3. Alias-Rotation mit erhaltener Korrespondenz-Kette — VORGESCHLAGEN, noch nicht umgesetzt

**Die Frage:** kann `Sender -> SenderAlias -> EmpfängerAlias -> Empfänger`
gültig bleiben, auch wenn beide Seiten ihre Alias-Identität über die Zeit
WECHSELN (rotierende Pseudonyme statt eines einzigen festen pro Space)?

**Warum das heute bewusst NICHT geht:** `deriveAliasIdentity(identity,
spaceId)` ist absichtlich STATISCH — "same real identity + same spaceId
always yields the same alias" (siehe `alias.js`'s eigener Doc-Kommentar;
`publishAlias()`'s Kommentar nennt Rotation explizit als "out of scope
here"). Ein fester Alias ist für EINE Sache gut (Unverknüpfbarkeit
ÜBER SPACES hinweg), aber schlecht für eine andere (Langzeit-Beobachtung
INNERHALB eines Space — derselbe Alias-Pubkey über Monate ist selbst ein
Korrelations-Anker, auch ohne dass der Relay je den echten Pubkey sieht).

**Buildbares Design (Vorschlag):**

1. **Epoch-basierte Re-Derivation.** `deriveAliasIdentity(identity, spaceId,
   epoch)` — `epoch` fließt zusätzlich in die Domain-Separation ein (z. B.
   `sha256("qu-space-alias-sign-v1:" + spaceId + ":" + epoch + ":" +
   signingKey)`). Gleiche reale Identität + gleiche `spaceId` + gleiche
   `epoch` → immer derselbe Alias (kein Extra-State nötig); ANDERE `epoch`
   → ein für Dritte computational unverknüpfbarer neuer Alias, genau wie
   heute schon zwischen unterschiedlichen `spaceId`s.
2. **Handoff/Rotation-Ankündigung — der Teil, der die Kette erhält.** BEVOR
   ein Alias "ausläuft", signiert und verschlüsselt er EINE Nachricht NUR
   für den jeweiligen Korrespondenten (`field.set(..., {recipients:
   [nurDieserKorrespondent]})` — exakt der bereits existierende
   Gruppenverschlüsselungs-Mechanismus, zweckentfremdet für genau EINEN
   Empfänger): "mein Nachfolger für dieses Gespräch ist `epoch+1`s
   Alias-Pubkey = X." Der Korrespondent entschlüsselt das LOKAL, aktualisiert
   seine eigene Zuordnung "Gespräch mit Bob läuft jetzt unter Alias X"
   und schreibt künftig an die neue Adresse weiter.
3. **Für einen externen Beobachter (Relay inklusive) ist die Rotation
   UNSICHTBAR** — die Handoff-Nachricht sieht aus wie jeder andere
   verschlüsselte Write; die Verknüpfung alter↔neuer Alias existiert nur
   im entschlüsselten Klartext, den nur der eine Korrespondent je sieht.

**Ehrliche Grenze dieses Vorschlags:** das löst Unverknüpfbarkeit auf
INHALTS-/SIGNATUR-Ebene — es löst NICHT die Korrelation über
Verbindungs-Metadaten (dieselbe Transport-Verbindung/IP über eine Rotation
hinweg hinweg bleibt für den Relay korrelierbar, siehe Abschnitt 1's
"Restrisiko"). Echte Unverknüpfbarkeit bräuchte zusätzlich einen
Verbindungswechsel pro Rotation — das ist Transport-/Mesh-Arbeit (`docs/
peer-transport-contract.md`), nicht etwas, das eine Identitäts-Rotation
allein leisten kann. Dieser Vorschlag wird hier bewusst nur SKIZZIERT, noch
nicht gebaut — **wartet auf explizite Freigabe**, da er ein neues
Protokollverhalten (Handoff-Nachrichten-Format) einführt, das sorgfältig
gegen Fehlnutzung (ein Angreifer, der eine FALSCHE Handoff-Nachricht
unterschiebt) durchdacht werden muss, bevor Code entsteht.

## Zusammenfassung: was jetzt nutzbar ist, was noch auf Freigabe wartet

| # | Thema | Status |
|---|---|---|
| 1 | Sender-Anonymität (self-certifying Kinds) | **Fertig** — `bootstrapAliasSpace()` |
| 1b | Sender-Anonymität (`'members'`-Mode) | **Rezept dokumentiert**, Deployment-spezifischer Join-Schritt nötig |
| 2 | Empfänger-Anonymität bei Gruppen (`envelope.to`-Padding) | **Vorschlag**, wartet auf Freigabe (ändert Envelope-Format) |
| 3 | Alias-Rotation mit Korrespondenz-Kette | **Vorschlag**, wartet auf Freigabe (neues Protokollverhalten) |
