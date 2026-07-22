// =============================================================================
//  PÁLYA-SZERKESZTŐ — SZABADVONALAS útvonal-rajzoló + szabad dekoráció-elhelyező.
//
//  Két mód:
//   - "track": a felhasználó tetszőleges helyre kattintva kontrollpontokat rak le
//     (világ-méterben, NINCS rács-igazítás) — ezekből a sim/trackSpline.js
//     UGYANAZZAL a görbe-illesztéssel épít sima, zárt pályát, mint a játék, ezért
//     a szerkesztő élő előnézete garantáltan megegyezik a vezetett pályával
//     (WYSIWYG). Zárás után a pontok húzhatók, a görbe mentén újak szúrhatók be,
//     jobb-klikkel törölhetők.
//   - "decor": a felhasználó egy kiválasztott Kenney-elemet helyez le PONTOSAN a
//     kattintott helyre (nincs rács — minden dekoráció "szabad" elhelyezésű,
//     mert a szabadvonalas pályához nincs értelmezhető rács-cella).
//
//  A layout (kontrollpontok listája) MAGA a mentett formátum — nincs többé
//  kanonikus-tájolás-forgatás vagy külön WYSIWYG "editor-nézet", mert egy
//  ponthalmaznak nincs "kezdő iránya": bármilyen sorrendben/pozícióban ugyanazt
//  a pályát adja (lásd sim/trackFactory.js isSplineLayout).
//
//  RÉGI (rács/szegmens) pályák betöltéskor AUTOMATIKUSAN átalakulnak szabad
//  kontrollponttá (world = cella * TRACK.tile — pontosan ugyanaz a világ-pozíció,
//  amit eddig a trackbuilder.js épített), így módosítás/migráció nélkül tovább
//  szerkeszthetők — mentéskor már az új formátumban mentődnek.
// =============================================================================
import {
  saveCustomTrack,
  clearCustomLayout,
  loadCustomLayout,
  loadCustomDecorations,
  setActiveTrack,
  getActiveTrackName,
} from './trackStorage.js';
import { apiListTracks, apiGetTrack, apiSaveTrack, apiDeleteTrack } from './net/trackApi.js';
import { DECORATION_TYPES, TRACK } from './config.js';
import { isDevMode } from './devmode.js';
import { isSplineLayout } from './sim/trackFactory.js';
import { sampleSpline } from './sim/trackSpline.js';
import { validateSplineTrack, MIN_CONTROL_POINTS, MIN_WIDTH, MAX_WIDTH } from './sim/trackValidation.js';
import { getFootprint } from './render3d/decorFootprint.js';

// A pálya-szerkesztő CSAK dev módban érhető el (?dev=1 a játék URL-jén) —
// enélkül vissza a játékhoz. A throw megállítja a modul további futását.
if (!isDevMode()) {
  window.location.replace(import.meta.env.BASE_URL.replace(/\/$/, '') + '/index.html');
  throw new Error('A pálya-szerkesztő csak dev módban érhető el (?dev=1).');
}

const CANVAS_W = 800;
const CANVAS_H = 560;
const PX_PER_METER = 2; // a látható vászon kb. ±200m × ±140m világot fed le
const HIT_RADIUS_PX = 14; // egy kontrollpont "eltalálásának" képernyő-sugara
const CLOSE_RADIUS_PX = 16; // az első pont közelébe kattintva zár a hurok
const CURVE_HIT_RADIUS_PX = 10; // a görbe/akkord közelébe kattintva szúr be pontot
const REMOVE_RADIUS_M = 3; // egy meglévő dekoráció közelébe kattintva törli (csak ha nincs ismert mérete)
const SNAP_DISTANCE_M = 3; // egy `snap` típusú elem élétől ennyin belül illeszkedik rá lerakáskor
const WIDTH_STEP = 2; // m — egy görgő-kattanás ennyivel változtatja egy pont szélességét
const DEFAULT_WIDTH = TRACK.tile; // m — új kontrollpont alap-szélessége

const canvas = document.getElementById('editorCanvas');
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;
const ctx = canvas.getContext('2d');

const statusEl = document.getElementById('status');
const undoBtn = document.getElementById('undoBtn');
const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');
const resetDefaultBtn = document.getElementById('resetDefaultBtn');
const modeTrackBtn = document.getElementById('modeTrackBtn');
const modeDecorBtn = document.getElementById('modeDecorBtn');
const instructionsEl = document.getElementById('instructions');
const trackLegendEl = document.getElementById('trackLegend');
const decorControlsEl = document.getElementById('decorControls');
const decorPaletteEl = document.getElementById('decorPalette');
const rotateBtn = document.getElementById('rotateBtn');
const trackNameInput = document.getElementById('trackNameInput');
const saveAsBtn = document.getElementById('saveAsBtn');
const savedTracksListEl = document.getElementById('savedTracksList');

// --- Állapot ---

// A pálya kontrollpontjai — {x,z} VILÁG-méterben (nincs rács). points[0]/[1]
// köze a rajt/cél (ugyanaz a konvenció, mint a régi rács-rendszerben).
const points = [];
let closed = false;
let dragIndex = null; // az éppen húzott kontrollpont indexe, vagy null
let hover = null; // { screenPt:{x,y}, worldPt:{x,z} } — a legutóbbi egér-pozíció

// Dekorációk: {x, z, type, rot} — VILÁG-méterben. Mentéskor dgx=x/TRACK.tile,
// dgy=z/TRACK.tile (a decorations.js render-kód EZT várja: world=dgx*tile) —
// ugyanaz a konvenció, mint a régi "szabad" (free) elemeknél volt, csak
// mostantól MINDEN dekoráció ezt az utat követi (nincs többé rács-igazítás).
const decorations = [];
const decorTypeKeys = Object.keys(DECORATION_TYPES);
let activeDecorType = decorTypeKeys[0];
let activeRot = 0;

let mode = 'track'; // 'track' | 'decor'
let problemPos = null; // { x, z } — az aktuális validációs hiba helye a vásznon (ha van)

// --- Koordináta-átváltás (világ-méter ⇄ vászon-pixel) ---

function worldToScreen(p) {
  return { x: CANVAS_W / 2 + p.x * PX_PER_METER, y: CANVAS_H / 2 + p.z * PX_PER_METER };
}
function screenToWorld(sx, sy) {
  return { x: (sx - CANVAS_W / 2) / PX_PER_METER, z: (sy - CANVAS_H / 2) / PX_PER_METER };
}
function pixelToScreen(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_W,
    y: ((clientY - rect.top) / rect.height) * CANVAS_H,
  };
}

function findPointNear(screenPt) {
  for (let i = 0; i < points.length; i++) {
    const s = worldToScreen(points[i]);
    if (Math.hypot(s.x - screenPt.x, s.y - screenPt.y) < HIT_RADIUS_PX) return i;
  }
  return -1;
}

function nearFirstPoint(screenPt) {
  if (points.length < MIN_CONTROL_POINTS) return false;
  const s = worldToScreen(points[0]);
  return Math.hypot(s.x - screenPt.x, s.y - screenPt.y) < CLOSE_RADIUS_PX;
}

// Pont távolsága egy (a→b) szakasztól (a legközelebbi, szakaszra vetített pontig).
function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

// A LEGKÖZELEBBI kontrollpont-akkord (nem a sima görbe — az egyszerűség kedvéért
// a nyers kontrollpont-sokszög szakaszait nézzük) egy világ-pontból — ez adja meg,
// MELYIK két kontrollpont közé szúrjunk be, ha a felhasználó a görbe közelébe
// kattint. A résen (`dist`) a hívó dönti el, hogy elég közel van-e a beszúráshoz.
// --- Dekoráció-méret (footprint) és élillesztés ---
//
// A `footprints[type]` a modell TÉNYLEGES (Box3-ból számolt) világ-méretét
// tartalmazza {width, depth}-ként (lásd render3d/decorFootprint.js) — ugyanaz
// a konvenció, mint a játékban ténylegesen renderelt méret, tehát amit itt
// látunk/illesztünk, PONTOSAN az kerül a pályára (WYSIWYG). Betöltés
// aszinkron (glTF-et kell beolvasni), ezért induláskor még lehet `undefined`
// egy típusra — eddig a méret/illesztés egyszerűen nem aktív rá, a szabad
// (korábbi) elhelyezés marad érvényben.
const footprints = {};

// Egy dekoráció LOKÁLIS (rot=0) x/z-eltolását világ-koordinátává forgatja a
// SAJÁT (d.rot * 90°) elforgatásával.
function localToWorld(d, lx, lz) {
  const a = (d.rot || 0) * (Math.PI / 2);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: d.x + lx * cos - lz * sin, z: d.z + lx * sin + lz * cos };
}
function localDirToWorld(d, lx, lz) {
  const a = (d.rot || 0) * (Math.PI / 2);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: lx * cos - lz * sin, z: lx * sin + lz * cos };
}

// A dekoráció négy sarka világ-koordinátában (a rajzoláshoz).
function footprintCorners(d, fp) {
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  return [
    localToWorld(d, -hw, -hd),
    localToWorld(d, hw, -hd),
    localToWorld(d, hw, hd),
    localToWorld(d, -hw, hd),
  ];
}

// A dekoráció négy élének középpontja + kifelé mutató (egység-)normálisa
// világ-koordinátában — az illesztés ezekhez a pontokhoz keres közelséget.
// `axis`: melyik LOKÁLIS méret (width/depth) mentén áll ki ez az él — ez a
// FORGATÁS ELŐTTI tengely, tehát rot=1/3 (90°/270°) esetén is helyesen jelzi,
// melyik fél-méret (nem a világ-térbeli normális iránya!) számít a kifelé
// tolásnál — enélkül egy 90°-kal elforgatott fal/kerítés illesztésekor a
// (világ-normálisból tévesen visszafejtett) rossz fél-méretet használnánk.
function footprintEdges(d, fp) {
  const hw = fp.width / 2;
  const hd = fp.depth / 2;
  return [
    { mid: localToWorld(d, 0, -hd), normal: localDirToWorld(d, 0, -1), axis: 'depth' },
    { mid: localToWorld(d, 0, hd), normal: localDirToWorld(d, 0, 1), axis: 'depth' },
    { mid: localToWorld(d, hw, 0), normal: localDirToWorld(d, 1, 0), axis: 'width' },
    { mid: localToWorld(d, -hw, 0), normal: localDirToWorld(d, -1, 0), axis: 'width' },
  ];
}

// worldPt a `d` dekoráció (rot-tal elforgatott) téglalapján BELÜL esik-e —
// inverz forgatással a lokális keretbe transzformálva (a forgatás
// ortonormált, tehát az inverz a transzponáltja).
function pointInFootprint(worldPt, d, fp) {
  const a = (d.rot || 0) * (Math.PI / 2);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = worldPt.x - d.x;
  const dz = worldPt.z - d.z;
  const lx = dx * cos + dz * sin;
  const lz = -dx * sin + dz * cos;
  return Math.abs(lx) <= fp.width / 2 && Math.abs(lz) <= fp.depth / 2;
}

// A kattintott/hover világ-pont ALATT/KÖZELÉBEN lévő meglévő dekoráció —
// ha ismert a mérete, a TÉNYLEGES (elforgatott) téglalapján belülre kell
// esni (így egy nagy épület bárhonnan törölhető, nem csak a középpontja
// közeléből); ha még nincs betöltve a mérete, a régi kör-alapú közelségre
// esik vissza.
function findDecorationNear(worldPt) {
  return decorations.find((d) => {
    const fp = footprints[d.type];
    if (fp) return pointInFootprint(worldPt, d, fp);
    return Math.hypot(d.x - worldPt.x, d.z - worldPt.z) < REMOVE_RADIUS_M;
  });
}

// `snap` típusú elem lerakásakor: megkeresi a legközelebbi (SNAP_DISTANCE_M-en
// belüli) élét egy MÁSIK, szintén `snap` típusú és ismert méretű dekorációnak,
// és ha talál, visszaadja azt a pozíciót, ahol az ÚJ elem PONTOSAN (rés/
// átfedés nélkül) illeszkedik hozzá. FONTOS: a `rot` mindig a HÍVÓ által
// átadott (a "Forgatás" gombbal beállított) forgás marad — CSAK a pozíció
// igazodik, a forgatás sosem íródik felül a szomszédéra. Enélkül (korábbi
// hiba) a forgatás-gomb hatástalannak tűnt, mert lerakáskor mindig a szomszéd
// forgása "nyert": fal/kerítés így csak egyenesen tudott folytatódni, sarkot/
// derékszögű csatlakozást (a felhasználó saját forgatásával) nem lehetett
// vele építeni. A javított logika: a MEGADOTT forgással kiszámolja az új elem
// 4 saját élét egy origó-központú próbapéldányon, és azt választja, amelyiknek
// a normálisa leginkább SZEMBEN áll a megtalált szomszéd-éllel (tehát "felé
// néz") — így egyenes folytatásnál (0° eltérés) ugyanúgy simán illeszkedik,
// de 90°-kal elforgatva egy derékszögű sarkot is pontosan zár.
function computeSnap(worldPt, type, rot) {
  const def = DECORATION_TYPES[type];
  const fp = footprints[type];
  if (!def?.snap || !fp) return null;

  let bestEdge = null;
  let bestDist = SNAP_DISTANCE_M;
  for (const d of decorations) {
    const ndef = DECORATION_TYPES[d.type];
    const nfp = footprints[d.type];
    if (!ndef?.snap || !nfp) continue;
    for (const edge of footprintEdges(d, nfp)) {
      const dist = Math.hypot(edge.mid.x - worldPt.x, edge.mid.z - worldPt.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
      }
    }
  }
  if (!bestEdge) return null;

  // Az új elem saját élei (a MEGADOTT forgással, egy képzeletbeli origóban álló
  // példányon) — azt választjuk, amelyiknek a normálisa a legjobban "szembenéz"
  // a megtalált szomszéd-éllel (skaláris szorzat maximuma a −bestEdge.normal-lal).
  const ownEdges = footprintEdges({ x: 0, z: 0, rot }, fp);
  let facingEdge = ownEdges[0];
  let bestScore = -Infinity;
  for (const e of ownEdges) {
    const score = e.normal.x * -bestEdge.normal.x + e.normal.z * -bestEdge.normal.z;
    if (score > bestScore) {
      bestScore = score;
      facingEdge = e;
    }
  }
  // `facingEdge.mid` itt a KÖZÉPPONTTÓL a saját élig mutató eltolás (mert a
  // próbapéldány az origóban állt) — az új középpont úgy adódik, hogy ez az
  // eltolás a szomszéd-élre essen (a két él PONTOSAN egybeessen).
  return {
    x: bestEdge.mid.x - facingEdge.mid.x,
    z: bestEdge.mid.z - facingEdge.mid.z,
    rot,
  };
}

function nearestChordSegment(worldPt) {
  const n = points.length;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const d = pointSegmentDistance(worldPt, a, b);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return { index: best, dist: bestDist };
}

// --- Mód váltás ---

function setMode(newMode) {
  mode = newMode;
  const isTrack = mode === 'track';
  modeTrackBtn.classList.toggle('active', isTrack);
  modeDecorBtn.classList.toggle('active', !isTrack);
  trackLegendEl.style.display = isTrack ? 'flex' : 'none';
  decorControlsEl.style.display = isTrack ? 'none' : 'block';
  instructionsEl.textContent = isTrack
    ? 'Kattints bárhova a pálya rajzolásának megkezdéséhez, majd folytasd további pontokkal — a görbe automatikusan simán illeszkedik közéjük. Legalább 4 pont után kattints vissza az első (arany) pontra a hurok zárásához. Zárás után: húzd a pontokat az áthelyezéshez, kattints a görbe közelébe új pont beszúrásához, jobb-kattints egy pontra a törléséhez, görgess egy pont fölött a szélességének (a "Xm" felirat) állításához, vagy dupla kattints egy pontra, hogy éles sarokká (négyzet) váltson — így sikánok, hajtűk is rajzolhatók.'
    : 'Válaszd ki az elemet lent (a neve mellett a valós mérete is látszik, amint betöltődött), állítsd be a "Forgatás" gombbal az irányát (a sárga nyíl + "E" felirat mutatja az elejét), majd kattints a pálya bármely pontjára a lerakáshoz. A fal/kerítés/garázs/iroda/lelátó/terelőkorlát egy MÁSIK ilyen elem éléhez közel automatikusan a PONTOS illesztett helyre kerül (rés/átfedés nélkül) — a FORGATÁSA mindig a beállított marad, tehát derékszögű sarok is építhető (forgasd 90°-kal, majd kattints a szomszéd sarkához). Máshova kattintva szabadon kerül le. Egy meglévő elemre (a téglalapján belül) kattintva eltávolítod.';
  hover = null;
  render();
  updateStatus();
}

modeTrackBtn.addEventListener('click', () => setMode('track'));
modeDecorBtn.addEventListener('click', () => setMode('decor'));

// Dekoráció-paletta felépítése a config.js DECORATION_TYPES alapján, réteg
// szerint csoportosítva (a réteg-fogalom csak vizuális csoportosítás — a
// tényleges elhelyezés minden típusnál azonos, szabad).
const layerLabels = { ground: 'Talaj (a cella alapja)', object: 'Objektum (a talajra kerül)' };
const paletteButtons = {}; // type → <button> — a betöltött méret utólag frissíti a feliratot

function paletteLabelText(key) {
  const def = DECORATION_TYPES[key];
  const fp = footprints[key];
  const size = fp ? ` (${fp.width.toFixed(1)}×${fp.depth.toFixed(1)}m)` : '';
  return `${def.icon} ${def.label}${size}`;
}

for (const layer of ['ground', 'object']) {
  const keys = decorTypeKeys.filter((k) => DECORATION_TYPES[k].layer === layer);
  if (keys.length === 0) continue;

  const header = document.createElement('div');
  header.className = 'decorLayerHeader';
  header.textContent = layerLabels[layer];
  decorPaletteEl.appendChild(header);

  const group = document.createElement('div');
  group.className = 'decorLayerGroup';
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.textContent = paletteLabelText(key);
    btn.dataset.type = key;
    if (key === activeDecorType) btn.classList.add('active');
    btn.addEventListener('click', () => {
      activeDecorType = key;
      for (const b of decorPaletteEl.querySelectorAll('button')) b.classList.remove('active');
      btn.classList.add('active');
    });
    paletteButtons[key] = btn;
    group.appendChild(btn);
  }
  decorPaletteEl.appendChild(group);
}

// A modellek valós mérete aszinkron töltődik be (glTF-parszolás) — amint egy
// típusé megjön, frissítjük a palettán a feliratát ÉS újrarajzolunk (hogy a
// már lerakott ilyen típusú elemek is megkapják a méret-téglalapot/illesztést).
for (const key of decorTypeKeys) {
  getFootprint(key).then((fp) => {
    if (!fp) return;
    footprints[key] = fp;
    if (paletteButtons[key]) paletteButtons[key].textContent = paletteLabelText(key);
    render();
  });
}

rotateBtn.addEventListener('click', () => {
  activeRot = (activeRot + 1) % 4;
  render();
});

// --- Interakció ---

canvas.addEventListener('mousedown', (e) => {
  if (mode !== 'track') return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const worldPt = screenToWorld(screenPt.x, screenPt.y);

  if (!closed) {
    // A hurok zárása ELŐBB, mint az "eltaláltam egy pontot" ellenőrzés — az első
    // pont ÚGY IS "pont", de itt kattintva zárni akarunk, nem húzni.
    if (nearFirstPoint(screenPt)) {
      closed = true;
      render();
      updateStatus();
      return;
    }
    const hitIdx = findPointNear(screenPt);
    if (hitIdx !== -1) {
      dragIndex = hitIdx;
      return;
    }
    // Új pont szélessége öröklődik az előzőtől (vagy alapérték az elsőnél) —
    // így egy már beállított szélesség "tovább fut" a következő pontokra.
    const width = points.length > 0 ? points[points.length - 1].width : DEFAULT_WIDTH;
    points.push({ ...worldPt, width });
    render();
    updateStatus();
    return;
  }

  // Zárt pálya: pont húzása, vagy új pont beszúrása a görbe közelébe kattintva.
  const hitIdx = findPointNear(screenPt);
  if (hitIdx !== -1) {
    dragIndex = hitIdx;
    return;
  }
  const { index, dist } = nearestChordSegment(worldPt);
  if (dist * PX_PER_METER < CURVE_HIT_RADIUS_PX) {
    // A beszúrt pont szélessége a két szomszédos kontrollpont átlaga — simán
    // illeszkedik a már beállított szélesség-átmenetbe.
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const width = (a.width + b.width) / 2;
    points.splice(index + 1, 0, { ...worldPt, width });
    render();
    updateStatus();
  }
});

canvas.addEventListener('mousemove', (e) => {
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const worldPt = screenToWorld(screenPt.x, screenPt.y);
  if (mode === 'track' && dragIndex !== null) {
    // A pozíciót cseréljük, de a pont szélességét (width) megőrizzük — enélkül
    // a húzás visszaállítaná a pontot alapértelmezett szélességre.
    points[dragIndex] = { ...worldPt, width: points[dragIndex].width };
    render();
    updateStatus();
    return;
  }
  hover = { screenPt, worldPt };
  render();
});

canvas.addEventListener('mouseleave', () => {
  hover = null;
  render();
});

// A mouseup-ot az EGÉSZ ablakon figyeljük (nem csak a vásznon), hogy a húzás
// akkor is helyesen véget érjen, ha a felhasználó közben kicsúszik a vászonból.
window.addEventListener('mouseup', () => {
  if (dragIndex !== null) {
    dragIndex = null;
    updateStatus();
  }
});

// Jobb-klikk: egy kontrollpont törlése (track módban) — legalább MIN_CONTROL_POINTS
// pontnak meg kell maradnia.
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode !== 'track') return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const hitIdx = findPointNear(screenPt);
  if (hitIdx === -1) return;
  if (points.length <= MIN_CONTROL_POINTS) {
    statusEl.textContent = `Legalább ${MIN_CONTROL_POINTS} pont kell — ez már nem törölhető.`;
    statusEl.classList.remove('closed');
    return;
  }
  points.splice(hitIdx, 1);
  render();
  updateStatus();
});

// Görgő egy kontrollpont fölött (track módban): az ADOTT PONT szélességének
// állítása ±WIDTH_STEP méterrel, [MIN_WIDTH, MAX_WIDTH] közé szorítva — ez adja
// a "szakaszonként állítható pályaszélesség" funkciót (a szélesség a
// szomszédos pontok felé simán, Catmull-Rom-interpolációval vezet át, lásd
// sim/trackSpline.js). Csak akkor preventDefault-olunk, ha TALÁLTUNK pontot —
// egyébként a lap normál görgetése marad érintetlen.
canvas.addEventListener(
  'wheel',
  (e) => {
    if (mode !== 'track') return;
    const screenPt = pixelToScreen(e.clientX, e.clientY);
    const hitIdx = findPointNear(screenPt);
    if (hitIdx === -1) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? WIDTH_STEP : -WIDTH_STEP;
    const p = points[hitIdx];
    p.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, p.width + delta));
    render();
    updateStatus();
  },
  { passive: false }
);

// Dupla kattintás egy kontrollponton (track módban): ki/be kapcsolja, hogy a
// pont ÉLES SAROK legyen-e (törésponttá teszi a görbét, egyenes be/kifutással
// — lásd sim/trackSpline.js) vagy sima Catmull-Rom-átmenet (alapértelmezett).
// Nem ütközik a mousedown/mouseup húzás-logikával — egy dblclick két külön,
// mozgás nélküli kattintásból áll, ez az esemény azok UTÁN, külön fut le.
canvas.addEventListener('dblclick', (e) => {
  if (mode !== 'track') return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const hitIdx = findPointNear(screenPt);
  if (hitIdx === -1) return;
  points[hitIdx].sharp = !points[hitIdx].sharp;
  render();
  updateStatus();
});

// Dekoráció-elhelyezés/törlés (csak decor módban — a 'click' a mousedown+mouseup
// PÁRJÁRA fut le húzás nélkül, így nem ütközik a fenti track-mód húzás-logikával).
canvas.addEventListener('click', (e) => {
  if (mode !== 'decor') return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const worldPt = screenToWorld(screenPt.x, screenPt.y);
  const existing = findDecorationNear(worldPt);
  if (existing) {
    decorations.splice(decorations.indexOf(existing), 1);
  } else {
    const snap = computeSnap(worldPt, activeDecorType, activeRot);
    if (snap) decorations.push({ x: snap.x, z: snap.z, type: activeDecorType, rot: snap.rot });
    else decorations.push({ x: worldPt.x, z: worldPt.z, type: activeDecorType, rot: activeRot });
  }
  render();
  updateStatus();
});

undoBtn.addEventListener('click', () => {
  if (mode === 'decor') {
    decorations.pop();
  } else if (closed) {
    closed = false;
  } else {
    points.pop();
  }
  render();
  updateStatus();
});

clearBtn.addEventListener('click', () => {
  points.length = 0;
  closed = false;
  decorations.length = 0;
  render();
  updateStatus();
});

function gotoGame() {
  // Gyökér-relatív útvonal helyett BASE_URL-lel prefixelve, hogy GitHub Pages
  // al-útvonalán (/autos-jatek/) is a helyes index.html-re navigáljon.
  window.location.href = import.meta.env.BASE_URL.replace(/\/$/, '') + '/index.html';
}

// A jelenlegi kontrollpontokból a MENTETT layout (ha a hurok zárva van) — a
// pontok MAGUK a formátum, nincs szükség kanonikus-tájolás átalakításra (egy
// ponthalmaznak nincs "kezdő iránya" — lásd sim/trackFactory.js isSplineLayout).
function currentLayout() {
  if (!closed || points.length < MIN_CONTROL_POINTS) return null;
  return points.map((p) => ({ x: p.x, z: p.z, width: p.width, sharp: !!p.sharp }));
}

// A dekorációk mentésre kész alakja: dgx/dgy = world/TRACK.tile — a
// render3d/decorations.js EZT várja (world = dgx*tile), változatlanul.
function decorationsForSave() {
  return decorations.map((d) => ({
    type: d.type,
    dgx: d.x / TRACK.tile,
    dgy: d.z / TRACK.tile,
    rot: d.rot || 0,
  }));
}

saveBtn.addEventListener('click', async () => {
  const layout = currentLayout();
  if (!layout) return;
  const relDecorations = decorationsForSave();
  const name = trackNameInput.value.trim();
  // Ez a pálya induljon a játékban (lokális átadás a config.js felé). Nincs
  // külön "editor-nézet" — a layout maga a WYSIWYG forrás (lásd fenti komment).
  setActiveTrack(name, layout, relDecorations);
  // Ha van neve, GLOBÁLISAN is elmentjük a szerverre (minden gépről elérhető).
  // Ha a szerver nem elérhető, akkor is elindul lokálisan — csak nem lesz globális.
  if (name) {
    saveBtn.disabled = true;
    try {
      await apiSaveTrack({ name, layout, decorations: relDecorations });
    } catch (e) {
      statusEl.textContent = `⚠️ Globális mentés sikertelen (${e.message}). Lokálisan indítom.`;
      statusEl.classList.remove('closed');
    }
  }
  gotoGame();
});

resetDefaultBtn.addEventListener('click', () => {
  clearCustomLayout();
  points.length = 0;
  closed = false;
  decorations.length = 0;
  trackNameInput.value = '';
  render();
  renderSavedTracksList();
  statusEl.textContent = 'Az alap pálya visszaállítva (törölve az aktív egyéni pálya és dekoráció — a névvel mentett pályák megmaradnak).';
  statusEl.classList.remove('closed');
});

function updateStatus() {
  saveBtn.disabled = true;
  statusEl.classList.remove('closed');
  problemPos = null;
  if (points.length === 0) {
    statusEl.textContent = 'Kattints valahova a pálya rajzolásának megkezdéséhez.';
    return;
  }
  if (!closed) {
    const hint =
      points.length >= MIN_CONTROL_POINTS
        ? ' Vagy zárd a hurkot: kattints vissza az első (arany) pontra.'
        : ` (legalább ${MIN_CONTROL_POINTS} kell a záráshoz)`;
    statusEl.textContent = `${points.length} kontrollpont kijelölve.${hint}`;
    return;
  }
  const result = validateSplineTrack(points);
  if (!result.valid) {
    const err = result.errors[0];
    statusEl.textContent = `⚠️ ${err.message}${err.pos ? ' (lásd a piros jelölést a pályán)' : ''}`;
    if (err.pos) problemPos = err.pos;
    render(); // a piros jelölőt azonnal kirajzoljuk, nem várva a következő egérmozdulatra
    return;
  }
  const decorNote = decorations.length ? `, ${decorations.length} dekoráció` : '';
  statusEl.textContent = `Kész! ${points.length} kontrollpont, érvényes zárt pálya${decorNote}.`;
  statusEl.classList.add('closed');
  saveBtn.disabled = false;
}

// --- Renderelés ---

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Halvány referencia-rács — CSAK vizuális tájékozódás, nincs hozzá igazítás.
  ctx.strokeStyle = '#22252e';
  ctx.lineWidth = 1;
  const stepPx = 20 * PX_PER_METER; // 20 méterenként
  for (let x = CANVAS_W / 2; x <= CANVAS_W; x += stepPx) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let x = CANVAS_W / 2 - stepPx; x >= 0; x -= stepPx) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let y = CANVAS_H / 2; y <= CANVAS_H; y += stepPx) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
  }
  for (let y = CANVAS_H / 2 - stepPx; y >= 0; y -= stepPx) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
  }

  // Zárt pályánál a SAJÁT görbe-mintavételező (sampleSpline) adja az előnézetet —
  // ugyanaz a modul, amit a játék is használ, tehát garantáltan WYSIWYG.
  let sampled = null;
  if (closed && points.length >= MIN_CONTROL_POINTS) {
    try {
      sampled = sampleSpline(points, 2);
    } catch {
      sampled = null;
    }
  }

  if (sampled) {
    // Aszfalt-sáv előnézet (kitöltött sokszög a bal/jobb élek közt) — PONTONKÉNT
    // a saját width-jével (nem egy fix konstanssal), hogy a szakaszonként
    // állított szélesség élőben látszódjon.
    ctx.beginPath();
    sampled.forEach((p, i) => {
      const halfPx = (p.width / 2) * PX_PER_METER;
      const s = worldToScreen(p);
      const lx = s.x - Math.sin(p.dir) * halfPx;
      const ly = s.y + Math.cos(p.dir) * halfPx;
      if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
    });
    for (let i = sampled.length - 1; i >= 0; i--) {
      const p = sampled[i];
      const halfPx = (p.width / 2) * PX_PER_METER;
      const s = worldToScreen(p);
      const rx = s.x + Math.sin(p.dir) * halfPx;
      const ry = s.y - Math.cos(p.dir) * halfPx;
      ctx.lineTo(rx, ry);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(130,130,140,0.4)';
    ctx.fill();

    // Középvonal.
    ctx.strokeStyle = '#5c8fd6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    sampled.forEach((p, i) => {
      const s = worldToScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.stroke();
  } else if (points.length >= 1) {
    // Nyitott (még nem zárt) útvonal: egyszerű, egyenes szakaszos előnézet.
    ctx.strokeStyle = '#5c8fd6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const s = worldToScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
  }

  // Kontrollpontok — az első kettő (a rajt/cél-kapu) arany, a többi kék. Az
  // ÉLES SAROKKÉNT megjelölt pontok (dupla kattintás, lásd a dblclick-
  // listenert) NÉGYZET alakúak (nem kör) — így látszik, hol törik meg a görbe.
  // Mellettük a pont szélessége (görgővel állítható, lásd a wheel-listenert).
  points.forEach((p, i) => {
    const s = worldToScreen(p);
    ctx.beginPath();
    if (p.sharp) {
      ctx.rect(s.x - 6, s.y - 6, 12, 12);
    } else {
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
    }
    ctx.fillStyle = i === 0 || i === 1 ? '#f2c14e' : '#5c8fd6';
    ctx.fill();
    ctx.strokeStyle = '#12141a';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#9aa2b4';
    ctx.fillText(`${Math.round(p.width)}m`, s.x, s.y + 10);
  });

  // Rajt/cél jelölő ikon az első két kontrollpont közt.
  if (points.length >= 2) {
    const a = worldToScreen(points[0]);
    const b = worldToScreen(points[1]);
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8eaef';
    ctx.fillText('🏁', (a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  // A jelenlegi validációs hiba pontos helye (ha van) — enélkül a #status
  // szövegben szereplő "X. mintapontnál" a felhasználó számára megfoghatatlan
  // (élő visszajelzés alapján ez volt a fő panasz: "nem egyértelmű, hol").
  if (problemPos) {
    const s = worldToScreen(problemPos);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 16, 0, Math.PI * 2);
    ctx.strokeStyle = '#e05a5a';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e05a5a';
    ctx.fillText('⚠', s.x, s.y - 24);
  }

  // Hover-visszajelzés (track mód): zárás-jelölő / pont-kijelölés / beszúrás-előnézet.
  if (hover && mode === 'track') {
    const hitIdx = findPointNear(hover.screenPt);
    if (!closed && nearFirstPoint(hover.screenPt)) {
      const s = worldToScreen(points[0]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = '#f2c14e';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (hitIdx !== -1) {
      const s = worldToScreen(points[hitIdx]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = '#8fd693';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (closed && points.length >= MIN_CONTROL_POINTS) {
      const { dist } = nearestChordSegment(hover.worldPt);
      if (dist * PX_PER_METER < CURVE_HIT_RADIUS_PX) {
        const s = worldToScreen(hover.worldPt);
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#d99a3f';
        ctx.fillText('+', s.x, s.y);
      }
    } else if (!closed) {
      const s = worldToScreen(hover.worldPt);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(92,143,214,0.5)';
      ctx.fill();
    }
  }

  // Dekorációk — ikon + forgás-jelző vonal, ÉS ha már ismert a valós mérete
  // (lásd footprints/getFootprint), a tényleges (elforgatott) téglalapja is,
  // méret-felirattal — ez adja a "pontos méret látszik" funkciót.
  for (const d of decorations) {
    const fp = footprints[d.type];
    if (fp) drawFootprintRect(d, fp, DECORATION_TYPES[d.type].snap ? 'rgba(111,179,122,0.9)' : 'rgba(122,127,140,0.7)');

    const s = worldToScreen(d);
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DECORATION_TYPES[d.type].icon, s.x, s.y);
    drawFacingArrow(d, '#f2c14e');
  }

  // Hover-visszajelzés (decor mód): törlés-célpont (piros keret/gyűrű) / lerakás-
  // előnézet — ha az aktív típus `snap`-elhető és van elég közeli illeszthető
  // szomszéd, a PONTOS illesztett helyen/forgással mutatja (sárga téglalap +
  // "illesztve" felirat), különben a szabad kattintás-helyen (a "Forgatás"
  // gomb szerinti iránnyal).
  if (hover && mode === 'decor') {
    const existing = findDecorationNear(hover.worldPt);
    if (existing) {
      const fp = footprints[existing.type];
      if (fp) {
        drawFootprintRect(existing, fp, '#e05a5a');
      } else {
        const s = worldToScreen(existing);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
        ctx.strokeStyle = '#e05a5a';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else {
      const snap = computeSnap(hover.worldPt, activeDecorType, activeRot);
      const preview = snap
        ? { x: snap.x, z: snap.z, rot: snap.rot }
        : { x: hover.worldPt.x, z: hover.worldPt.z, rot: activeRot };
      const fp = footprints[activeDecorType];
      if (fp) drawFootprintRect(preview, fp, snap ? '#f2c14e' : 'rgba(217,154,63,0.6)');

      const s = worldToScreen(preview);
      ctx.globalAlpha = 0.6;
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(DECORATION_TYPES[activeDecorType].icon, s.x, s.y);
      ctx.globalAlpha = 1;
      drawFacingArrow(preview, snap ? '#f2c14e' : 'rgba(217,154,63,0.7)');
      if (snap) {
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f2c14e';
        ctx.fillText('illesztve', s.x, s.y - 18);
      }
    }
  }
}

// Egy dekoráció valós (elforgatott) téglalapja + méret-felirat kirajzolása.
// Az ELEJE (ugyanaz az irány, mint a drawFacingArrow nyila — lásd ott) oldala
// vastagabb, sárga vonallal kiemelve, hogy a téglalapon is látszódjon, merre néz.
function drawFootprintRect(d, fp, color) {
  const corners = footprintCorners(d, fp).map(worldToScreen);
  ctx.beginPath();
  corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(140,150,165,0.10)';
  ctx.fill();

  // footprintCorners sorrendje [(-hw,-hd),(hw,-hd),(hw,hd),(-hw,hd)] — a
  // 0→1 oldal a z=-hd ("eleje") oldal, UGYANAZ az irány, mint a forgás-nyíl.
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.strokeStyle = '#f2c14e';
  ctx.lineWidth = 3;
  ctx.stroke();

  const s = worldToScreen(d);
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#9aa2b4';
  ctx.fillText(`${fp.width.toFixed(1)}×${fp.depth.toFixed(1)}m`, s.x, s.y + 12);
}

// Az elem FORGÁSÁT (merre néz — "eleje") jelző nyíl: vonal + nyílhegy + "E"
// (eleje) felirat a hegyénél. Ugyanazt a szög-konvenciót használja, mint a
// footprintEdges "front" éle (rot=0-nál a világ −Z irányba, azaz a vásznon
// "felfelé" mutat), így a nyíl és a drawFootprintRect kiemelt éle MINDIG
// ugyanarra az oldalra mutat.
function drawFacingArrow(d, color) {
  const s = worldToScreen(d);
  const angle = ((d.rot || 0) * Math.PI) / 2 - Math.PI / 2;
  const len = 22;
  const tipX = s.x + Math.cos(angle) * len;
  const tipY = s.y + Math.sin(angle) * len;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  const headLen = 8;
  const headAngle = Math.PI / 6;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - headLen * Math.cos(angle - headAngle), tipY - headLen * Math.sin(angle - headAngle));
  ctx.lineTo(tipX - headLen * Math.cos(angle + headAngle), tipY - headLen * Math.sin(angle + headAngle));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText('E', tipX + Math.cos(angle) * 9, tipY + Math.sin(angle) * 9);
}

// A computeLayout()-hoz hasonló INVERZ, csak a RÉGI (rács/szegmens) formátumhoz —
// egy mentett szegmens-layout-ból visszaépíti a kanonikus (kelet-kezdésű)
// cella-sorozatot. CSAK a régi pályák betöltésekor kell (lásd loadLayoutIntoEditor).
function layoutToPath(layout) {
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  const cells = [{ x, y }];
  for (const seg of layout) {
    if (seg.type === 'straight') {
      for (let i = 0; i < seg.n; i++) {
        x += dx;
        y += dy;
        cells.push({ x, y });
      }
    } else {
      const turn = seg.turn;
      const ndx = turn === 1 ? -dy : dy;
      const ndy = turn === 1 ? dx : -dx;
      dx = ndx;
      dy = ndy;
      x += dx;
      y += dy;
      cells.push({ x, y });
    }
  }
  cells.pop(); // az utolsó elem == cells[0] (a hurok zárása), duplikátum eltávolítása
  return cells;
}

// Egy {layout, decorations} pályaadatot tölt be SZERKESZTÉSRE. RÉGI (rács)
// formátumnál a kanonikus cella-sorozatot VILÁG-méterre váltjuk (world = cella *
// TRACK.tile — pontosan az a világ-pozíció, amit eddig a trackbuilder.js épített),
// így a pálya alakja nem változik, csak mostantól szabadon szerkeszthető ponttá
// alakul. ÚJ (szabadvonalas) formátumnál a pontok közvetlenül betöltődnek.
function loadLayoutIntoEditor(savedLayout, savedDecorations) {
  points.length = 0;
  decorations.length = 0;
  closed = false;
  if (!savedLayout) return;

  if (isSplineLayout(savedLayout)) {
    for (const p of savedLayout) {
      points.push({
        x: p.x,
        z: p.z,
        width: Number.isFinite(p.width) && p.width > 0 ? p.width : DEFAULT_WIDTH,
        sharp: !!p.sharp,
      });
    }
  } else {
    const cells = layoutToPath(savedLayout);
    for (const c of cells) points.push({ x: c.x * TRACK.tile, z: c.y * TRACK.tile, width: DEFAULT_WIDTH });
  }
  closed = points.length >= MIN_CONTROL_POINTS;

  for (const d of savedDecorations || []) {
    if (!DECORATION_TYPES[d.type]) continue; // megszűnt típus — kihagyjuk
    decorations.push({ x: d.dgx * TRACK.tile, z: d.dgy * TRACK.tile, type: d.type, rot: d.rot || 0 });
  }
}

// --- Globális pálya-katalógus (a szerverről: betöltés szerkesztésre, törlés) ---

async function renderSavedTracksList() {
  savedTracksListEl.innerHTML = '';
  const loading = document.createElement('p');
  loading.textContent = 'Betöltés…';
  savedTracksListEl.appendChild(loading);

  let tracks;
  try {
    tracks = await apiListTracks();
  } catch (e) {
    savedTracksListEl.innerHTML = '';
    const err = document.createElement('p');
    err.textContent = `⚠️ A szerver nem elérhető (${e.message}).`;
    savedTracksListEl.appendChild(err);
    return;
  }

  savedTracksListEl.innerHTML = '';
  const activeName = getActiveTrackName();
  if (tracks.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Még nincs globálisan mentett pálya.';
    savedTracksListEl.appendChild(empty);
    return;
  }
  for (const t of tracks) {
    const row = document.createElement('div');
    row.className = 'savedTrackRow';

    const label = document.createElement('span');
    label.className = 'savedTrackName';
    label.textContent = (t.name === activeName ? '▶ ' : '') + t.name;
    label.title = `${t.segments} szakasz, ${t.decorations} dekoráció`;
    row.appendChild(label);

    const loadBtn = document.createElement('button');
    loadBtn.textContent = '📂';
    loadBtn.title = 'Betöltés szerkesztésre';
    loadBtn.addEventListener('click', async () => {
      try {
        const entry = await apiGetTrack(t.id);
        loadLayoutIntoEditor(entry.layout, entry.decorations);
        trackNameInput.value = entry.name;
        setActiveTrack(entry.name, entry.layout, entry.decorations);
        render();
        updateStatus();
        renderSavedTracksList();
        statusEl.textContent = `📂 "${entry.name}" betöltve szerkesztésre.`;
        statusEl.classList.add('closed');
      } catch (e) {
        statusEl.textContent = `⚠️ Betöltés sikertelen: ${e.message}`;
        statusEl.classList.remove('closed');
      }
    });
    row.appendChild(loadBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑️';
    delBtn.className = 'danger';
    delBtn.title = 'Törlés (mindenkinél!)';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Biztosan törlöd a(z) "${t.name}" pályát? Ez MINDENKINÉL törli, és nem vonható vissza.`)) return;
      try {
        await apiDeleteTrack(t.id);
        renderSavedTracksList();
      } catch (e) {
        statusEl.textContent = `⚠️ Törlés sikertelen: ${e.message}`;
        statusEl.classList.remove('closed');
      }
    });
    row.appendChild(delBtn);

    savedTracksListEl.appendChild(row);
  }
}

saveAsBtn.addEventListener('click', async () => {
  const name = trackNameInput.value.trim();
  if (!name) {
    statusEl.textContent = 'Adj nevet a pályának a mentéshez!';
    statusEl.classList.remove('closed');
    return;
  }
  const layout = currentLayout();
  if (!layout) {
    statusEl.textContent = 'A pálya még nincs lezárva — előbb zárd a hurkot.';
    statusEl.classList.remove('closed');
    return;
  }
  const result = validateSplineTrack(points);
  if (!result.valid) {
    statusEl.textContent = `⚠️ ${result.errors[0].message}`;
    statusEl.classList.remove('closed');
    return;
  }
  const relDecorations = decorationsForSave();
  saveAsBtn.disabled = true;
  try {
    await apiSaveTrack({ name, layout, decorations: relDecorations });
    setActiveTrack(name, layout, relDecorations);
    renderSavedTracksList();
    statusEl.textContent = `✅ "${name}" elmentve globálisan (minden gépről elérhető).`;
    statusEl.classList.add('closed');
  } catch (e) {
    statusEl.textContent = `⚠️ Globális mentés sikertelen: ${e.message}`;
    statusEl.classList.remove('closed');
  } finally {
    saveAsBtn.disabled = false;
  }
});

// Induláskor: az utoljára aktív pálya betöltése szerkesztésre (ne kelljen mindig
// előről kezdeni), és a globális katalógus lekérése a szerverről.
loadLayoutIntoEditor(loadCustomLayout(), loadCustomDecorations());
const activeNameOnLoad = getActiveTrackName();
if (activeNameOnLoad) trackNameInput.value = activeNameOnLoad;
renderSavedTracksList();

render();
updateStatus();

// Fejlesztői debug-hozzáférés a böngésző-konzolból.
if (import.meta.env.DEV) {
  window.__EDITOR = {
    points,
    decorations,
    footprints,
    get closed() { return closed; },
    get mode() { return mode; },
    validate: () => validateSplineTrack(points),
    computeSnap,
    setActiveDecorType: (t) => { activeDecorType = t; },
  };
}
