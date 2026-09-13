# Peer-User-Verwaltung: das User-Node (`@qu/space-core`'s `user.js`)

> Umsetzung von Arbeitspaket 5 aus `docs/quv5-vs-quv3-decision.md`:
> "User/alias/pub/epub-Semantik einmal sauber entscheiden und bauen —
> aufbauend auf den vorhandenen `alias.js`/`identity.js`-Bausteinen."

## Die Idee (GunDB-Pattern)

In GunDB hat jeder User einen öffentlich erreichbaren Teil, die User-Node:
immer lesbar `pub` + `epub`, dazu `alias` (Default = `pub` selbst), plus
beliebige weitere Custom-Profile-Properties (public oder encrypted). Qu V5
übernimmt genau dieses Muster — nicht als neuer Mechanismus, sondern als
eine weitere Anwendung der bereits vorhandenen `acl.write: 'owner'`-
Kind-Schema-Maschinerie (derselbe self-certifying `deriveOwnerNodeId()`,
dieselbe `'public'`-Visibility, die `alias.js`/`presence.js` schon nutzen).

`@qu/space-core`'s `user.js` definiert genau EIN neues Kind, `qu-user`:

```js
export const userKind = defineKind('qu-user', {
  fields: {
    alias: { shape: 'atomic', visibility: 'public' },
    epub: { shape: 'atomic', visibility: 'public' },
    listed: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'owner' },
});
```

- **`alias`** — ein frei gewählter Anzeigename, oder unset. `resolveAlias()`
  liefert dann den Pubkey selbst (base64url) als Fallback — GunDBs eigenes
  "Alias defaultet auf pub"-Verhalten.
- **`epub`** — der X25519-Public-Key dieser Identität, base64. Derselbe Wert
  ist über die Mitgliederliste (`/members.json`) oder `identity.xPublicKey`
  zwar schon anderswo bekannt — hier aber für JEDEN, der nur den `pub`
  dieser Identität kennt (kein gemeinsamer Space nötig), direkt auflösbar.
- **`listed`** — Opt-in/Opt-out in ein öffentliches Nutzerverzeichnis (siehe
  unten). **Default: `false` (ungelistet)**, bewusst privacy-by-default:
  nichts soll eine Identität sichtbarer machen, als sie es explizit
  gewählt hat. Jederzeit änderbar über `ensureUserProfile(space, {listed:
  true})`.

Alle drei Felder sind `'public'` — aus demselben Grund, aus dem
`acl.write: 'owner'` das Node-Meta schon automatisch public macht
(kind-schema.js's eigener Doc-Kommentar): ein Profil muss auflösbar sein,
OHNE dass der Leser je Mitglied desselben Space war — es gibt an diesem
Punkt schlicht keine Mitgliederliste, für die man verschlüsseln könnte.

## API

```js
import { userKind, userNodeId, resolveAlias, ensureUserProfile, filterListedUsers } from '@qu/space-core';
```

| Export | Zweck |
|---|---|
| `userNodeId(pub)` | Die deterministische, self-certifying Node-Id für `pub`s eigenes User-Node. |
| `resolveAlias(alias, pub)` | `alias` falls gesetzt, sonst `pub` (base64url) — GunDBs "Alias defaultet auf pub". |
| `ensureUserProfile(space, {alias?, listed?, timeout?})` | Erzeugt das eigene User-Node beim ERSTEN Aufruf (mit Defaults), reconciled ein bestehendes bei jedem weiteren — idempotent auch ÜBER einen Prozess-Neustart hinweg (wartet kurz, ob lokaler Storage/ein Relay bereits ein Profil kennt, bevor "neu" angenommen wird). Ein explizit übergebener Wert gewinnt immer. |
| `filterListedUsers(space, pubs, {timeout?})` | Aus einer Liste KANDIDATEN-Pubkeys (von welcher Peer-Discovery-Quelle auch immer ein Deployment schon hat) werden nur die `listed: true`-Profile zurückgegeben, `{pub, alias, epub}`. |

## Das zentrale Missverständnis, das dieses Design vermeidet

**Peer-seitiger Code fragt NIE "ist dieser Pubkey gelistet" als Teil des
Lese-/Schreib-Pfads eines Nodes** — `userKind` ist ein Node wie jedes
andere, `listed` ist schlicht eines seiner Felder. Die "Verzeichnis"-Logik
(`filterListedUsers`) lebt bewusst AUSSERHALB von `Space`/der Kind-Schema-
Maschinerie, genau wie `alias.js`'s `AliasRegistry` ein reiner Bus-Watcher
ist, kein `Space`-interner Mechanismus (siehe `architecture.md` §3.6).

## Wo lebt die Identität, wo das Profil? (Bezug zu `@qu/bootstrap`)

Arbeitspaket 2 (`docs/bootstrap-adapter-registry.md`) beantwortet "WO liegt
der private Schlüssel dieser Identität" (localStorage/sessionStorage/
memory). Dieses Arbeitspaket beantwortet eine GANZ ANDERE Frage: "WAS
veröffentlicht diese Identität über sich selbst, damit andere Peers sie
erreichen/verschlüsseln/anzeigen können." Beide sind unabhängig komponierbar:

```js
// @qu/app-shell's shell.js, nach bootstrapSpace():
const identity = await registry.create('identity', 'local-storage', { key: IDENTITY_STORAGE_KEY });
const { space } = await bootstrapSpace({ registry, identity, transport, storage, members });
await ensureUserProfile(space); // dieselbe lokale Identität ist jetzt EIN zentraler User für jede App auf diesem Origin.
```

Eine Identität aus dem `'memory'`-Adapter (flüchtig, siehe
`docs/bootstrap-adapter-registry.md`s Abschnitt dazu) kann GENAUSO ein
User-Node erzeugen, wenn sie will — niemand hindert eine GunDB-artige
"Fake-User"/Raum-Instanz daran, `ensureUserProfile()` aufzurufen. Typischer-
weise tut eine echte temporäre Identität das einfach nie, und bleibt ohne
User-Node — das ist der Unterschied zwischen "temporär" und "unlisted":
ersteres betrifft, wie lange die Identität SELBST existiert, letzteres nur,
ob ihr (ggf. sehr langlebiges) Profil öffentlich AUFFINDBAR ist.

## Custom Profile-Properties: public UND/ODER encrypted, auch 1:n für Gruppen

`qu-user` bleibt BEWUSST minimal — Kind-Schema ist ein statischer, typisierter
Vertrag (kind-schema.js's eigener Doc-Kommentar), kein zur Laufzeit
erweiterbarer Property-Bag. Die Erweiterbarkeits-Antwort dieses Frameworks
ist dieselbe, die es für JEDEN anderen Owner-Content schon hat: eine App
definiert ihr EIGENES Kind, auf dieselbe Identität geankert.

```js
// App-eigenes, öffentlich lesbares Custom-Profil-Feld:
const bioKind = defineKind('my-app-bio', {
  fields: { bio: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'owner' },
});

// App-eigenes Feld, verschlüsselt für eine bestimmte GRUPPE statt den ganzen Space -
// field.set(value, {recipients}) existiert bereits (field.js) - "1:n encrypted" braucht
// keine neue Kryptografie, nur die passenden xPub-Keys der Gruppe:
const secretKind = defineKind('my-app-friends-only', {
  fields: { note: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'owner' },
});
const node = await space.createNode(secretKind, {});
await node.field('note').set('nur für diese Gruppe', { recipients: friendGroupXPubKeys });
```

Beide Kinds sind über `deriveOwnerNodeId(pub, kind)` an DIESELBE Identität
geankert wie `qu-user` — ein Leser, der den Pubkey kennt, kann alle drei
(Basis-Profil + beide Custom-Kinds) unabhängig auflösen, ohne dass `user.js`
selbst davon je etwas wissen müsste. Das ist genau das bereits existierende
Muster aus `acl.test.js`'s eigenem `profileKind`-Beispiel — hier nur explizit
als DIE empfohlene Antwort auf "wie füge ich Custom-Properties hinzu"
dokumentiert.

## Das Nutzerverzeichnis: bewusst kein neuer Relay-Mechanismus

`filterListedUsers()` erfindet absichtlich KEINE neue Enumerations-
Maschinerie (kein neues Relay-Endpoint, keine neue ACL-Mode) — sie filtert
eine bereits vorhandene Kandidatenliste (z. B. `@qu/app-shell`'s
`fetchMembers()`/`/members.json`, oder eine Kontaktliste einer App) nach
`listed`. Das hält die Enumerations-Frage dort, wo sie heute schon gelöst
wird (Transport/Relay-Ebene), und dieses Paket bei seiner eigentlichen aufgabe
(Profil-Semantik) — eine dedizierte, skalierbare "wer ist alles gelistet"-
Abfrage (ohne jeden Kandidaten einzeln client-seitig zu prüfen) bleibt
bewusst künftige, separate Arbeit, falls ein Deployment sie braucht.

## Grenze zu `alias.js`

`alias.js`s Alias-Identitäten sind KEIN Widerspruch zu `qu-user` — sie lösen
ein anderes Problem: eine pro-SPACE unlinkbare Pseudonym-Identität (damit
ein Relay zwei Aliase derselben realen Person nicht verknüpfen kann, siehe
`architecture.md`/`alias.js`s eigenen Doc-Kommentar). Eine Alias-Identität
KANN ihr eigenes `qu-user`-Profil haben (sie ist für jeden Zweck dieses
Frameworks eine vollständig eigenständige Identität) — ob ein Alias gelistet
sein soll, ist eine bewusste Entscheidung der jeweiligen App/des Nutzers,
nicht etwas, das dieses Paket für sie entscheidet.
