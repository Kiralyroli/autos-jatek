// Közös localStorage-kulcsok a pálya-szerkesztő (editor.html) és a játék (config.js /
// render3d/decorations.js) között. Mindkét oldal ugyanazon origón (Vite dev-szerver)
// fut, ezért a localStorage megosztott — a szerkesztőben mentett pálya azonnal
// betölthető.
//
// Két réteg van:
//   - "aktív" pálya (KEY): EZT tölti be a játék indításkor (config.js). A szerkesztő
//     minden mentés/betöltés/törlés-akciónál ezt is frissíti, hogy a "Vissza a
//     játékhoz" link mindig a legutóbb kiválasztott pályát indítsa.
//   - "mentett pályák" listája (LIST_KEY): NÉV → {layout, decorations} — ez teszi
//     lehetővé, hogy több pálya közül válogass a szerkesztőben (mentés névvel,
//     betöltés, törlés), nem csak egyetlen "aktuális" pályát szerkessz felülírva.
//
// Mentett formátum (mindkét helyen): { layout: [...], decorations: [{type, dgx, dgy, rot}, ...] }
//   dgx, dgy: rács-eltolás a pálya rajt-cellájától (lásd editor.js) — a játék ebből
//   számol világ-koordinátát: worldX = dgx * TRACK.tile, worldZ = dgy * TRACK.tile.
const KEY = 'autos-jatek:customTrack';
const LIST_KEY = 'autos-jatek:savedTracks';
const ACTIVE_NAME_KEY = 'autos-jatek:activeTrackName';

// A mentett pálya-layout beolvasása. Ha nincs elmentve, vagy hibás, null.
export function loadCustomLayout() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.layout) || data.layout.length === 0) return null;
    return data.layout;
  } catch {
    return null;
  }
}

// A mentett dekorációk beolvasása. Ha nincs elmentve, vagy hibás, üres tömb.
export function loadCustomDecorations() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data.decorations) ? data.decorations : [];
  } catch {
    return [];
  }
}

// Pálya + dekorációk mentése az AKTÍV (a játék által betöltött) slotba, név nélkül.
export function saveCustomTrack(layout, decorations) {
  localStorage.setItem(KEY, JSON.stringify({ layout, decorations: decorations || [] }));
}

export function clearCustomLayout() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(ACTIVE_NAME_KEY);
}

// --- Több, névvel elmentett pálya kezelése ---

function readTrackList() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeTrackList(list) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
}

// A mentett pályák neve, ábécésorrendben.
export function listSavedTracks() {
  return Object.keys(readTrackList()).sort((a, b) => a.localeCompare(b, 'hu'));
}

// Pálya mentése a megadott név alá (felülírja, ha már létezik ilyen nevű), ÉS
// egyből aktívvá is teszi (a "Vissza a játékhoz" ezt fogja elindítani).
export function saveNamedTrack(name, layout, decorations) {
  const list = readTrackList();
  list[name] = { layout, decorations: decorations || [] };
  writeTrackList(list);
  saveCustomTrack(layout, decorations);
  localStorage.setItem(ACTIVE_NAME_KEY, name);
}

// Egy elmentett pálya betöltése — visszaadja a {layout, decorations} adatot, ÉS
// aktívvá is teszi. Null, ha nincs ilyen nevű mentés.
export function loadNamedTrack(name) {
  const entry = readTrackList()[name];
  if (!entry) return null;
  saveCustomTrack(entry.layout, entry.decorations);
  localStorage.setItem(ACTIVE_NAME_KEY, name);
  return entry;
}

// Egy elmentett pálya törlése a listából (az aktív slotot nem érinti, ha épp az
// volt aktív, marad játszható, csak a listából tűnik el).
export function deleteSavedTrack(name) {
  const list = readTrackList();
  delete list[name];
  writeTrackList(list);
  if (localStorage.getItem(ACTIVE_NAME_KEY) === name) {
    localStorage.removeItem(ACTIVE_NAME_KEY);
  }
}

// A jelenleg aktív (a játék által betöltött) pálya neve, ha van ilyen.
export function getActiveTrackName() {
  return localStorage.getItem(ACTIVE_NAME_KEY);
}
