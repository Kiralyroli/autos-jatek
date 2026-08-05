// =============================================================================
//  MULTIPLAYER JÁTÉKSZERVER (3. fázis) — Colyseus + a közös sim-réteg.
//
//  Ugyanez a folyamat szolgálja ki a lebuildelt klienst (dist/) statikus
//  fájlként ÉS a Colyseus WebSocket szerverét is — egy origin, egy Railway
//  szolgáltatás, egy domain (nincs cross-origin ws gond).
//
//  Indítás: `npm run server` (localhost:2567). A kliens (Vite, localhost:5173)
//  WebSocketen csatlakozik; a matchmaking HTTP-hívásaihoz kell a CORS.
// =============================================================================
// LEGELSŐ import, szándékosan: a .env-et be kell tölteni, MIELŐTT bármelyik másik
// modul (security.js ADMIN_TOKEN, trackStore.js DATA_DIR) modul-szinten kiolvasná
// a process.env-et. Lásd a loadEnv.js fejlécét.
import './loadEnv.js';
import { createServer } from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const require = createRequire(import.meta.url);
// A colyseus/express/cors CJS csomagok — Node ESM-ből createRequire-rel megbízható.
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const express = require('express');
const cors = require('cors');

import { RaceRoom } from './RaceRoom.js';
import { listTracks, getTrack, saveTrack, deleteTrack } from './trackStore.js';
import { listEntries, recordLap, deleteEntry, clearBoard, getGhost } from './leaderboardStore.js';
import { resolveJoinCode } from './roomCodes.js';
import {
  requireAdmin,
  adminTokenConfigured,
  rateLimit,
  securityHeaders,
  corsOptions,
} from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 2567;

const app = express();

// A forgalomkorlátozás IP-nként számol, ezért a VALÓDI kliens-IP kell — ez pedig
// attól függ, van-e reverse proxy a szerver előtt. A beállítás MINDKÉT irányban
// veszélyes, ha rosszul találjuk el, ezért NEM tippelünk, hanem explicit döntünk:
//
//  - Proxy mögött (Railway) `trust proxy = 1` KELL, különben minden kérés a proxy
//    egyetlen címéről érkezőnek látszik, és az első korlát az ÖSSZES játékost
//    együtt zárja ki. Az `1` a proxy által hozzáfűzött (tehát nem hamisítható)
//    utolsó XFF-címet veszi; a támadó saját fejléce attól balra kerül.
//  - Proxy NÉLKÜL viszont bekapcsolva a korlát MEGKERÜLHETŐ: mérve, hogy egy
//    kézzel küldött `X-Forwarded-For: 9.9.9.<i>` fejléccel 25/25 kérés átment a
//    20-as limiten, mert nincs proxy, ami felülírná. Ezért alapból KI van kapcsolva.
//
// A Railway a saját környezeti változóit mindig beállítja — ebből ismerjük fel a
// proxy mögötti futást; kézzel a TRUST_PROXY env-változóval bármikor felülírható.
const behindProxy =
  process.env.TRUST_PROXY !== undefined
    ? process.env.TRUST_PROXY !== '0' && process.env.TRUST_PROXY !== ''
    : Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
app.set('trust proxy', behindProxy ? 1 : false);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(cors(corsOptions));
// 1 MB → 256 KB: a legnagyobb jogos kérés (egy teljes pálya layout+dekorációkkal)
// bőven belefér, egy felfújt kérés viszont ne foglaljon feleslegesen memóriát.
app.use(express.json({ limit: '256kb' }));

// Végpont-csoportonkénti korlátok. Az olvasás bőkezű (a menü több hívást is indít
// egy pálya-váltásnál), az írás és a szoba-kód feloldás szigorú.
const readLimit = rateLimit({ name: 'read', limit: 300, windowMs: 60_000 });
const writeLimit = rateLimit({
  name: 'write',
  limit: 30,
  windowMs: 60_000,
  message: 'Túl sok beküldés — várj egy percet.',
});
// A 4 jegyű kód mindössze 9000 lehetőség: korlát nélkül percek alatt végig lehetne
// próbálni az összeset, és bejelentkezni MINDEN épp futó privát szobába.
const joinCodeLimit = rateLimit({
  name: 'joincode',
  limit: 20,
  windowMs: 60_000,
  message: 'Túl sok szoba-kód próbálkozás — várj egy percet.',
});
const adminLimit = rateLimit({
  name: 'admin',
  limit: 60,
  windowMs: 60_000,
  message: 'Túl sok adminisztratív kérés.',
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// A rövid, számokból álló csatlakozási kód (lásd roomCodes.js) feloldása a
// tényleges Colyseus roomId-ra — a kliens ezt hívja meg join előtt.
app.get('/api/room-code/:code', joinCodeLimit, (req, res) => {
  const roomId = resolveJoinCode(req.params.code);
  if (!roomId) return res.status(404).json({ error: 'Nincs ilyen szoba-kód.' });
  res.json({ roomId });
});

// --- Globális pálya-katalógus REST API (szerkesztő + főmenü pálya-választó) ---
// A pályák a szerveren élnek (trackStore), így minden gépről elérhetők.
//
// OLVASÁS: bárkinek (a játékhoz kell). ÍRÁS/TÖRLÉS: CSAK admin — a pálya-szerkesztő
// amúgy is dev-módhoz kötött (src/editor.js), tehát a mentés jogosan admin-művelet.
// Enélkül bárki felülírhatná mások pályáját (a mentés NÉVRE upsertel!), vagy
// egyetlen paranccsal kitörölhetné az összeset.
app.get('/api/tracks', readLimit, (_req, res) => {
  res.json({ tracks: listTracks() });
});
app.get('/api/tracks/:id', readLimit, (req, res) => {
  const t = getTrack(req.params.id);
  if (!t) return res.status(404).json({ error: 'Nincs ilyen pálya.' });
  res.json({
    id: t.id,
    name: t.name,
    layout: t.layout,
    decorations: t.decorations,
    pitLane: t.pitLane,
    editorPath: t.editorPath,
    editorDecorations: t.editorDecorations,
  });
});
app.post('/api/tracks', adminLimit, requireAdmin, (req, res) => {
  const rec = saveTrack(req.body || {}, Date.now());
  if (!rec) return res.status(400).json({ error: 'Hibás pálya-adat vagy betelt a pálya-tár.' });
  res.json({ id: rec.id, name: rec.name });
});
app.delete('/api/tracks/:id', adminLimit, requireAdmin, (req, res) => {
  res.json({ ok: deleteTrack(req.params.id) });
});

// --- Örök ranglista REST API (pálya+fizika kombinációnként a legjobb köridők) ---
// Az egyjátékos kliens ide küldi a saját köreit; a multiplayer szerver (RaceRoom)
// UGYANEZT a modult közvetlenül (HTTP nélkül) hívja, mert ott már authoritative.
//
// A BEKÜLDÉS szándékosan nyitva marad (minden játékosnak be kell tudnia küldeni a
// körét, és nincs felhasználó-kezelés) — itt a védelem a forgalomkorlátozás + a
// fizikai hihetőség-ellenőrzés (server/lapValidation.js) + a tábla méret-korlátja.
// A TÖRLÉS viszont admin-művelet (a kliensen is csak dev módban látszik a gomb).
app.get('/api/leaderboard/:trackKey/:physics', readLimit, (req, res) => {
  res.json({ entries: listEntries(req.params.trackKey, req.params.physics) });
});
// Ghost car (Hot Lap): egy KONKRÉT bejegyzés rögzített (x,y,angle) mintasora —
// KÜLÖN végponton, nem a listánál (lásd leaderboardStore.js listEntries
// megjegyzése), mert csak akkor kell, amikor a játékos ténylegesen kiválasztja.
app.get('/api/leaderboard/:trackKey/:physics/:playerName/ghost', readLimit, (req, res) => {
  const ghost = getGhost(req.params.trackKey, req.params.physics, req.params.playerName);
  if (!ghost) return res.status(404).json({ error: 'Nincs ghost ehhez a bejegyzéshez.' });
  res.json({ ghost });
});
app.post('/api/leaderboard', writeLimit, (req, res) => {
  const rec = recordLap(req.body || {}, Date.now());
  if (!rec) return res.status(400).json({ error: 'Hibás vagy hihetetlen köridő-adat.' });
  res.json({ ok: true });
});
app.delete('/api/leaderboard/:trackKey/:physics/:playerName', adminLimit, requireAdmin, (req, res) => {
  res.json({ ok: deleteEntry(req.params.trackKey, req.params.physics, req.params.playerName) });
});
app.delete('/api/leaderboard/:trackKey/:physics', adminLimit, requireAdmin, (req, res) => {
  res.json({ removed: clearBoard(req.params.trackKey, req.params.physics) });
});

// Cache-fejlécek — élesben ez rövidíti a pálya/fizika-váltás (vagy bármi más)
// miatti kliens-reload idejét (a böngésző a MÁR letöltött fájlokat a hálózat
// helyett a saját cache-éből adja), ami közvetlenül segít a 60 mp-es
// visszacsatlakozási ablakon belül maradni (lásd RaceRoom.js onLeave).
// Express `static` alapból NEM cache-el (maxAge=0) — enélkül MINDEN reload
// újra letölti a teljes JS-bundle-t (~900 KB) + a kiválasztott autó GLB-jét.
app.use(
  express.static(DIST_DIR, {
    setHeaders: (res, filePath) => {
      if (/\.(js|css)$/.test(filePath)) {
        // A Vite ezekbe a fájlnevekbe TARTALOM-HASHT tesz (pl. main-XXXX.js)
        // — a tartalom változásakor MINDIG más fájlnév jön, ezért örökre,
        // agresszíven cache-elhető (soha nem lesz "elavult" ütközés).
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/\.(glb|png|jpe?g|mp3|wav|ogg)$/.test(filePath)) {
        // A public/ mappából VÁLTOZATLAN névvel másolt assetek (GLB modellek,
        // textúrák, hangok) NEM hash-eltek — ha valaha manuálisan lecseréled
        // ugyanazon a néven (ahogy korábban egy textúránál is történt), az
        // örök cache makacsul megtartaná a régit. Mérsékelt (1 órás) cache:
        // a gyakori reload-oknál még mindig sokat segít, de nem ragad be
        // tartósan.
        res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
      } else {
        // index.html/editor.html — MINDIG friss kell legyen, hiszen ez
        // hivatkozik a ténylegesen aktuális hash-elt JS-fájlokra.
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('race', RaceRoom);

httpServer.listen(PORT, () => {
  console.log(`🏁 Autós játék multiplayer szerver fut: ws://localhost:${PORT}`);
  console.log(
    adminTokenConfigured()
      ? '🔒 ADMIN_TOKEN beállítva — a pálya-mentés/törlés távolról is elérhető vele.'
      : '🔒 Nincs ADMIN_TOKEN — a pálya-mentés/törlés CSAK a szervergépről (localhost) megy.'
  );
  console.log(
    behindProxy
      ? '🌐 trust proxy BE — a kliens-IP az X-Forwarded-For-ból (reverse proxy mögött).'
      : '🌐 trust proxy KI — a kliens-IP a közvetlen kapcsolatból (nincs proxy).'
  );
});
