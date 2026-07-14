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
//    decorations: [{ type, dgx, dgy, rot }, ...]
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
const FILE = join(DATA_DIR, 'tracks.json');

// Épp elégséges korlátok az abúzus/hibás adat ellen.
const MAX_NAME = 40;
const MAX_LAYOUT = 1000;
const MAX_DECOR = 5000;

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

// A bejövő pálya-adat megtisztítása/validálása. Hibás adatra null-t ad.
function sanitize({ name, layout, decorations }) {
  if (typeof name !== 'string') return null;
  const cleanName = name.trim().slice(0, MAX_NAME);
  if (!cleanName) return null;

  if (!Array.isArray(layout) || layout.length === 0 || layout.length > MAX_LAYOUT) return null;
  const cleanLayout = layout
    .filter((s) => s && typeof s.type === 'string')
    .map((s) => {
      const seg = { type: s.type };
      if (Number.isFinite(s.turn)) seg.turn = s.turn;
      if (Number.isFinite(s.n)) seg.n = s.n;
      if (Number.isFinite(s.size)) seg.size = s.size;
      return seg;
    });
  if (cleanLayout.length === 0) return null;

  const rawDecor = Array.isArray(decorations) ? decorations : [];
  if (rawDecor.length > MAX_DECOR) return null;
  const cleanDecor = rawDecor
    .filter((d) => d && typeof d.type === 'string')
    .map((d) => ({
      type: d.type,
      dgx: Number(d.dgx) || 0,
      dgy: Number(d.dgy) || 0,
      rot: Number(d.rot) || 0,
    }));

  return { name: cleanName, layout: cleanLayout, decorations: cleanDecor };
}

// Metaadat-lista (a katalógushoz) — a nehéz layout/decor NÉLKÜL, névre rendezve.
export function listTracks() {
  return load()
    .tracks.map((t) => ({
      id: t.id,
      name: t.name,
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
    existing.updatedAt = ts;
    persist();
    return existing;
  }
  const rec = {
    id: randomUUID(),
    name: clean.name,
    layout: clean.layout,
    decorations: clean.decorations,
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
