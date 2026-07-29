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

1. **Single-player prototípus (KÉSZ).** Egy autó, egy pálya, jó vezetési
   élmény. Tisztán kliens-oldali, nincs szerver. Ez a fázis dönti el, hogy a játék
   élvezhető-e — a vezetésre kell ráhajtani, nem a funkciók számára.
2. **Verseny-logika (KÉSZ).** Checkpointok, körszámlálás, köridő, rajt/cél,
   visszaszámlálás. Plusz: pálya-szerkesztő, dekorációk, fű-büntetés, több mentett pálya.
3. **Colyseus szoba (KÉSZ, 2026-07-11).** Szoba létrehozás/csatlakozás kóddal, lobby,
   authoritative szerver-sim (server/RaceRoom.js — UGYANAZOKKAL a src/sim/* modulokkal),
   2-4 játékos, 20Hz snapshot-broadcast + entity interpolation a kliensen, élő állás,
   host-újraindítás, DNF-türelmi idő. Lokálisan tesztelve két böngészőablakban.
   Indítás: `npm run server` (Colyseus, :2567) + `npm run dev` (Vite, :5173).
4. **Netcode finomítás (KÖVETKEZŐ).** Client-side prediction + server reconciliation,
   hogy a saját autó ne az (interp-késleltetésű) szerver-visszhangból mozogjon.
   Plusz: a játékszerver kitétele az internetre (Railway/VPS) és a config.js
   NET.serverUrl beállítása (most 'wss://REPLACE-ME-DEPLOY-URL' a placeholder).
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

## Biztonság (2026-07-29)

A szerver a nyílt interneten fut, ezért a REST API-t nem elég a felületen elrejteni.
A védelem rétegei (`server/security.js` a központi modul):

**A "dev mód" NEM jogosultság.** A `src/devmode.js` csak a KLIENS gombjait kapcsolja
(localStorage flag) — bárki átállítja a konzolból, a `curl` meg amúgy is megkerüli.
Minden romboló műveletet a SZERVERNEK kell védenie.

- **Admin-hitelesítés (`requireAdmin`).** A pálya mentés/törlés és a ranglista-törlés
  admin-művelet. Loopbackről (a szervergépről) mindig szabad — ettől a lokális
  fejlesztés config nélkül megy. Távolról `ADMIN_TOKEN` env-változó kell, és a
  kérésnek fel kell mutatnia (`Authorization: Bearer …`). **Ha nincs ADMIN_TOKEN
  beállítva, a végpontok távolról TELJESEN tiltottak** (fail-closed) — egy elfelejtett
  env-változó nem nyitva, hanem zárva hagyja a rendszert.
  - Railway-en: `ADMIN_TOKEN` beállítása a service Variables közt. A kliens oldalon
    egyszer `?adminToken=…` az URL-ben (a kód azonnal kitörli a címsorból), utána a
    localStorage-ból megy; 401 esetén a szerkesztő rákérdez.
- **Forgalomkorlátozás (`rateLimit`).** IP + végpont-csoportonként, memóriában, külső
  csomag nélkül. Olvasás 300/perc, írás 30/perc, admin 60/perc, szoba-kód 20/perc.
- **`trust proxy` — kétélű, ezért explicit.** Proxy mögött (Railway) KELL, különben
  minden kérés a proxy egy IP-jéről érkezőnek látszik, és az első korlát az ÖSSZES
  játékost együtt zárja ki. Proxy NÉLKÜL viszont bekapcsolva a korlát megkerülhető
  hamis `X-Forwarded-For` fejléccel (mérve: 25/25 kérés átment a 20-as limiten).
  Ezért: Railway-env automatikus felismerés, `TRUST_PROXY` env-változóval felülírható,
  és a szerver induláskor KIÍRJA, melyik módban fut.
- **CORS-allowlist.** Korábban `cors()` = mindenki. Most: azonos origin + localhost dev
  + `ALLOWED_ORIGINS`. Fontos, mit véd: csak a BÖNGÉSZŐből, idegen oldalról indított
  kérést — a `curl` ellen semmit (az ellen a token + rate limit + validáció véd).
- **CSP + védelmi fejlécek.** A `script-src 'self'` a tárolt XSS második védvonala.
  A build nem tartalmaz inline `<script>`-et, ezért ez nem tör el semmit; a beágyazott
  `<style>` miatt a `style-src`-nél viszont kell `'unsafe-inline'`.
- **XSS: escape a kimeneten.** Ami NEM tőlünk jön (játékosnév, PÁLYANÉV), az
  `escapeHtml`-en át kerülhet csak `innerHTML`-be (`src/main.js`). Ez volt a valódi
  rés: egy `<img src=x onerror=…>` nevű pálya MINDEN játékos böngészőjében lefutott,
  amikor megnyitotta a pálya-választót.
- **Köridő-hihetőség (`server/lapValidation.js`).** A játék kliens-autoritatív, tehát
  a köridőt a kliens jelenti — teljes csalás-védelem nincs. Ami olcsón kizárható: a
  fizikailag lehetetlen idő (pálya hossza / csúcssebesség). Az alappályán ez ~3,6 s;
  a "0,5 másodperces kör" beküldés elutasításra kerül.
- **Méret-korlátok = DoS-védelem.** `MAX_TRACKS`, tábla-méret, kérés-törzs 256 KB.

**A legfontosabb buktató, amit itt megtaláltunk:** a koordináta-clamp ÖNMAGÁBAN nem
elég. 1000 kontrollpont a megengedett tartomány két ellentétes sarka közt cikcakkozva
~28 000 km úthosszt ad, amit a `trackFactory` 2 méterenként mintavételez → 14 millió
pont → **`FATAL ERROR: JavaScript heap out of memory`, a Node-folyamat meghal**. És ez
a multiplayer szoba-létrehozás útján (`RaceRoom.onCreate` → `createTrackState`)
HITELESÍTÉS NÉLKÜL elérhető volt. Ezért a `sanitizeLayout` (server/trackStore.js) a
teljes ÚTHOSSZT is korlátozza (`MAX_TRACK_LENGTH`), a csempés formátumnál pedig a
csempék SZUMMÁJÁT (`MAX_TOTAL_TILES`) — a szegmensenkénti korlát nem elég.
**Tanulság: minden kliens-adat, amiből a szerver geometriát ÉPÍT, méret-korlátot igényel,
nem csak érték-korlátot.** Ugyanez a szűrő fut a REST-mentésen ÉS a Colyseus úton
(`onCreate` + `hostSettings`) — a host is "csak egy kliens".

## Ismert buktatók (gotchas)

Ezek a repóban (git-ben) élnek, tehát bármelyik session/fiók/gép automatikusan
látja őket, szemben a Claude személyes memóriájával, ami gépenként/felhasználónként
külön van és NEM utazik a projekttel.

**Deploy / Railway:**
- **A Railway Node-verziója RÉGEBBI, mint a fejlesztői gépé.** Éles crash-loopot
  okozott: a `package.json` `start` scriptjébe tett `node --env-file-if-exists=.env`
  flag (Node 22.9+) a lokális Node 24-en hibátlanul ment, a Railway-en viszont
  `node: bad option` → a konténer indulás után azonnal elszállt, végtelen ciklusban.
  **Tanulság: a `start`/`server` scriptek maradjanak sima `node server/index.js`,
  és semmilyen újabb Node-funkció ne legyen KÖTELEZŐ a szerver indulásához** —
  amire szükség van (pl. `.env` betöltés), azt kódból, verzió-függetlenül oldjuk meg
  (lásd `server/loadEnv.js`). Ha valaha mégis kell újabb Node, azt a `package.json`
  `engines.node` mezőjével kell KIKÉNYSZERÍTENI, nem feltételezni.
- A lokálisan működő futtatás tehát NEM bizonyítja, hogy élesben is elindul — a
  deploy utáni Railway-logot mindig nézd meg (a szerver induláskor kiírja az
  ADMIN_TOKEN és a trust proxy állapotát is).

**Fejlesztői munkafolyamat:**
- A Colyseus szerver (`server/*.js`) **NEM hot-reload-ol** — minden szerver-oldali
  kódváltás után a Node-folyamatot ki kell lőni és újraindítani
  (`node server/index.js`), különben a régi kód fut tovább. A Vite dev-szerver
  (kliens-oldal) viszont hot reload-ol.
- `npm run build` mindig kötelező ellenőrzés kliens-oldali változás után, mielőtt
  élesben/böngészőben tesztelünk.

**Three.js / render buktatók:**
- **Winding-order csapda**: kézzel épített `BufferGeometry` + `DoubleSide` anyag
  esetén, ha a háromszög-bejárási irány (winding) fordított, a `HemisphereLight` a
  sötét "föld" színt használja a világos "ég" helyett → zöld/fekete tónusú,
  hibásnak tűnő felület. Javítás: winding ellenőrzése/javítása, majd `FrontSide`
  használata (ne `DoubleSide`, ha a winding már garantáltan helyes).
- **"Bowtie" önmetszés**: két, azonos középpontú, de eltérő elforgatású
  keresztmetszeti pontot sima quaddal összekötve MATEMATIKAILAG garantáltan
  önmetsző geometriát kapunk (körbeli pontsorrend argumentum). Ilyenkor
  háromszög-legyezőt (fan) kell használni quad helyett.
- Kenney GLB-modellek horgony-pontját mindig a TÉNYLEGESEN kiszámított
  `Box3`-ból vezessük le, sosem hardkódolt konstansból — a node-szintű eltolás
  modellenként eltérhet.

**Multiplayer / Colyseus buktatók:**
- **Elkésett kliens-üzenetek**: kliens-autoritatív modellben egy korábbi
  versenyből/állapotból még "úton lévő" üzenet a szerveri reset UTÁN érkezhet meg
  (pl. új verseny indításakor). Generációszámláló (`raceGen`) + fázis-ellenőrzés
  nélkül ez hamis állapotváltásokat okoz (pl. az új verseny azonnal "véget ér").
- **Reload/rejoin csak `allowReconnection` + `reconnectionToken` +
  `client.reconnect()`-tel biztonságos** — sima `joinById`-vel történő
  újracsatlakozás elveszíti a host-szerepet, és ha a szoba emiatt átmenetileg
  kiürül, a Colyseus `autoDispose` azonnal megszüntetheti, mielőtt bárki
  visszatérne (pl. host-egyedüli tesztelésnél, vagy pálya/fizika-váltás utáni
  automatikus reload-nál).

**Verseny-logika buktatók:**
- A checkpoint-ellenőrzés szigorúan csak a "következő" checkpointot nézve
  BERAGADHAT, ha sarok-vágással egy checkpointot kihagyunk (a kör sosem
  fejeződik be). Kell egy előre-néző ablak, ami a kihagyást érvénytelen
  körként elfogadja, de nem blokkolja a kör lezárását.
- A `MIN_TURN_RADIUS` validáció szomszédos mintapontokból számolt körüljárt
  sugara zajos lehet (numerikus zaj a mintavételezésből) — szélesebb ablak
  (`CURVE_WINDOW`) kell a hamis "túl éles kanyar" hibák ellen.

**Tesztelési környezet-specifikus (Claude-nak, ha böngészőben tesztel):**
- Ha a böngésző-panel nincs "megjelenítve" (`document.hidden === true`), a
  `requestAnimationFrame` NEM fut, és a `screenshot` időtúllépést ad. Ilyenkor
  közvetlen DOM/esemény-kiváltás (`dispatchEvent`, közvetlen függvényhívás) +
  pixel-szintű (`getImageData`) ellenőrzés a megbízható alternatíva élő
  játékciklusra támaszkodó vizuális ellenőrzés helyett.

## Kezdő feladat javaslat

Fázis 1: állítsd fel a projekt vázát (Vite + Phaser + Planck.js), egy pálya zárt
körrel és falütközéssel, egy autó oldaltapadásos vezetési modellel, követő kamerával.
A hangolható paraméterek egy külön config fájlban/objektumban.
