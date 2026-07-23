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
import { listEntries, recordLap, deleteEntry, clearBoard } from './leaderboardStore.js';
import { resolveJoinCode } from './roomCodes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// A rövid, számokból álló csatlakozási kód (lásd roomCodes.js) feloldása a
// tényleges Colyseus roomId-ra — a kliens ezt hívja meg join előtt.
app.get('/api/room-code/:code', (req, res) => {
  const roomId = resolveJoinCode(req.params.code);
  if (!roomId) return res.status(404).json({ error: 'Nincs ilyen szoba-kód.' });
  res.json({ roomId });
});

// --- Globális pálya-katalógus REST API (szerkesztő + főmenü pálya-választó) ---
// A pályák a szerveren élnek (trackStore), így minden gépről elérhetők.
app.get('/api/tracks', (_req, res) => {
  res.json({ tracks: listTracks() });
});
app.get('/api/tracks/:id', (req, res) => {
  const t = getTrack(req.params.id);
  if (!t) return res.status(404).json({ error: 'Nincs ilyen pálya.' });
  res.json({
    id: t.id,
    name: t.name,
    layout: t.layout,
    decorations: t.decorations,
    editorPath: t.editorPath,
    editorDecorations: t.editorDecorations,
  });
});
app.post('/api/tracks', (req, res) => {
  const rec = saveTrack(req.body || {}, Date.now());
  if (!rec) return res.status(400).json({ error: 'Hibás pálya-adat.' });
  res.json({ id: rec.id, name: rec.name });
});
app.delete('/api/tracks/:id', (req, res) => {
  res.json({ ok: deleteTrack(req.params.id) });
});

// --- Örök ranglista REST API (pálya+fizika kombinációnként a legjobb köridők) ---
// Az egyjátékos kliens ide küldi a saját köreit; a multiplayer szerver (RaceRoom)
// UGYANEZT a modult közvetlenül (HTTP nélkül) hívja, mert ott már authoritative.
app.get('/api/leaderboard/:trackKey/:physics', (req, res) => {
  res.json({ entries: listEntries(req.params.trackKey, req.params.physics) });
});
app.post('/api/leaderboard', (req, res) => {
  const rec = recordLap(req.body || {}, Date.now());
  if (!rec) return res.status(400).json({ error: 'Hibás köridő-adat.' });
  res.json({ ok: true });
});
app.delete('/api/leaderboard/:trackKey/:physics/:playerName', (req, res) => {
  res.json({ ok: deleteEntry(req.params.trackKey, req.params.physics, req.params.playerName) });
});
app.delete('/api/leaderboard/:trackKey/:physics', (req, res) => {
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
});
