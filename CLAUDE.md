# CLAUDE.md — Böngészős multiplayer autós játék

Ez a fájl a projekt döntéseit és tervét rögzíti. Claude Code minden session-indításkor
automatikusan beolvassa. Az első feladat mindig: olvasd be ezt a fájlt, és a benne leírt
stackkel dolgozz.

## A projekt egy mondatban

Böngészőben futó, 3D nézetű (chase kamera) arcade autós játék, online multiplayerrel,
hogy 2–4 barát együtt tudjon versenyezni.

## 2.5D döntés (2026-07-07)

A játék **3D-nek látszik, de 2D fizikán fut** ("2.5D"). Indok: a cél a teljes 3D
látvány (az autót hátulról-felülről látjuk, a pályán "rajta vagyunk"), de domborzat,
ugratók és függőleges játékmenet NEM cél — ezért a drága 3D fizika + 3D netcode
felesleges. Következmények:

- A fizika **marad Planck.js 2D** (top-down sík), a `src/sim/` réteg érintetlen.
- A renderelés **Three.js**: a fizikai `(x, y)` világkoordináta a 3D-ben `(x, 0, z=y)`
  talajsíkra képződik le; a 2D szög a függőleges tengely körüli forgatás (`ry = -θ`).
- A multiplayer továbbra is a 2D állapotot szinkronizálja (kisebb és egyszerűbb).
- Ha később MÉGIS kell domborzat/ugrató, az fizikamotor-csere (pl. Rapier 3D) —
  külön nagy döntés, nem becsúszó feature.

## Stack

- **Kliens rendering:** Three.js (3D látvány, chase kamera)
- **Fizika:** Planck.js (a Box2D JS-portja) — 2D rigid-body (lásd 2.5D döntés)
- **Dev-szerver + build:** Vite (npm run dev, hot reload)
- **Multiplayer szerver (később):** Colyseus (Node.js) — szoba-kezelés, matchmaking,
  állapot-szinkronizáció
- **Nyelv:** JavaScript (később elmehet TypeScriptbe, ha indokolt)
- **Node:** LTS verzió

## Fejlesztési sorrend (fázisok)

A vezérelv: minden fázis végén legyen valami, ami fut. Ne egyszerre épüljön minden.

1. **Single-player prototípus (MOST ITT VAGYUNK).** Egy autó, egy pálya, jó vezetési
   élmény. Tisztán kliens-oldali, nincs szerver. Ez a fázis dönti el, hogy a játék
   élvezhető-e — a vezetésre kell ráhajtani, nem a funkciók számára.
2. **Verseny-logika.** Checkpointok, körszámlálás, köridő, rajt/cél, visszaszámlálás.
3. **Colyseus szoba.** Két kliens ugyanazt az állapotot látja — még netcode-finomítás
   nélkül, elfogadva a döcögést. Lokálisan tesztelve két böngészőablakban.
4. **Netcode finomítás.** Client-side prediction + server reconciliation + entity
   interpolation, hogy sima legyen.
5. **Extrák.** Power-upok, több pálya, drift-finomítás, hang. Csak a mag után.

## Vezetési modell (a legfontosabb rész)

A Planck.js nem tud autót a dobozból — kézzel kell felépíteni. A vezetési élmény kulcsa
az **oldalirányú tapadás (lateral traction)**:

- Minden képkockában számold ki az autó test **oldalirányú** sebességkomponensét
  (a haladási irányra merőlegeset).
- Ezt egy ellentétes impulzussal oltsd ki: teljesen, ha jó a tapadás → nem csúszik
  kanyarban; részlegesen, ha driftel.
- Gyorsítás: erő (force) az autó test előre irányában. Fékezés/tolatás: ellentétes erő.
- Kormányzás legyen **sebességfüggő** — álló autó ne forduljon helyben.
- Drift = az oldalsó tapadás szándékos, részleges elengedése.

Referencia keresőszó: "top-down car physics Box2D".

**Planck-csapda:** a `vec.mul()` INSTANCE metódus in-place mutálja a vektort!
Megosztott vektoron mindig a statikus `Vec2.mul(v, skalár)`-t használd (új vektort
ad) — az instance-verzió már okozott 400 km/h-s numerikus robbanást.

**Kritikus:** az összes hangolható paramétert (tömeg, súrlódási együtthatók,
motorerő, fékerő, oldaltapadás mértéke, max sebesség, kormányzási sebesség) tedd EGY
helyre, jól elnevezett konstansokba/config objektumba. Az élvezhetőség ~90%-a a
paraméter-hangolásban dől el, és menet közben sokat kell majd csavarni rajtuk.
A Vite hot reload pont ezt segíti.

## Szerver-döntőbíró (authoritative server) — már most készülj rá

A multiplayer authoritative-server modellt használ: a szerver futtatja az "igazi"
játékot, a kliensek csak inputot küldenek és megjelenítenek. Ebből következik:

- A **verseny-logikát** (ki hányadik körben jár, ki lépett át checkpointot, ki nyert)
  írd **tiszta, izolált függvényekbe**, amik ugyanúgy lefutnak kliensen és szerveren.
  NE drótozd a kliens rendering-kódjába — különben a 3. fázisban újra kell írni.
- A fizika-lépés is legyen olyan, hogy a szerver (Node alatt futó Planck.js) le tudja
  futtatni ugyanazzal az eredménnyel (determinisztikus lépés, fix timestep).

## Netcode modell (4. fázisban)

Gabriel Gambetta "Fast-Paced Multiplayer" cikksorozata az alapolvasmány. Három elem:

- **Client-side prediction:** a saját autót azonnal mozgatod input alapján, nem vársz
  a szerverre.
- **Server reconciliation:** amikor jön a szerver hivatalos állapota, korrigálsz, ha
  eltértél.
- **Entity interpolation:** a TÖBBI játékos autóját két szerver-snapshot között simán
  interpolálod.

Hálózat: WebSocket (nem HTTP-polling). Éles környezetben `wss://` (TLS) kell.

## Lokális fejlesztői környezet

- `npm install` a függőségekre
- `npm run dev` → Vite dev-szerver (kb. localhost:5173), hot reload
- Multiplayer teszt (3. fázistól): a Colyseus szerver külön porton (kb. localhost:2567),
  a kliens `ws://localhost:2567`-hez csatlakozik. Két böngészőablak egymás mellett =
  két játékos szimulálása, internet nélkül. Két terminál kell: egyik a Vite, másik a
  Colyseus szerver.

## Hosting

- **Fejlesztéshez/teszteléshez:** Railway trial ($5 kredit, 30 nap, kártya nélkül).
  FONTOS: regisztrációkor kösd össze a GitHub-fiókot, hogy teljes hálózati hozzáférést
  kapj (verifikáció nélkül korlátozott portok/kimenő hálózat — WebSocketnél zavaró).
- **Tartós üzemhez:** Railway Hobby ($5/hó) VAGY egy kis VPS (pl. Hetzner ~4–5 €/hó),
  nginx reverse proxy + pm2 folyamatkezelővel. A VPS kiszámíthatóbb havidíj; a Railway
  usage-alapú számlája meg tud lepni forgalmi csúcsnál.
- A statikus kliens (HTML/JS/assetek) bármilyen tárhelyről/CDN-ről mehet — csak a
  Node játékszervernek kell perzisztens process-hosting.

## Kezdő feladat javaslat

Fázis 1: állítsd fel a projekt vázát (Vite + Phaser + Planck.js), egy pálya zárt
körrel és falütközéssel, egy autó oldaltapadásos vezetési modellel, követő kamerával.
A hangolható paraméterek egy külön config fájlban/objektumban.
