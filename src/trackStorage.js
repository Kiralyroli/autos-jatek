// Az AKTÍV pálya localStorage-kulcsa — a pálya-szerkesztő (editor.html), a főmenü
// (main.js) és a játék (config.js) között. Mindegyik ugyanazon az originen fut,
// így a localStorage megosztott: a kiválasztott/szerkesztett pálya azonnal betölthető.
//
// FONTOS: a több, névvel mentett pálya KATALÓGUSA már a SZERVEREN él (globális,
// minden gépről elérhető — lásd net/trackApi.js + server/trackStore.js). A
// localStorage itt CSAK az "épp melyik pálya induljon a játékban most" átadásra
// szolgál (a config.js az oldal (újra)töltésekor ebből az aktív slotból olvas).
//
// Aktív-slot formátum: { layout: [...], decorations: [{type, dgx, dgy, rot}, ...] }
//   dgx, dgy: rács-eltolás a pálya rajt-cellájától (lásd editor.js) — a játék ebből
//   számol világ-koordinátát: worldX = dgx * TRACK.tile, worldZ = dgy * TRACK.tile.
const KEY = 'autos-jatek:customTrack';
const ACTIVE_NAME_KEY = 'autos-jatek:activeTrackName';

// A sim-réteg (config.js → trackStorage.js) a Colyseus SZERVEREN (Node) is fut,
// ahol nincs localStorage — ott egy no-op tárolóval helyettesítjük, így minden
// olvasás null-t ad (a szerver úgyis a szobát létrehozó klienstől kapja a pályát).
const storage =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// A mentett pálya-layout beolvasása. Ha nincs elmentve, vagy hibás, null.
export function loadCustomLayout() {
  try {
    const raw = storage.getItem(KEY);
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
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data.decorations) ? data.decorations : [];
  } catch {
    return [];
  }
}

// Pálya + dekorációk mentése az AKTÍV (a játék által betöltött) slotba, név nélkül.
// Az editorView opcionális: { path, decorations } — a szerkesztő pontos (WYSIWYG)
// rajzolt állapota, hogy újranyitáskor ugyanúgy jelenjen meg (a játék nem használja).
export function saveCustomTrack(layout, decorations, editorView) {
  const slot = { layout, decorations: decorations || [] };
  if (editorView && Array.isArray(editorView.path) && editorView.path.length) {
    slot.editorPath = editorView.path;
    slot.editorDecorations = editorView.decorations || [];
  }
  storage.setItem(KEY, JSON.stringify(slot));
}

// A szerkesztő WYSIWYG-nézete az aktív slotból (ha van): { path, decorations }.
export function loadEditorView() {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.editorPath) || data.editorPath.length === 0) return null;
    return { path: data.editorPath, decorations: data.editorDecorations || [] };
  } catch {
    return null;
  }
}

export function clearCustomLayout() {
  storage.removeItem(KEY);
  storage.removeItem(ACTIVE_NAME_KEY);
}

// --- Aktív pálya (a játékba átadott kiválasztás) ---
// A több, névvel mentett pálya KATALÓGUSA már NEM localStorage-ban él, hanem a
// szerveren (globális, minden gépről elérhető — lásd net/trackApi.js). A
// localStorage csak az "épp melyik pálya induljon a játékban" átadásra szolgál.

// A jelenleg aktív (a játék által betöltött) pálya neve, ha van ilyen.
export function getActiveTrackName() {
  return storage.getItem(ACTIVE_NAME_KEY);
}

// Az AKTÍV (a játék által betöltendő) pálya beállítása névvel együtt. A globális
// katalógus a szerveren él (net/trackApi.js) — ez csak a "melyik pálya induljon a
// játékban most" átadás a config.js felé (az oldal újratöltésekor onnan olvasódik).
export function setActiveTrack(name, layout, decorations, editorView) {
  saveCustomTrack(layout, decorations, editorView);
  if (name) storage.setItem(ACTIVE_NAME_KEY, name);
  else storage.removeItem(ACTIVE_NAME_KEY);
}
