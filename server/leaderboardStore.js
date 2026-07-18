// =============================================================================
//  ÖRÖK RANGLISTA (szerver-oldal) — pálya+fizika kombinációnként a legjobb
//  köridő játékosonként. Ugyanaz a JSON-fájl-alapú tárolás, mint a trackStore.js-é
//  (lásd ott a Railway-volume megjegyzést — DATA_DIR-re kell mutasson perzisztens
//  tároláshoz).
//
//  Kulcs: (trackKey, physics, playerName) — a trackKey a pálya GEOMETRIÁJÁHOZ
//  kötött, névtől független azonosító (lásd src/sim/trackKey.js), így átnevezés
//  nem "veszíti el" a ranglistát. Egy játékosnak (trackKey, physics) alatt CSAK a
//  legjobb köre marad — új beküldés csak akkor ír felül, ha gyorsabb.
//
//  Formátum: { entries: [ { trackKey, trackName, physics, playerName, lapTime, achievedAt } ] }
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const FILE = join(DATA_DIR, 'leaderboard.json');

const MAX_NAME = 40;
const MAX_ENTRIES_RETURNED = 50;
const MIN_LAP_TIME = 0.5; // s — enné rövidebb kör fizikailag lehetetlen, hibás adat
const MAX_LAP_TIME = 3600; // s — 1 óránál hosszabb "kör" biztosan hibás adat

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (existsSync(FILE)) {
      const data = JSON.parse(readFileSync(FILE, 'utf8'));
      cache = data && Array.isArray(data.entries) ? data : { entries: [] };
    } else {
      cache = { entries: [] };
    }
  } catch {
    cache = { entries: [] };
  }
  return cache;
}

function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    console.error('Ranglista-mentési hiba:', e.message);
  }
}

function cleanStr(s, maxLen) {
  return typeof s === 'string' ? s.trim().slice(0, maxLen) : '';
}

// Egy (trackKey, physics) alatti köridők, gyorsaság szerint növekvő sorrendben.
export function listEntries(trackKey, physics) {
  const key = cleanStr(trackKey, 64);
  const phys = cleanStr(physics, 32);
  if (!key || !phys) return [];
  return load()
    .entries.filter((e) => e.trackKey === key && e.physics === phys)
    .sort((a, b) => a.lapTime - b.lapTime)
    .slice(0, MAX_ENTRIES_RETURNED)
    .map((e) => ({ playerName: e.playerName, lapTime: e.lapTime, achievedAt: e.achievedAt }));
}

// Egy köridő beküldése. Csak akkor ír/frissít, ha ÚJ vagy JOBB, mint a játékos
// eddigi legjobbja ugyanahhoz a (trackKey, physics) kombinációhoz — így ide
// bármikor, akár minden kör után nyugodtan hívható (idempotens, nem ront).
// Visszaadja a mentett (esetleg változatlan) rekordot, vagy null-t hibás adatnál.
export function recordLap({ trackKey, trackName, physics, playerName, lapTime }, nowMs) {
  const key = cleanStr(trackKey, 64);
  const name = cleanStr(trackName, MAX_NAME) || 'Egyedi pálya';
  const phys = cleanStr(physics, 32);
  const player = cleanStr(playerName, MAX_NAME) || 'Játékos';
  const time = Number(lapTime);
  if (!key || !phys || !Number.isFinite(time) || time < MIN_LAP_TIME || time > MAX_LAP_TIME) {
    return null;
  }

  const db = load();
  const ts = Number.isFinite(nowMs) ? nowMs : 0;
  const existing = db.entries.find(
    (e) => e.trackKey === key && e.physics === phys && e.playerName === player
  );
  if (existing) {
    if (time >= existing.lapTime) return existing; // nem jobb — nincs teendő
    existing.lapTime = time;
    existing.trackName = name; // friss névvel is frissítjük (átnevezés esetén)
    existing.achievedAt = ts;
    persist();
    return existing;
  }
  const rec = { trackKey, trackName: name, physics: phys, playerName: player, lapTime: time, achievedAt: ts };
  db.entries.push(rec);
  persist();
  return rec;
}

// Egy játékos köridejének törlése (dev mód). true, ha törölt valamit.
export function deleteEntry(trackKey, physics, playerName) {
  const key = cleanStr(trackKey, 64);
  const phys = cleanStr(physics, 32);
  const player = cleanStr(playerName, MAX_NAME);
  const db = load();
  const before = db.entries.length;
  db.entries = db.entries.filter(
    (e) => !(e.trackKey === key && e.physics === phys && e.playerName === player)
  );
  if (db.entries.length !== before) {
    persist();
    return true;
  }
  return false;
}

// A TELJES tábla törlése egy (trackKey, physics) kombinációhoz (dev mód).
// Visszaadja, hány bejegyzés törlődött.
export function clearBoard(trackKey, physics) {
  const key = cleanStr(trackKey, 64);
  const phys = cleanStr(physics, 32);
  const db = load();
  const before = db.entries.length;
  db.entries = db.entries.filter((e) => !(e.trackKey === key && e.physics === phys));
  const removed = before - db.entries.length;
  if (removed > 0) persist();
  return removed;
}
