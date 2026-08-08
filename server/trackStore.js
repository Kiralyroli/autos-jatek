// =============================================================================
//  GLOBÁLIS PÁLYA-TÁR (szerver-oldal). A szerkesztőben mentett pályák itt élnek,
//  így MINDEN gépről/böngészőből elérhetők (nem csak a létrehozó localStorage-ában).
//
//  Tárolás: egyszerű JSON fájl a DATA_DIR könyvtárban. Railway-en ez egy PERZISZTENS
//  VOLUME-ra mutasson (env: DATA_DIR=/data) — enélkül minden újradeploy törölné.
//  Lokálisan a repo-beli ./data mappát használja (a .gitignore kihagyja).
//
//  Formátum: { tracks: [ { id, name, layout, decorations, createdAt, updatedAt } ] }
//  A pálya-adat ugyanaz, mint a kliens localStorage-formátuma:
//    layout: [{ type, turn?, n? }, ...]
//    decorations: [{ type, dgx, dgy, rot, scale }, ...]
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { hashLayout } from '../src/sim/trackKey.js';
import { RACE } from '../src/config.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const FILE = join(DATA_DIR, 'tracks.json');

// Épp elégséges korlátok az abúzus/hibás adat ellen.
const MAX_NAME = 40;
const MAX_LAYOUT = 1000;
const MAX_DECOR = 5000;
const MAX_EDITOR_CELLS = 2000;
// A tárolható pályák FELSŐ korlátja — enélkül egy szkriptelt POST-áradat
// korlátlanul növelné a tracks.json-t (lemez + memória kimerítése). A limit
// felett új pálya nem jön létre; a MEGLÉVŐK felülírása (upsert névre) továbbra
// is megy, tehát a normál szerkesztő-használatot nem akasztja meg.
const MAX_TRACKS = 200;
// A világkoordináták értelmes tartománya (m). Korlát nélkül egy 1e9 nagyságú
// koordináta a spline-mintavételezésnél (2 méterenként!) gyakorlatilag végtelen
// pontot generálna → a szerver befagyna egyetlen kérésre. Lásd sanitizeLayout.
const MAX_COORD = 10000;
// A pálya középvonalának FELSŐ hossz-korlátja (m). A koordináta-clamp ÖNMAGÁBAN
// NEM elég: 1000 kontrollpont a megengedett tartomány két ellentétes sarka közt
// cikcakkozva ~28 000 km úthosszt ad, amit a trackFactory 2 méterenként mintavételez
// → 14 millió pont. MÉRVE: pontosan ez a layout `FATAL ERROR: JavaScript heap out of
// memory`-val megölte a Node-folyamatot — és ez a multiplayer szoba-létrehozás
// útján (RaceRoom.onCreate → createTrackState) HITELESÍTÉS NÉLKÜL elérhető volt.
// 20 km nagyságrendekkel több minden valós pályánál (az alappálya ~306 m).
const MAX_TRACK_LENGTH = 20000;
// Ugyanez a csempe-alapú formátumra: a szegmensek `n`/`size` mezői közvetlenül
// szorozzák a generált csempeszámot, ezért a SZUMMÁJUKAT is korlátozni kell.
const MAX_TOTAL_TILES = 2000;
// Boxutca-útvonal (lásd sanitizePitLane) — UGYANAZ a védelmi elv, mint a
// layout-nál: a szerver minden fizika-lépésben végigfut a pontokon
// (server/raceTracker.js distanceToPitLane), tehát a pontszám és a teljes
// hossz is korlátos kell legyen, nem csak a koordináták.
const MAX_PIT_LANE_POINTS = 200;
const MAX_PIT_LANE_LENGTH = 2000; // m — bőven elég egy boxutcához (a fő pálya limitje 20000)

let cache = null; // { tracks: [...] } — memóriában, lemezre íráskor szinkronban

function load() {
  if (cache) return cache;
  try {
    if (existsSync(FILE)) {
      const data = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = data && Array.isArray(data.tracks) ? data : { tracks: [] };
    } else {
      cache = { tracks: [] };
    }
  } catch {
    cache = { tracks: [] };
  }
  return cache;
}

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    console.error('Pálya-tár mentési hiba:', e.message);
  }
}

// A layout KÉTFÉLE FORMÁTUMÚ lehet — lásd src/sim/trackFactory.js isSplineLayout
// (ugyanaz az apró, importok nélküli diszkrimináló, mint ott és trackKey.js-ben):
// a régi (rács/szegmens) minden eleme {type,...}, az új (szabadvonalas) csak
// {x,z} kontrollpontokból áll.
function isSplineLayoutArr(arr) {
  return arr.length > 0 && arr[0] && typeof arr[0].x === 'number' && arr[0].type === undefined;
}

// Egy világkoordináta befogása az értelmes tartományba (lásd MAX_COORD).
const clampCoord = (v) => Math.max(-MAX_COORD, Math.min(MAX_COORD, v));

// A LAYOUT megtisztítása/validálása — hibás adatra null.
//
// EXPORTÁLT, mert nem csak a REST-mentés útján érkezhet layout: a multiplayer
// szoba is a KLIENSTŐL kapja (createRoom options.layout, illetve a host
// 'hostSettings' üzenete), és a szerver abból pálya-geometriát ÉPÍT
// (createTrackState). Validálatlanul egy rosszindulatú layout (több ezer
// kontrollpont, csillagászati koordinátákkal) ott is megfoghatná a
// szerverfolyamatot — ezért ugyanez a szűrő fut mindkét úton.
export function sanitizeLayout(layout) {
  if (!Array.isArray(layout) || layout.length === 0 || layout.length > MAX_LAYOUT) return null;
  if (isSplineLayoutArr(layout)) {
    const clean = layout
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z))
      .map((p) => {
        const pt = { x: clampCoord(p.x), z: clampCoord(p.z) };
        // Szakaszonkénti pálya-szélesség (lásd src/sim/trackSpline.js) — opcionális,
        // a régebbi (e funkció előtt mentett) pontoknál nincs, a trackFactory.js
        // ilyenkor a pálya alap-szélességére (tile) esik vissza.
        if (Number.isFinite(p.width) && p.width > 0) pt.width = Math.min(p.width, 200);
        // Éles sarok (törésponttá teszi a görbét, lásd src/sim/trackSpline.js)
        // — opcionális, csak akkor mentjük, ha ténylegesen be van kapcsolva.
        if (p.sharp === true) pt.sharp = true;
        return pt;
      });
    // lásd src/sim/trackValidation.js MIN_CONTROL_POINTS
    if (clean.length < 4) return null;
    // A kontrollpontokon végigfutó útvonal teljes hossza (a záró szakasszal
    // együtt, hiszen a pálya zárt hurok) — lásd MAX_TRACK_LENGTH.
    let pathLen = 0;
    for (let i = 0; i < clean.length; i++) {
      const a = clean[i];
      const b = clean[(i + 1) % clean.length];
      pathLen += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return pathLen <= MAX_TRACK_LENGTH ? clean : null;
  }
  const clean = layout
    .filter((s) => s && typeof s.type === 'string' && s.type.length <= 20)
    .map((s) => {
      const seg = { type: s.type };
      if (Number.isFinite(s.turn)) seg.turn = s.turn;
      // Az `n` (szakasz-hossz csempében) és a `size` (kanyar-sugár) közvetlenül
      // szorozza a generált geometria méretét — kötelező felső korlát.
      if (Number.isFinite(s.n)) seg.n = Math.max(1, Math.min(500, Math.round(s.n)));
      if (Number.isFinite(s.size)) seg.size = Math.max(1, Math.min(50, Math.round(s.size)));
      return seg;
    });
  if (clean.length === 0) return null;
  // A csempék SZUMMÁJA is korlátos (lásd MAX_TOTAL_TILES) — a szegmensenkénti
  // korlát önmagában még mindig 1000 × 500 csempét engedne.
  const totalTiles = clean.reduce((sum, s) => sum + (s.n ?? 1) + (s.size ?? 0), 0);
  return totalTiles <= MAX_TOTAL_TILES ? clean : null;
}

// A boxutca-útvonal megtisztítása/validálása — OPCIONÁLIS adat, tehát hibás/
// hiányzó/túl nagy bemenetre üres tömböt ad (nem null-t — a hívó ilyenkor
// egyszerűen "nincs boxutca ezen a pályán"-ként kezeli), SOSEM utasítja el a
// teljes pálya-mentést emiatt. EXPORTÁLT, mert — ugyanúgy, mint sanitizeLayout
// — nem csak a REST-mentés útján érkezhet: a multiplayer szoba is a
// KLIENSTŐL kapja (createRoom options.pitLane / hostSettings), és a szerver
// minden fizika-lépésben végigfut rajta (server/raceTracker.js
// distanceToPitLane) — validálatlanul ez is a szerverfolyamatot foghatná meg.
// A tömb TETSZŐLEGES SZÁMÚ (legfeljebb RACE.pitStop.maxBoxes) plusz, KÜLÖN
// "boxhely" pontot is tartalmazhat ({x,z,isBox:true}) — ezek NEM az útvonal
// RÉSZEI (lásd src/sim/race.js splitPitLane), ezért a hossz-korlátot csak a
// valódi útvonal-pontokra mérjük, a boxhelyeket külön kezeljük (a
// maxBoxes fölötti többletet eldobjuk).
export function sanitizePitLane(points) {
  if (!Array.isArray(points) || points.length === 0 || points.length > MAX_PIT_LANE_POINTS) return [];
  const clean = points
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z))
    .map((p) =>
      p.isBox
        ? { x: clampCoord(p.x), z: clampCoord(p.z), isBox: true }
        : { x: clampCoord(p.x), z: clampCoord(p.z) }
    );
  const boxes = clean.filter((p) => p.isBox).slice(0, RACE.pitStop.maxBoxes);
  const path = clean.filter((p) => !p.isBox);
  if (path.length < 2) return [];
  let len = 0;
  for (let i = 0; i < path.length - 1; i++) {
    len += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
  }
  if (len > MAX_PIT_LANE_LENGTH) return [];
  return [...path, ...boxes];
}

// A bejövő pálya-adat megtisztítása/validálása. Hibás adatra null-t ad.
function sanitize({ name, layout, decorations, pitLane, editorPath, editorDecorations }) {
  if (typeof name !== 'string') return null;
  const cleanName = name.trim().slice(0, MAX_NAME);
  if (!cleanName) return null;

  const cleanLayout = sanitizeLayout(layout);
  if (!cleanLayout) return null;

  const rawDecor = Array.isArray(decorations) ? decorations : [];
  if (rawDecor.length > MAX_DECOR) return null;
  const cleanDecor = rawDecor
    .filter((d) => d && typeof d.type === 'string' && d.type.length <= 30)
    .map((d) => ({
      type: d.type,
      dgx: clampCoord(Number(d.dgx) || 0),
      dgy: clampCoord(Number(d.dgy) || 0),
      rot: Number(d.rot) || 0,
      scale: Math.max(0.3, Math.min(3, Number(d.scale) || 1)),
    }));

  const clean = { name: cleanName, layout: cleanLayout, decorations: cleanDecor, pitLane: sanitizePitLane(pitLane) };

  // Opcionális "editor-nézet" — a szerkesztőben pontosan úgy jelenjen meg
  // (tájolás + pozíció), ahogy rajzolták (WYSIWYG). A JÁTÉK ezt figyelmen kívül
  // hagyja; csak a layout + decorations kanonikus (kelet-kezdésű) adatot használja.
  if (Array.isArray(editorPath) && editorPath.length > 0 && editorPath.length <= MAX_EDITOR_CELLS) {
    clean.editorPath = editorPath
      .filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.y))
      .map((c) => {
        const cell = { x: c.x, y: c.y };
        if (Number.isFinite(c.cornerSize)) cell.cornerSize = c.cornerSize;
        return cell;
      });
  }
  if (Array.isArray(editorDecorations) && editorDecorations.length <= MAX_DECOR) {
    clean.editorDecorations = editorDecorations
      .filter((d) => d && typeof d.type === 'string' && d.type.length <= 30)
      .map((d) => ({
        gx: clampCoord(Number(d.gx) || 0),
        gy: clampCoord(Number(d.gy) || 0),
        type: d.type,
        rot: Number(d.rot) || 0,
      }));
  }

  return clean;
}

// Metaadat-lista (a katalógushoz) — a nehéz layout/decor NÉLKÜL, névre rendezve.
// A trackKey (a layout GEOMETRIÁJÁHOZ kötött, névtől független azonosító) itt is
// szerepel — így a kliens az örök ranglistát tud lekérni anélkül, hogy a teljes
// pálya-adatot (getTrack) külön le kellene töltenie csak a kulcs kiszámolásához.
export function listTracks() {
  return load()
    .tracks.map((t) => ({
      id: t.id,
      name: t.name,
      trackKey: hashLayout(t.layout),
      segments: t.layout.length,
      decorations: t.decorations.length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'));
}

// Egy pálya TELJES adata (layout + decorations) id alapján. null, ha nincs ilyen.
export function getTrack(id) {
  return load().tracks.find((t) => t.id === id) || null;
}

// A tárolt pályák NYERS rekordjai — a köridő-hihetőség ellenőrzéséhez kell
// (server/lapValidation.js: a trackKey-hez tartozó layout megkeresése, hogy a
// pálya tényleges hosszából jöjjön a minimális elfogadható köridő).
export function listRawTracks() {
  return load().tracks;
}

// Pálya mentése. Ha már van AZONOS NEVŰ, felülírja (upsert névre) — így a
// szerkesztőben ugyanazzal a névvel újramentés frissít, nem duplikál.
// Visszaadja a mentett rekordot, vagy null-t hibás adatnál.
export function saveTrack(input, nowMs) {
  const clean = sanitize(input);
  if (!clean) return null;
  const db = load();
  const ts = Number.isFinite(nowMs) ? nowMs : 0;

  const existing = db.tracks.find((t) => t.name === clean.name);
  if (existing) {
    existing.layout = clean.layout;
    existing.decorations = clean.decorations;
    existing.pitLane = clean.pitLane;
    existing.editorPath = clean.editorPath;
    existing.editorDecorations = clean.editorDecorations;
    existing.updatedAt = ts;
    persist();
    return existing;
  }
  // ÚJ pálya csak a felső korlátig (lásd MAX_TRACKS) — a meglévők felülírása
  // (a fenti ág) korlátlan marad, tehát a szerkesztő normál használata megy tovább.
  if (db.tracks.length >= MAX_TRACKS) return null;
  const rec = {
    id: randomUUID(),
    name: clean.name,
    layout: clean.layout,
    decorations: clean.decorations,
    pitLane: clean.pitLane,
    editorPath: clean.editorPath,
    editorDecorations: clean.editorDecorations,
    createdAt: ts,
    updatedAt: ts,
  };
  db.tracks.push(rec);
  persist();
  return rec;
}

// Pálya törlése id alapján. true, ha törölt valamit.
export function deleteTrack(id) {
  const db = load();
  const before = db.tracks.length;
  db.tracks = db.tracks.filter((t) => t.id !== id);
  if (db.tracks.length !== before) {
    persist();
    return true;
  }
  return false;
}
