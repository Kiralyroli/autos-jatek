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
  loadPitLane,
  setActiveTrack,
  getActiveTrackName,
} from './trackStorage.js';
import { apiListTracks, apiGetTrack, apiSaveTrack, apiDeleteTrack } from './net/trackApi.js';
import { DECORATION_TYPES, DECORATION_CATEGORIES, TRACK, RACE } from './config.js';
import { isDevMode } from './devmode.js';
import { isSplineLayout } from './sim/trackFactory.js';
import { sampleSpline } from './sim/trackSpline.js';
import { validateSplineTrack, MIN_CONTROL_POINTS, MIN_WIDTH, MAX_WIDTH } from './sim/trackValidation.js';
import { getFootprint } from './render3d/decorFootprint.js';
import {
  createEditorScene,
  rebuildEditorTrack,
  rebuildEditorDecorations,
  raycastGround,
  createFreeCameraController,
  createDecorGhost,
  createPointMarkers,
} from './render3d/editorPreview.js';

// A pálya-szerkesztő CSAK dev módban érhető el (?dev=1 a játék URL-jén) —
// enélkül vissza a játékhoz. A throw megállítja a modul további futását.
if (!isDevMode()) {
  window.location.replace(import.meta.env.BASE_URL.replace(/\/$/, '') + '/index.html');
  throw new Error('A pálya-szerkesztő csak dev módban érhető el (?dev=1).');
}

const CANVAS_W = 800;
const CANVAS_H = 560;
// Alapból a látható vászon kb. ±400m × ±280m világot fed le — Ctrl+görgővel
// (lásd a wheel-kezelőt) a kurzor alatti pont körül be-/kizoomolható,
// [MIN_ZOOM, MAX_ZOOM] közé szorítva.
let pxPerMeter = 1;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
// A vászon-KÖZÉP világ-koordinátája — zoomnál ez tolódik el (kurzor alatti
// pont fixen marad), PÁSZTÁZÁSNÁL (lásd panning-állapot lent) pedig a
// felhasználó közvetlenül mozgatja: középső egérgombbal húzva, VAGY a
// Szóköz lenyomva tartása közben a BAL gombbal húzva (mint Figma/Photoshop —
// trackpaden nincs mindig kényelmes középső gomb).
const viewCenter = { x: 0, z: 0 };
let spaceHeld = false;
let panning = false;
let panStartScreen = null; // {x,y} vászon-koordinátában, a húzás KEZDETÉN
let panStartCenter = null; // viewCenter a húzás KEZDETÉN — a delta ehhez képest számol, driftmentesen
const HIT_RADIUS_PX = 14; // egy kontrollpont "eltalálásának" képernyő-sugara
const CLOSE_RADIUS_PX = 16; // az első pont közelébe kattintva zár a hurok
const CURVE_HIT_RADIUS_PX = 10; // a görbe/akkord közelébe kattintva szúr be pontot
const REMOVE_RADIUS_M = 3; // egy meglévő dekoráció közelébe kattintva törli (csak ha nincs ismert mérete)
const SNAP_DISTANCE_M = 3; // egy `snap` típusú elem élétől ennyin belül illeszkedik rá lerakáskor
// Ennyin belül a főút középvonalától egy boxutca-pont PONTOSAN arra a
// középvonal-pontra kerül (nem csak közelébe) — így a boxutca-útvonal és a
// főút fizikailag/vizuálisan biztosan összeér (lásd snapToTrackCenterline).
const PIT_LANE_SNAP_M = 20;
const WIDTH_STEP = 2; // m — egy görgő-kattanás ennyivel változtatja egy pont szélességét
const DEFAULT_WIDTH = TRACK.tile; // m — új kontrollpont alap-szélessége
const SCALE_STEP = 0.1; // egy görgő-kattanás ennyivel változtatja a "kézben" lévő elem méret-szorzóját
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
const ROTATE_STEP = Math.PI / 36; // 5° — egy görgő-kattanás ennyivel forgatja a "kézben" lévő elemet, R lenyomva tartva

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
const modePitLaneBtn = document.getElementById('modePitLaneBtn');
const modePitBoxBtn = document.getElementById('modePitBoxBtn');
const instructionsEl = document.getElementById('instructions');
const trackLegendEl = document.getElementById('trackLegend');
const decorControlsEl = document.getElementById('decorControls');
const decorPaletteEl = document.getElementById('decorPalette');
const decorSearchInput = document.getElementById('decorSearchInput');
const rotateBtn = document.getElementById('rotateBtn');
const trackNameInput = document.getElementById('trackNameInput');
const saveAsBtn = document.getElementById('saveAsBtn');
const savedTracksListEl = document.getElementById('savedTracksList');
const view2dBtn = document.getElementById('view2dBtn');
const view3dBtn = document.getElementById('view3dBtn');
const editor3dContainer = document.getElementById('editor3d');

// --- Állapot ---

// A pálya kontrollpontjai — {x,z} VILÁG-méterben (nincs rács). points[0]/[1]
// köze a rajt/cél (ugyanaz a konvenció, mint a régi rács-rendszerben).
const points = [];
let closed = false;
let dragIndex = null; // az éppen húzott kontrollpont indexe, vagy null
let hover = null; // { screenPt:{x,y}, worldPt:{x,z} } — a legutóbbi egér-pozíció
// A kurzor alatt álló MEGLÉVŐ dekoráció (decor módban, 2D ÉS 3D nézetben is
// frissül) — csak arra kell, hogy tudjuk: a rákattintás TÖRÖL, ne rakjon le
// újat, és hogy a "kézben lévő" szellem-előnézet ilyenkor elrejtve maradjon
// (ne fedje egymást a két modell). A méretezés/forgatás NEM ezt módosítja —
// lásd activeScale/activeRot lent: a felhasználó kérése szerint a
// finomhangolás a LERAKÁS ELŐTT, a "kézben" történik, nem utólag egy már
// elhelyezett elemen.
let hoveredDecoration = null;

// Dekorációk: {x, z, type, rot, scale} — VILÁG-méterben (rot RADIÁNBAN — lásd
// normalizeRotToRadians lent a régi, 0–3 "negyedfordulat" mentések
// migrációjáról). Mentéskor dgx=x/TRACK.tile, dgy=z/TRACK.tile (a
// decorations.js render-kód EZT várja: world=dgx*tile) — ugyanaz a
// konvenció, mint a régi "szabad" (free) elemeknél volt, csak mostantól
// MINDEN dekoráció ezt az utat követi (nincs többé rács-igazítás).
const decorations = [];
const decorTypeKeys = Object.keys(DECORATION_TYPES);
let activeDecorType = decorTypeKeys[0];
// A "kézben lévő" (LERAKÁS ELŐTTI) elem forgása (radián) és méret-szorzója —
// a "Forgatás" gomb ±90°-ot lép rajta, R lenyomva tartva + egérgörgővel
// SZABADON, tetszőleges fokban állítható (lásd a wheel-kezelőket), sima
// görgővel (R nélkül) pedig a méret-szorzó (activeScale) állítható. Mindkettő
// megmarad a KÖVETKEZŐ lerakásig — a lerakott elem MÁR NEM módosítható
// utólag (a felhasználó kifejezett kérése: a finomhangolás a kézben történjen).
let activeRot = 0;
let activeScale = 1;
let rotateKeyHeld = false; // R lenyomva tartva — ilyenkor a görgő forgat, nem méretez

// Boxutca-útvonal — {x,z}[] VILÁG-méterben, SZABADON rajzolt, NYITOTT vonal
// (nincs "zárás", mint a fő pályánál — lásd a "pitlane" módot lent). Egyenes
// szakaszokból áll (nincs Catmull-Rom simítás, mint a fő pályánál — a
// boxutcának nem kell éles kanyar-validáció, egy pár pontos, enyhén ívelt
// vonal bőven elég, és így a renderelés/fizika is jóval egyszerűbb marad,
// lásd sim/race.js distanceToPitLane). A tényleges szélesség egységes
// (RACE.pitStop.laneWidth), nincs pontonkénti állítás.
const pitLanePoints = [];

// A KIJELÖLT boxhelyek — {x,z}[] VILÁG-méterben (legfeljebb RACE.pitStop.
// maxBoxes, egy multiplayer játékosonként, lásd sim/race.js pitBoxForSlot).
// KÜLÖN áll a pitLanePoints-tól (nem eleme az útvonal-tömbnek szerkesztés
// közben — csak MENTÉSKOR/BETÖLTÉSKOR fésülődik egybe egyetlen tömbbé, lásd
// pitLaneForSave/loadLayoutIntoEditor), mert így a boxutca ALAKJÁT rajzoló/
// mutató kód (render, undo, mentés-hossz) egyszerűen csak a pitLanePoints
// tiszta útvonal-tömbjét látja, nem kell mindenhol kiszűrnie a boxhelyeket.
const pitBoxPoints = [];

let mode = 'track'; // 'track' | 'decor' | 'pitlane' | 'pitbox'
let problemPos = null; // { x, z } — az aktuális validációs hiba helye a vásznon (ha van)

// --- Globális visszavonás ---
//
// Egyetlen, "pillanatkép-alapú" verem — a MŰVELET FAJTÁJÁTÓL függetlenül (2D
// pont-húzás/törlés/beszúrás, 3D pont-húzás, dekoráció-lerakás/törlés bármelyik
// nézetben) minden STRUKTURÁLIS mutáció ELŐTT lementjük a teljes állapotot
// (pushUndo), a gomb pedig egyszerűen visszaállítja az utolsó mentést. Ez a
// legegyszerűbb módja annak, hogy a régi (csak az AKTUÁLIS mód utolsó lépését
// visszagörgető) undoBtn helyett MINDEN nézetben/módban egységesen működjön —
// nem kell művelet-specifikus inverz logikát írni mindenhová.
//
// SZÁNDÉKOSAN NEM követi a folyamatos (görgős) finomhangolást (pálya-
// szélesség, dekoráció "kézben" méret/forgatás) — azok minden egyes kattanása
// külön mentés lenne, elárasztva a vermet, hogy egyetlen húzás visszavonásához
// tucatszor kelljen nyomni a gombot. A visszavonás a STRUKTURÁLIS lépésekre
// (pont/dekoráció hozzáadása-törlése-mozgatása, hurok zárása, törlés) szól.
const undoStack = [];
const MAX_UNDO = 50;
function snapshotState() {
  return {
    points: points.map((p) => ({ ...p })),
    closed,
    decorations: decorations.map((d) => ({ ...d })),
    pitLanePoints: pitLanePoints.map((p) => ({ ...p })),
    pitBoxPoints: pitBoxPoints.map((p) => ({ ...p })),
  };
}
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}
function applyUndo() {
  if (!undoStack.length) {
    statusEl.textContent = 'Nincs több visszavonható lépés.';
    statusEl.classList.remove('closed');
    return;
  }
  const s = undoStack.pop();
  points.length = 0;
  points.push(...s.points);
  closed = s.closed;
  decorations.length = 0;
  decorations.push(...s.decorations);
  pitLanePoints.length = 0;
  pitLanePoints.push(...s.pitLanePoints);
  pitBoxPoints.length = 0;
  pitBoxPoints.push(...s.pitBoxPoints);
  render();
  updateStatus();
  refresh3DIfVisible();
}

// --- 3D előnézet (kapcsolható nézet — lásd render3d/editorPreview.js) ---
//
// SCOPE: a pálya vonala/boxutca 3D-ben csak MEGJELENIK (a fenti `points`/
// `pitLanePoints`/`pitBoxPoints` szerkesztése marad 2D-ben) — a 3D nézetben
// EGYEDÜL a dekoráció-elhelyezés interaktív. Emiatt a meglévő 2D `canvas`
// esemény-kezelők VÁLTOZATLANOK maradnak (2D nézetben a canvas látszik, 3D
// nézetben `display:none` — nem kapnak egérszemet), a 3D-s dekoráció-
// interakció pedig KÜLÖN, a 3D vászonra kötött listenerekben fut (lásd
// wire3DInteraction lent), UGYANAZOKAT a (tiszta, világ-koordinátás)
// findDecorationNear/computeSnap függvényeket használva, mint a 2D click.
let view = '2d'; // '2d' | '3d'
let editor3d = null; // { renderer, scene, camera, trackGroup, decorGroup } — lusta inicializálás
let editor3dReadyPromise = null;
let cameraController = null;
let decorGhost = null;
let pointMarkers = null;
let draggingPoint3D = null; // { kind:'track'|'pitlane', index } — a 3D-ben épp húzott pálya-/boxutca-pont
let trackRebuildPending = false; // lásd scheduleTrackRebuild — pont-húzás közben a DRÁGA (textúrát is töltő)
// pálya-szalag-újraépítést rAF-hurokra korlátozzuk, a jelölő-gömböt viszont
// minden mousemove-nál azonnal frissítjük (olcsó, textúra nélküli)
let lastGhostWorld = null; // a legutóbbi 3D raycast-pont — a Forgatás/palett-váltás gomb is ezt használja
let rafId = null;
let lastFrameTime = null;

function trackCentroid() {
  if (points.length === 0) return { x: 0, z: 0 };
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
}

async function ensureEditor3D() {
  if (editor3d) return;
  if (!editor3dReadyPromise) {
    editor3dReadyPromise = (async () => {
      editor3d = await createEditorScene(editor3dContainer);
      decorGhost = createDecorGhost(editor3d.scene);
      pointMarkers = createPointMarkers(editor3d.scene);
      cameraController = createFreeCameraController(editor3d.camera, editor3d.renderer.domElement, trackCentroid());
      wire3DInteraction();
    })();
  }
  await editor3dReadyPromise;
}

// A pálya-szalag/boxutca/dekorációk/pont-jelölők újraépítése a szerkesztő
// JELENLEGI (élő, esetleg még nem mentett) állapotából — minden 3D-belépéskor
// lefut, hogy a köztes (2D-ben végzett) szerkesztések azonnal látszódjanak.
function refresh3D() {
  if (!editor3d) return;
  rebuildEditorTrack(editor3d.trackGroup, points, closed, DEFAULT_WIDTH / 2, pitLanePoints, pitBoxPoints);
  rebuildEditorDecorations(editor3d.decorGroup, decorations);
  pointMarkers.rebuild(points, pitLanePoints);
}

// Az undo/clear/reset/betöltés gombok a 2D-panelen mindig elérhetők (nem csak
// 2D nézetben) — ha épp 3D-ben vagyunk, a rájuk adott mutáció után frissíteni
// kell a MÁR LÁTHATÓ 3D jelenetet is (különben csak a következő nézet-váltásig
// maradna elavott).
function refresh3DIfVisible() {
  if (view === '3d') refresh3D();
}

// Pont-húzás közben a TELJES pálya-szalag újraépítése (loadTrackRibbon —
// geometria ÉS textúra-betöltés) minden mousemove-nál érezhető akadást
// okozna. Ehelyett a szalagot legfeljebb képkockánként egyszer (rAF-fel
// összegyűjtve) építjük újra — a jelölő-gömb pozícióját viszont a hívó
// AZONNAL, ettől függetlenül frissíti (lásd wire3DInteraction), hogy a
// húzott pont maga sose akadjon.
function scheduleTrackRebuild() {
  if (trackRebuildPending || !editor3d) return;
  trackRebuildPending = true;
  requestAnimationFrame(() => {
    trackRebuildPending = false;
    if (editor3d) rebuildEditorTrack(editor3d.trackGroup, points, closed, DEFAULT_WIDTH / 2, pitLanePoints, pitBoxPoints);
  });
}

// A "kézben" lévő elem előnézeti pozíciója/forgása — ha van illeszthető
// szomszéd (computeSnap), a PONTOS illesztett helyen/forgással mutatjuk,
// UGYANÚGY, mint a 2D nézet hover-előnézete, hogy a 3D-ben is látszódjon,
// hova/hogyan fog ténylegesen odaillesztődni kattintáskor.
function decorPlacementPreview(worldPt) {
  const snap = computeSnap(worldPt, activeDecorType, activeRot, activeScale);
  return snap ? { x: snap.x, z: snap.z, rot: snap.rot } : { x: worldPt.x, z: worldPt.z, rot: activeRot };
}

function wire3DInteraction() {
  const dom = editor3d.renderer.domElement;

  // Pálya-/boxutca-pont húzása: MEGLÉVŐ pont bármikor megfogható (nem csak
  // "track"/"pitlane" módban — a 2D nézettel ellentétben itt nem kell módot
  // váltani a finomításhoz). `{capture:true}` KRITIKUS: a szabad kamera
  // (createFreeCameraController) SAJÁT mousedown-listenere ugyanezen a
  // vásznon, "bubble" fázisban indítaná a körülnézést — capture fázisban
  // MINDIG előbb fut le a mienk, és `stopPropagation()`-nel megelőzzük, hogy
  // a kattintás egyszerre pontot húzzon ÉS elforgassa a kamerát.
  let suppressNextClick = false;
  dom.addEventListener(
    'mousedown',
    (e) => {
      const hit = pointMarkers.pick(editor3d.camera, e.clientX, e.clientY, dom);
      if (!hit) return;
      e.stopPropagation();
      pushUndo();
      draggingPoint3D = hit;
      // A mousedown→mouseup PÁRT a böngésző utólag 'click'-ké is összevonja —
      // enélkül egy pont elengedése után a (mode==='decor' esetén futó) click-
      // kezelő tévesen lerakna/törölne egy dekorációt ugyanarra a kattintásra.
      suppressNextClick = true;
    },
    { capture: true }
  );
  window.addEventListener('mousemove', (e) => {
    if (!draggingPoint3D || view !== '3d' || !editor3d) return;
    const worldPt = raycastGround(editor3d.camera, e.clientX, e.clientY, dom);
    if (!worldPt) return;
    const arr = draggingPoint3D.kind === 'track' ? points : pitLanePoints;
    const p = arr[draggingPoint3D.index];
    if (!p) return;
    p.x = worldPt.x;
    p.z = worldPt.z;
    pointMarkers.rebuild(points, pitLanePoints); // olcsó — a húzott gömb azonnal kövesse a kurzort
    scheduleTrackRebuild(); // drága (textúrázott) szalag-újraépítés — legfeljebb képkockánként egyszer
    updateStatus();
  });
  window.addEventListener('mouseup', () => {
    draggingPoint3D = null;
  });

  dom.addEventListener('mousemove', (e) => {
    if (draggingPoint3D || mode !== 'decor') {
      decorGhost.hide();
      hoveredDecoration = null;
      return;
    }
    const worldPt = raycastGround(editor3d.camera, e.clientX, e.clientY, dom);
    if (!worldPt) {
      decorGhost.hide();
      hoveredDecoration = null;
      return;
    }
    lastGhostWorld = worldPt;
    hoveredDecoration = findDecorationNear(worldPt) || null;
    // Miközben egy MEGLÉVŐ elem fölött állunk (törléshez célzunk rá), a
    // szellem-előnézet zavaró lenne (két, egymást átfedő modell) — elrejtjük.
    // "Üres kéz" (ESC — lásd lent, activeDecorType===null) esetén sincs mit
    // előnézetezni.
    if (hoveredDecoration || !activeDecorType) {
      decorGhost.hide();
    } else {
      const preview = decorPlacementPreview(worldPt);
      decorGhost.update(activeDecorType, preview.x, preview.z, preview.rot, activeScale);
    }
  });
  dom.addEventListener('mouseleave', () => {
    decorGhost.hide();
    hoveredDecoration = null;
  });
  dom.addEventListener('click', (e) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (mode !== 'decor') return;
    const worldPt = raycastGround(editor3d.camera, e.clientX, e.clientY, dom);
    if (!worldPt) return;
    const existing = findDecorationNear(worldPt);
    if (existing) {
      pushUndo();
      decorations.splice(decorations.indexOf(existing), 1);
      hoveredDecoration = null;
    } else {
      if (!activeDecorType) return; // "üres kéz" (ESC) — nincs mit lerakni
      pushUndo();
      const preview = decorPlacementPreview(worldPt);
      decorations.push({ x: preview.x, z: preview.z, type: activeDecorType, rot: preview.rot, scale: activeScale });
    }
    rebuildEditorDecorations(editor3d.decorGroup, decorations);
    updateStatus();
  });
  // Görgő a "kézben" lévő elemen: R lenyomva tartva SZABADON forgat
  // (tetszőleges fok, nem csak negyedfordulat), R nélkül a méret-szorzót
  // állítja — UGYANAZ a logika, mint a 2D canvas wheel-kezelőjében.
  dom.addEventListener(
    'wheel',
    (e) => {
      if (mode !== 'decor' || !activeDecorType) return;
      e.preventDefault();
      if (rotateKeyHeld) {
        const delta = e.deltaY < 0 ? ROTATE_STEP : -ROTATE_STEP;
        activeRot = (activeRot + delta + Math.PI * 2) % (Math.PI * 2);
      } else {
        const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
        activeScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, activeScale + delta));
      }
      if (lastGhostWorld && !hoveredDecoration) {
        const preview = decorPlacementPreview(lastGhostWorld);
        decorGhost.update(activeDecorType, preview.x, preview.z, preview.rot, activeScale);
      }
    },
    { passive: false }
  );
}

function startRafLoop() {
  if (rafId !== null) return;
  lastFrameTime = performance.now();
  const tick = (t) => {
    const dt = Math.min(0.1, (t - lastFrameTime) / 1000);
    lastFrameTime = t;
    if (cameraController) cameraController.update(dt);
    editor3d.renderer.render(editor3d.scene, editor3d.camera);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopRafLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

async function setView(newView) {
  if (newView === view) return;
  view = newView;
  view2dBtn.classList.toggle('active', view === '2d');
  view3dBtn.classList.toggle('active', view === '3d');
  if (view === '3d') {
    canvas.style.display = 'none';
    editor3dContainer.style.display = 'block';
    // A konténer épp most vált láthatóvá — a createScene3D belső resize-
    // figyelője (lásd scene.js) 0×0 méret miatt kihagyta a frissítést, amíg
    // rejtve volt; egy explicit resize-esemény szinkronizálja a kamerát/
    // renderert a konténer TÉNYLEGES (most már nem-nulla) méretére.
    await ensureEditor3D();
    window.dispatchEvent(new Event('resize'));
    refresh3D();
    startRafLoop();
  } else {
    stopRafLoop();
    if (decorGhost) decorGhost.hide();
    editor3dContainer.style.display = 'none';
    canvas.style.display = 'block';
  }
}

view2dBtn.addEventListener('click', () => setView('2d'));
view3dBtn.addEventListener('click', () => setView('3d'));

// --- Koordináta-átváltás (világ-méter ⇄ vászon-pixel) ---

function worldToScreen(p) {
  return {
    x: CANVAS_W / 2 + (p.x - viewCenter.x) * pxPerMeter,
    y: CANVAS_H / 2 + (p.z - viewCenter.z) * pxPerMeter,
  };
}
function screenToWorld(sx, sy) {
  return {
    x: viewCenter.x + (sx - CANVAS_W / 2) / pxPerMeter,
    z: viewCenter.z + (sy - CANVAS_H / 2) / pxPerMeter,
  };
}

// Be-/kizoomol a MEGADOTT képernyő-pont köré: a pont alatti világ-koordináta
// a zoom UTÁN is ugyanott marad a képernyőn (nem "ugrik el" a nézet zoomoláskor).
function zoomAt(screenPt, factor) {
  const worldPtBefore = screenToWorld(screenPt.x, screenPt.y);
  pxPerMeter = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pxPerMeter * factor));
  viewCenter.x = worldPtBefore.x - (screenPt.x - CANVAS_W / 2) / pxPerMeter;
  viewCenter.z = worldPtBefore.z - (screenPt.y - CANVAS_H / 2) / pxPerMeter;
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

function findPitLanePointNear(screenPt) {
  for (let i = 0; i < pitLanePoints.length; i++) {
    const s = worldToScreen(pitLanePoints[i]);
    if (Math.hypot(s.x - screenPt.x, s.y - screenPt.y) < HIT_RADIUS_PX) return i;
  }
  return -1;
}

function findPitBoxNear(screenPt) {
  for (let i = 0; i < pitBoxPoints.length; i++) {
    const s = worldToScreen(pitBoxPoints[i]);
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
// SAJÁT d.rot-jával — d.rot RADIÁNBAN (nem negyedfordulat-index, lásd
// normalizeRotToRadians: a szabad R+görgő forgatás miatt bármilyen fok lehet).
function localToWorld(d, lx, lz) {
  const a = d.rot || 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: d.x + lx * cos - lz * sin, z: d.z + lx * sin + lz * cos };
}
function localDirToWorld(d, lx, lz) {
  const a = d.rot || 0;
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

// Egy elhelyezett dekoráció (`d.scale`, alapból 1 — a "kézben" beállított
// méret-szorzó, LERAKÁS UTÁN már nem módosítható) TÉNYLEGES (a base
// footprint-re rászorzott) mérete. Egy ÚJONNAN lerakandó elem előnézetéhez
// nem kell ez a wrapper (azt közvetlenül activeScale-lel számoljuk) — csak a
// MÁR LÉTEZŐ elemek footprintjét (hit-teszt, illesztés, kirajzolás) kell
// ezen átvezetni.
function scaledFootprint(d, fp) {
  if (!fp) return fp;
  const s = d.scale || 1;
  return { width: fp.width * s, depth: fp.depth * s };
}

// RÉGI mentések d.rot mezője negyedfordulat-INDEX volt (0–3, ×90°) — az új
// szabad (R + görgő) forgatás óta d.rot RADIÁN. A két alak nem
// különböztethető meg formálisan, DE a régi formátum kizárólag a {0,1,2,3}
// egész értékeket vehette fel (a korábbi UI csak ezt a négyet tudta
// előállítani), míg egy szabadon forgatott, folytonos egér-görgő-bevitelből
// származó radián érték gyakorlatilag SOSEM esik pontosan egy egészre —
// ezért ez a heurisztika biztonságosan migrálja a régi mentéseket, új
// (radián) adatot pedig érintetlenül hagy.
function normalizeRotToRadians(rot) {
  const r = rot || 0;
  return Number.isInteger(r) && r >= 0 && r <= 3 ? r * (Math.PI / 2) : r;
}

// worldPt a `d` dekoráció (rot-tal elforgatott) téglalapján BELÜL esik-e —
// inverz forgatással a lokális keretbe transzformálva (a forgatás
// ortonormált, tehát az inverz a transzponáltja).
function pointInFootprint(worldPt, d, fp) {
  const a = d.rot || 0;
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
    if (fp) return pointInFootprint(worldPt, d, scaledFootprint(d, fp));
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
function computeSnap(worldPt, type, rot, scale = 1) {
  const def = DECORATION_TYPES[type];
  const fp = footprints[type];
  if (!def?.snap || !fp) return null;
  const ownFp = { width: fp.width * scale, depth: fp.depth * scale };

  let bestEdge = null;
  let bestOwner = null;
  let bestDist = SNAP_DISTANCE_M;
  for (const d of decorations) {
    const ndef = DECORATION_TYPES[d.type];
    const nfp = footprints[d.type];
    if (!ndef?.snap || !nfp) continue;
    for (const edge of footprintEdges(d, scaledFootprint(d, nfp))) {
      const dist = Math.hypot(edge.mid.x - worldPt.x, edge.mid.z - worldPt.z);
      if (dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
        bestOwner = d;
      }
    }
  }
  if (!bestEdge) return null;

  // A szabad (nem csak negyedfordulatos) forgatás óta a MEGADOTT `rot` a
  // szomszédétól tetszőleges szöggel eltérhet — élő hibajelentés: emiatt a
  // "legjobban szembenéző" saját él már csak KÖZELÍTŐLEG (nem pontosan)
  // állt szemben a szomszéd élével, ami a két él KÖZÉPPONTJÁT egybeejtve
  // ferde, lépcsős illeszkedést adott (screenshot: 3 lelátó eltolva egymáshoz
  // képest), nem sima, egyenes sort. A javítás: a lerakandó elem forgását a
  // SZOMSZÉD forgásához képest a LEGKÖZELEBBI 90°-os többszörösre kerekítjük
  // — így egyenes folytatásnál (kis eltérés) PONTOSAN a szomszéd szögére áll
  // vissza, derékszögű saroknál (kb. 90°-os eltérés) pedig pontosan 90°-ra —
  // mindkét esetben a két él GARANTÁLTAN pontosan szembenéz, nem csak
  // "leginkább".
  const neighborRot = bestOwner.rot || 0;
  const relative = rot - neighborRot;
  const snappedRot = neighborRot + Math.round(relative / (Math.PI / 2)) * (Math.PI / 2);

  // Az új elem saját élei (a KEREKÍTETT forgással, egy képzeletbeli origóban
  // álló példányon) — azt választjuk, amelyiknek a normálisa a legjobban
  // "szembenéz" a megtalált szomszéd-éllel (skaláris szorzat maximuma a
  // −bestEdge.normal-lal) — a kerekítés miatt ez már PONTOSAN szembenéz.
  const ownEdges = footprintEdges({ x: 0, z: 0, rot: snappedRot }, ownFp);
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
    rot: snappedRot,
  };
}

// Egy boxutca-pont AUTOMATIKUS illesztése a főút középvonalához — ha a
// kattintás PIT_LANE_SNAP_M-en belül esik a legközelebbi útponthoz, PONTOSAN
// arra a pontra kerül (nem csak közelébe), hogy a boxutca-útvonal és a főút
// fizikailag/vizuálisan biztosan összeérjen (lásd sim/race.js
// withPitLaneOffRoad — mindkettő burkolatnak számít, tehát a köztük lévő rés
// nulla, ha a végpontok egybeesnek). Ha nincs (lezárt) főút a közelben, a
// nyers kattintás-pozíció marad.
function snapToTrackCenterline(worldPt) {
  if (!closed || points.length < MIN_CONTROL_POINTS) return worldPt;
  let sampled;
  try {
    sampled = sampleSpline(points, 2);
  } catch {
    return worldPt;
  }
  let best = null;
  let bestDist = PIT_LANE_SNAP_M;
  for (const p of sampled) {
    const d = Math.hypot(worldPt.x - p.x, worldPt.z - p.z);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best ? { x: best.x, z: best.z } : worldPt;
}

// A boxhely PONTOS illesztése a MEGRAJZOLT boxutca-útvonal legközelebbi
// pontjára (nem csak a kontrollpontokra — a szakaszok MENTÉN bárhová, hogy a
// boxhely a lane bármely pontjára tehető legyen, nem csak a törésekre). A
// visszaadott `dir` a szakasz haladási iránya (radián) — ebből számolja a
// hívó, merre van a "jobb oldal" (lásd offsetToRightSide). null-t ad, ha még
// nincs (legalább 2 pontos) boxutca-útvonal.
function snapToPitLane(worldPt) {
  if (pitLanePoints.length < 2) return null;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < pitLanePoints.length - 1; i++) {
    const a = pitLanePoints[i];
    const b = pitLanePoints[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((worldPt.x - a.x) * dx + (worldPt.z - a.z) * dz) / lenSq));
    const cx = a.x + t * dx;
    const cz = a.z + t * dz;
    const d = Math.hypot(worldPt.x - cx, worldPt.z - cz);
    if (d < bestDist) {
      bestDist = d;
      best = { x: cx, z: cz, dir: Math.atan2(dz, dx) };
    }
  }
  return best;
}

// A boxutca-útvonal JOBB OLDALÁRA tolja a pontot (mint egy valódi boxutca
// falhoz simuló parkolóhelye) — "jobb" a HALADÁSI IRÁNYHOZ (dir) képest,
// UGYANAZZAL a forgatással, mint amit sim/car.js rightNormal-ja a fizikában
// használ (jobb = a haladási irány -90°-os elforgatása). Az eltolás mértéke
// pont annyi, hogy a boxhely a lane szélén, de MÉG belül üljön (nem lóg ki).
// A megadott ponthoz legközelebbi útvonal-SZAKASZ iránya (radián) — a
// boxhely-rács ezzel forog, hogy úgy nézzen ki, mintha a boxutcára
// "festették" volna. Ugyanaz a logika, mint render3d/pitMarker.js-é.
function laneDirectionNear(pos) {
  if (pitLanePoints.length < 2) return 0;
  let bestDist = Infinity;
  let bestDir = 0;
  for (let i = 0; i < pitLanePoints.length - 1; i++) {
    const a = pitLanePoints[i];
    const b = pitLanePoints[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.z - a.z) * dz) / lenSq));
    const cx = a.x + t * dx;
    const cz = a.z + t * dz;
    const d = Math.hypot(pos.x - cx, pos.z - cz);
    if (d < bestDist) { bestDist = d; bestDir = Math.atan2(dz, dx); }
  }
  return bestDir;
}

function offsetToRightSide(pos, dir) {
  // Ugyanaz a jobb-vektor, mint sim/car.js rightNormal-ja: a testet R(dir)-vel
  // elforgatva a helyi (0,1) "jobb" világ-irányba (-sin(dir), cos(dir)) esik
  // (fizika x,y ⇔ világ x,z, lásd CLAUDE.md 2.5D leképezés).
  const rightX = -Math.sin(dir);
  const rightZ = Math.cos(dir);
  // A boxhely BELSŐ (középvonal felőli) éle a középvonalon TÚL, a lane JOBB
  // felében kezdődjön — ne csak feléje toljuk el. Enélkül (pl. korábban:
  // laneWidth/2 - boxWidth/2) egy széles boxhely még mindig átlógott a
  // középvonalon, és úgy nézett ki, mintha "középen" lenne, nem a jobb
  // oldalon. A +0.3 m egy apró rés a középvonaltól, hogy vizuálisan is
  // egyértelműen elváljon.
  const offset = RACE.pitStop.boxWidth / 2 + 0.3;
  return { x: pos.x + rightX * offset, z: pos.z + rightZ * offset };
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
  modeTrackBtn.classList.toggle('active', mode === 'track');
  modeDecorBtn.classList.toggle('active', mode === 'decor');
  if (modePitLaneBtn) modePitLaneBtn.classList.toggle('active', mode === 'pitlane');
  if (modePitBoxBtn) modePitBoxBtn.classList.toggle('active', mode === 'pitbox');
  trackLegendEl.style.display = mode === 'track' ? 'flex' : 'none';
  decorControlsEl.style.display = mode === 'decor' ? 'block' : 'none';
  if (mode === 'track') {
    instructionsEl.textContent =
      'Kattints bárhova a pálya rajzolásának megkezdéséhez, majd folytasd további pontokkal — a görbe automatikusan simán illeszkedik közéjük. Legalább 4 pont után kattints vissza az első (arany) pontra a hurok zárásához. Zárás után: húzd a pontokat az áthelyezéshez, kattints a görbe közelébe új pont beszúrásához, jobb-kattints egy pontra a törléséhez, görgess egy pont fölött a szélességének (a "Xm" felirat) állításához, vagy dupla kattints egy pontra, hogy éles sarokká (négyzet) váltson — így sikánok, hajtűk is rajzolhatók.';
  } else if (mode === 'decor') {
    instructionsEl.textContent =
      'Válaszd ki az elemet lent (a neve mellett a valós mérete is látszik, amint betöltődött), állítsd be a "Forgatás" gombbal az irányát (a sárga nyíl + "E" felirat mutatja az elejét), majd kattints a pálya bármely pontjára a lerakáshoz. A fal/kerítés/garázs/iroda/lelátó/terelőkorlát egy MÁSIK ilyen elem éléhez közel automatikusan a PONTOS illesztett helyre kerül (rés/átfedés nélkül) — a FORGATÁSA mindig a beállított marad, tehát derékszögű sarok is építhető (forgasd 90°-kal, majd kattints a szomszéd sarkához). Máshova kattintva szabadon kerül le. Egy meglévő elemre (a téglalapján belül) kattintva eltávolítod.';
  } else if (mode === 'pitlane') {
    instructionsEl.textContent =
      'Kattints a pálya mentén, ahol a boxutcát szeretnéd — nyitott vonalat rajzolsz, NEM kell zárni. Ha a kattintás a főút közelébe esik, a pont automatikusan pontosan az útra illeszkedik (nincs fű-rés). Legalább 2 pont kell. Jobb-kattintással törölhetsz egy pontot.';
  } else {
    instructionsEl.textContent =
      `Kattints a MEGRAJZOLT boxutcára (előbb rajzold meg "Boxutca" módban), hogy kijelölj egy PONTOS helyet, ahol meg kell állni a kerékcseréhez — a kattintás a boxutca legközelebbi pontjára illeszkedik. Legfeljebb ${RACE.pitStop.maxBoxes} boxhely rakható le (multiplayerben minden játékosnak a SAJÁTJA jut, sorrendben — 1. hely = 1. beszálló, stb.). Egy MEGLÉVŐ boxhelyre kattintva törlöd.`;
  }
  hover = null;
  hoveredDecoration = null;
  if (mode !== 'decor' && decorGhost) decorGhost.hide();
  render();
  updateStatus();
}

modeTrackBtn.addEventListener('click', () => setMode('track'));
modeDecorBtn.addEventListener('click', () => setMode('decor'));
if (modePitLaneBtn) modePitLaneBtn.addEventListener('click', () => setMode('pitlane'));
if (modePitBoxBtn) modePitBoxBtn.addEventListener('click', () => setMode('pitbox'));

// Dekoráció-paletta felépítése a config.js DECORATION_TYPES alapján,
// DECORATION_CATEGORIES szerint csoportosítva (kártya-elrendezés: nagy ikon +
// név + méret), plusz kereső-szűrő — a Kenney "City Kit Commercial" készlet
// hozzáadásával a paletta ~40 elemesre nőtt, egy sima gombsor itt már
// átláthatatlan lenne.
const paletteButtons = {}; // type → <button> — a betöltött méret utólag frissíti a feliratot
const paletteCategoryEls = {}; // category key → { header, group } — a kereséshez kell elrejteni/mutatni

function paletteLabelText(key) {
  const def = DECORATION_TYPES[key];
  const fp = footprints[key];
  const size = fp ? ` (${fp.width.toFixed(1)}×${fp.depth.toFixed(1)}m)` : '';
  return `${def.label}${size}`;
}

function selectDecorType(key, btn) {
  activeDecorType = key;
  for (const b of decorPaletteEl.querySelectorAll('button')) b.classList.remove('active');
  btn.classList.add('active');
  if (view === '3d' && decorGhost && lastGhostWorld) {
    const preview = decorPlacementPreview(lastGhostWorld);
    decorGhost.update(activeDecorType, preview.x, preview.z, preview.rot, activeScale);
  }
}

for (const { key: categoryKey, label: categoryLabel } of DECORATION_CATEGORIES) {
  const keys = decorTypeKeys.filter((k) => DECORATION_TYPES[k].category === categoryKey);
  if (keys.length === 0) continue;

  const header = document.createElement('div');
  header.className = 'decorLayerHeader';
  header.textContent = categoryLabel;
  decorPaletteEl.appendChild(header);

  const group = document.createElement('div');
  group.className = 'decorLayerGroup';
  for (const key of keys) {
    const def = DECORATION_TYPES[key];
    const btn = document.createElement('button');
    btn.className = 'decorCard';
    btn.dataset.type = key;
    const iconEl = document.createElement('span');
    iconEl.className = 'decorCardIcon';
    iconEl.textContent = def.icon;
    const labelEl = document.createElement('span');
    labelEl.className = 'decorCardLabel';
    labelEl.textContent = paletteLabelText(key);
    btn.appendChild(iconEl);
    btn.appendChild(labelEl);
    if (key === activeDecorType) btn.classList.add('active');
    btn.addEventListener('click', () => selectDecorType(key, btn));
    paletteButtons[key] = btn;
    group.appendChild(btn);
  }
  decorPaletteEl.appendChild(group);
  paletteCategoryEls[categoryKey] = { header, group };
}

// Kereső-szűrő — a NÉV alapján (nem a típuskulcs) szűr, kis/nagybetű-
// érzéketlenül, ékezet-érzékenyen (a magyar feliratok ékezetesek — a
// felhasználó valószínűleg ugyanúgy gépeli be, ahogy látja). Egy kategória
// teljes fejléc+kártyacsoportja elrejtődik, ha egyetlen kártyája sem
// egyezik — üres kategória-fejléc sose maradjon látva.
if (decorSearchInput) {
  decorSearchInput.addEventListener('input', () => {
    const q = decorSearchInput.value.trim().toLowerCase();
    for (const { key: categoryKey } of DECORATION_CATEGORIES) {
      const els = paletteCategoryEls[categoryKey];
      if (!els) continue;
      let anyVisible = false;
      for (const key of decorTypeKeys.filter((k) => DECORATION_TYPES[k].category === categoryKey)) {
        const btn = paletteButtons[key];
        const match = !q || DECORATION_TYPES[key].label.toLowerCase().includes(q);
        btn.style.display = match ? '' : 'none';
        if (match) anyVisible = true;
      }
      els.header.style.display = anyVisible ? '' : 'none';
      els.group.style.display = anyVisible ? '' : 'none';
    }
  });
}

// A modellek valós mérete aszinkron töltődik be (glTF-parszolás) — amint egy
// típusé megjön, frissítjük a palettán a feliratát ÉS újrarajzolunk (hogy a
// már lerakott ilyen típusú elemek is megkapják a méret-téglalapot/illesztést).
for (const key of decorTypeKeys) {
  getFootprint(key).then((fp) => {
    if (!fp) return;
    footprints[key] = fp;
    const labelEl = paletteButtons[key]?.querySelector('.decorCardLabel');
    if (labelEl) labelEl.textContent = paletteLabelText(key);
    render();
  });
}

rotateBtn.addEventListener('click', () => {
  activeRot = (activeRot + Math.PI / 2) % (Math.PI * 2);
  render();
  if (view === '3d' && decorGhost && lastGhostWorld) {
    const preview = decorPlacementPreview(lastGhostWorld);
    decorGhost.update(activeDecorType, preview.x, preview.z, preview.rot, activeScale);
  }
});

// --- Interakció ---

canvas.addEventListener('mousedown', (e) => {
  // Pásztázás indítása — középső gomb VAGY Szóköz+bal gomb — módtól
  // FÜGGETLENÜL az első, hogy a lenti mód-specifikus logika (pont-húzás,
  // dekoráció-lerakás stb.) sose fusson le ugyanarra a kattintásra.
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault();
    panning = true;
    canvas.style.cursor = 'grabbing';
    panStartScreen = pixelToScreen(e.clientX, e.clientY);
    panStartCenter = { ...viewCenter };
    return;
  }
  if (mode === 'pitlane') {
    const screenPt = pixelToScreen(e.clientX, e.clientY);
    const worldPt = screenToWorld(screenPt.x, screenPt.y);
    // Egy MEGLÉVŐ boxutca-ponton kattintva húzhatóvá tesszük (mint a fő
    // pályánál) — a mozgatás a mousemove-ban folytatódik (lásd dragIndex).
    const hitIdx = findPitLanePointNear(screenPt);
    if (hitIdx !== -1) {
      pushUndo();
      dragIndex = hitIdx;
      return;
    }
    pushUndo();
    pitLanePoints.push(snapToTrackCenterline(worldPt));
    render();
    updateStatus();
    return;
  }
  if (mode === 'pitbox') {
    const screenPt = pixelToScreen(e.clientX, e.clientY);
    // Egy MEGLÉVŐ boxhelyre kattintva eltávolítjuk (mint a dekorációknál) —
    // így nem kell külön "törlés" módra váltani egy tévesen lerakott boxhely
    // miatt.
    const hitIdx = findPitBoxNear(screenPt);
    if (hitIdx !== -1) {
      pushUndo();
      pitBoxPoints.splice(hitIdx, 1);
      render();
      updateStatus();
      return;
    }
    if (pitBoxPoints.length >= RACE.pitStop.maxBoxes) {
      statusEl.textContent = `Elérted a boxhelyek felső korlátját (${RACE.pitStop.maxBoxes}) — előbb törölj egyet.`;
      statusEl.classList.remove('closed');
      return;
    }
    const worldPt = screenToWorld(screenPt.x, screenPt.y);
    const snapped = snapToPitLane(worldPt);
    if (!snapped) {
      statusEl.textContent = 'Előbb rajzold meg a boxutcát ("Boxutca" mód, legalább 2 pont).';
      statusEl.classList.remove('closed');
      return;
    }
    // A boxutca JOBB oldalára toljuk (mint egy valódi, falhoz simuló
    // parkolóhely) — lásd offsetToRightSide.
    pushUndo();
    pitBoxPoints.push(offsetToRightSide(snapped, snapped.dir));
    render();
    updateStatus();
    return;
  }
  if (mode !== 'track') return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const worldPt = screenToWorld(screenPt.x, screenPt.y);

  if (!closed) {
    // A hurok zárása ELŐBB, mint az "eltaláltam egy pontot" ellenőrzés — az első
    // pont ÚGY IS "pont", de itt kattintva zárni akarunk, nem húzni.
    if (nearFirstPoint(screenPt)) {
      pushUndo();
      closed = true;
      render();
      updateStatus();
      return;
    }
    const hitIdx = findPointNear(screenPt);
    if (hitIdx !== -1) {
      pushUndo();
      dragIndex = hitIdx;
      return;
    }
    // Új pont szélessége öröklődik az előzőtől (vagy alapérték az elsőnél) —
    // így egy már beállított szélesség "tovább fut" a következő pontokra.
    const width = points.length > 0 ? points[points.length - 1].width : DEFAULT_WIDTH;
    pushUndo();
    points.push({ ...worldPt, width });
    render();
    updateStatus();
    return;
  }

  // Zárt pálya: pont húzása, vagy új pont beszúrása a görbe közelébe kattintva.
  const hitIdx = findPointNear(screenPt);
  if (hitIdx !== -1) {
    pushUndo();
    dragIndex = hitIdx;
    return;
  }
  const { index, dist } = nearestChordSegment(worldPt);
  if (dist * pxPerMeter < CURVE_HIT_RADIUS_PX) {
    // A beszúrt pont szélessége a két szomszédos kontrollpont átlaga — simán
    // illeszkedik a már beállított szélesség-átmenetbe.
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const width = (a.width + b.width) / 2;
    pushUndo();
    points.splice(index + 1, 0, { ...worldPt, width });
    render();
    updateStatus();
  }
});

// Pásztázás mozgatása — a vászonon KÍVÜLRE is folytatódhat (window-szintű,
// mint a pont-húzás mouseup-ja lent), a canvas saját mousemove-ja ilyenkor
// korán visszatér (lásd alább), hogy ne fusson le kétszer/ütközzön.
window.addEventListener('mousemove', (e) => {
  if (!panning) return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  viewCenter.x = panStartCenter.x - (screenPt.x - panStartScreen.x) / pxPerMeter;
  viewCenter.z = panStartCenter.z - (screenPt.y - panStartScreen.y) / pxPerMeter;
  render();
});

canvas.addEventListener('mousemove', (e) => {
  if (panning) return;
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
  if (mode === 'pitlane' && dragIndex !== null) {
    pitLanePoints[dragIndex] = snapToTrackCenterline(worldPt);
    render();
    updateStatus();
    return;
  }
  hover = { screenPt, worldPt };
  hoveredDecoration = mode === 'decor' ? findDecorationNear(worldPt) || null : null;
  render();
});

canvas.addEventListener('mouseleave', () => {
  hover = null;
  hoveredDecoration = null;
  render();
});

// A mouseup-ot az EGÉSZ ablakon figyeljük (nem csak a vásznon), hogy a húzás
// akkor is helyesen véget érjen, ha a felhasználó közben kicsúszik a vászonból.
window.addEventListener('mouseup', () => {
  if (panning) {
    panning = false;
    canvas.style.cursor = spaceHeld ? 'grab' : '';
  }
  if (dragIndex !== null) {
    dragIndex = null;
    updateStatus();
  }
});

// Jobb-klikk: egy kontrollpont törlése (track módban) — legalább MIN_CONTROL_POINTS
// pontnak meg kell maradnia.
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode === 'pitlane') {
    const screenPt = pixelToScreen(e.clientX, e.clientY);
    const hitIdx = findPitLanePointNear(screenPt);
    if (hitIdx === -1) return;
    pushUndo();
    pitLanePoints.splice(hitIdx, 1);
    render();
    updateStatus();
    return;
  }
  if (mode === 'pitbox') {
    const screenPt = pixelToScreen(e.clientX, e.clientY);
    const hitIdx = findPitBoxNear(screenPt);
    if (hitIdx === -1) return;
    pushUndo();
    pitBoxPoints.splice(hitIdx, 1);
    render();
    updateStatus();
    return;
  }
  if (mode !== 'track') return;
  const screenPt = pixelToScreen(e.clientX, e.clientY);
  const hitIdx = findPointNear(screenPt);
  if (hitIdx === -1) return;
  if (points.length <= MIN_CONTROL_POINTS) {
    statusEl.textContent = `Legalább ${MIN_CONTROL_POINTS} pont kell — ez már nem törölhető.`;
    statusEl.classList.remove('closed');
    return;
  }
  pushUndo();
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
const ZOOM_STEP_FACTOR = 1.15; // egy görgő-kattanás ennyiszeresére nagyítja/kicsinyíti a nézetet

canvas.addEventListener(
  'wheel',
  (e) => {
    // Ctrl+görgő = zoom a kurzor alá — MÓDTÓL FÜGGETLENÜL az első, hogy ne
    // ütközzön a lenti mód-specifikus finomhangolásokkal (pálya-szélesség,
    // dekoráció méret/forgatás), amik simán görgőt használnak modifier nélkül.
    if (e.ctrlKey) {
      e.preventDefault();
      const screenPt = pixelToScreen(e.clientX, e.clientY);
      zoomAt(screenPt, e.deltaY < 0 ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR);
      render();
      return;
    }
    if (mode === 'track') {
      const screenPt = pixelToScreen(e.clientX, e.clientY);
      const hitIdx = findPointNear(screenPt);
      if (hitIdx === -1) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? WIDTH_STEP : -WIDTH_STEP;
      const p = points[hitIdx];
      p.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, p.width + delta));
      render();
      updateStatus();
      return;
    }
    // Decor módban a "kézben" lévő (LERAKÁS ELŐTTI) elemet finomítja: R
    // lenyomva tartva SZABADON forgat (bármilyen fok), R nélkül a
    // méret-szorzót állítja. Egy MÁR LERAKOTT elem többé nem módosítható
    // utólag (a felhasználó kérése) — a kattintás rá csak törli.
    if (mode === 'decor' && activeDecorType) {
      e.preventDefault();
      if (rotateKeyHeld) {
        const delta = e.deltaY < 0 ? ROTATE_STEP : -ROTATE_STEP;
        activeRot = (activeRot + delta + Math.PI * 2) % (Math.PI * 2);
      } else {
        const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
        activeScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, activeScale + delta));
      }
      render();
    }
  },
  { passive: false }
);

// R billentyű LENYOMVA TARTÁSA: amíg tartjuk, a fenti wheel-kezelő (2D ÉS 3D)
// forgat méretezés helyett — így a "kézben" lévő elem SZABADON, tetszőleges
// fokban forgatható, nem csak negyedfordulatonként (a "Forgatás" gomb erre a
// gyors 90°-os lépésre maradt).
// ESC: "üres kéz" — leveszi a kiválasztott palett-elemet (activeDecorType
// null lesz), hogy a kattintás decor módban ne rakjon le semmit, amíg a
// felhasználó újra nem választ típust a palettán. A palett-gombok "active"
// jelölése is törlődik. Szövegmezőben gépelést (pl. pálya neve) egyik
// billentyű sem szakítja meg — csak akkor fut, ha a fókusz NEM egy
// input/textarea.
window.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

  if (e.key === 'Escape') {
    activeDecorType = null;
    for (const b of decorPaletteEl.querySelectorAll('button')) b.classList.remove('active');
    if (decorGhost) decorGhost.hide();
    render();
    return;
  }

  if (e.key.toLowerCase() === 'r') rotateKeyHeld = true;

  // Szóköz lenyomva tartva: a bal gombos húzás pásztázássá válik (lásd a
  // canvas mousedown-ját) — az oldal ne görgessen emiatt.
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      canvas.style.cursor = 'grab';
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'r') rotateKeyHeld = false;
  if (e.code === 'Space') {
    spaceHeld = false;
    if (!panning) canvas.style.cursor = '';
  }
});

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
  pushUndo();
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
    pushUndo();
    decorations.splice(decorations.indexOf(existing), 1);
  } else {
    if (!activeDecorType) return; // "üres kéz" (ESC) — nincs mit lerakni
    pushUndo();
    const preview = decorPlacementPreview(worldPt);
    decorations.push({ x: preview.x, z: preview.z, type: activeDecorType, rot: preview.rot, scale: activeScale });
  }
  render();
  updateStatus();
});

// Globális visszavonás — lásd a pushUndo/applyUndo megjegyzését fent: MINDEN
// nézetben/módban az utolsó STRUKTURÁLIS lépést vonja vissza (nem csak az
// aktuális módét, mint a régi, pop()-alapú viselkedés).
undoBtn.addEventListener('click', applyUndo);

clearBtn.addEventListener('click', () => {
  pushUndo();
  points.length = 0;
  closed = false;
  decorations.length = 0;
  pitLanePoints.length = 0;
  pitBoxPoints.length = 0;
  render();
  updateStatus();
  refresh3DIfVisible();
});

function gotoGame() {
  stopRafLoop();
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
    scale: d.scale || 1,
  }));
}

// A boxutca-útvonal mentésre kész alakja — VILÁG-méterben, akárcsak a layout
// (nincs dgx/dgy grid-skálázás, mint a dekorációknál), mert sim/race.js
// distanceToPitLane közvetlenül {x,z} világ-koordinátákat vár. A kijelölt
// boxhelyeket plusz pontokként fűzzük a tömb VÉGÉRE, isBox:true jelöléssel
// (lásd sim/race.js splitPitLane — ezek NEM az útvonal RÉSZEI, a
// szerkesztőben ezért is külön állapotban tartjuk, lásd pitBoxPoints).
function pitLaneForSave() {
  const path = pitLanePoints.map((p) => ({ x: p.x, z: p.z }));
  const boxes = pitBoxPoints.map((p) => ({ x: p.x, z: p.z, isBox: true }));
  return [...path, ...boxes];
}

saveBtn.addEventListener('click', async () => {
  const layout = currentLayout();
  if (!layout) return;
  const relDecorations = decorationsForSave();
  const relPitLane = pitLaneForSave();
  const name = trackNameInput.value.trim();
  // Ez a pálya induljon a játékban (lokális átadás a config.js felé). Nincs
  // külön "editor-nézet" — a layout maga a WYSIWYG forrás (lásd fenti komment).
  setActiveTrack(name, layout, relDecorations, relPitLane);
  // Ha van neve, GLOBÁLISAN is elmentjük a szerverre (minden gépről elérhető).
  // Ha a szerver nem elérhető, akkor is elindul lokálisan — csak nem lesz globális.
  if (name) {
    saveBtn.disabled = true;
    try {
      await apiSaveTrack({ name, layout, decorations: relDecorations, pitLane: relPitLane });
    } catch (e) {
      statusEl.textContent = `⚠️ Globális mentés sikertelen (${e.message}). Lokálisan indítom.`;
      statusEl.classList.remove('closed');
    }
  }
  gotoGame();
});

resetDefaultBtn.addEventListener('click', () => {
  pushUndo();
  clearCustomLayout();
  points.length = 0;
  closed = false;
  decorations.length = 0;
  pitLanePoints.length = 0;
  pitBoxPoints.length = 0;
  trackNameInput.value = '';
  render();
  renderSavedTracksList();
  refresh3DIfVisible();
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
  let pitNote = '';
  if (pitLanePoints.length >= 2 && pitBoxPoints.length > 0) {
    pitNote = `, boxutca + ${pitBoxPoints.length} boxhely kész`;
  } else if (pitLanePoints.length >= 2) {
    pitNote = ', boxutca kész (⚠️ nincs boxhely kijelölve)';
  }
  statusEl.textContent = `Kész! ${points.length} kontrollpont, érvényes zárt pálya${decorNote}${pitNote}.`;
  statusEl.classList.add('closed');
  saveBtn.disabled = false;
}

// --- Renderelés ---

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Halvány referencia-rács — CSAK vizuális tájékozódás, nincs hozzá igazítás.
  ctx.strokeStyle = '#22252e';
  ctx.lineWidth = 1;
  const stepPx = 20 * pxPerMeter; // 20 méterenként
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
      const halfPx = (p.width / 2) * pxPerMeter;
      const s = worldToScreen(p);
      const lx = s.x - Math.sin(p.dir) * halfPx;
      const ly = s.y + Math.cos(p.dir) * halfPx;
      if (i === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
    });
    for (let i = sampled.length - 1; i >= 0; i--) {
      const p = sampled[i];
      const halfPx = (p.width / 2) * pxPerMeter;
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
      if (dist * pxPerMeter < CURVE_HIT_RADIUS_PX) {
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
    if (fp) drawFootprintRect(d, scaledFootprint(d, fp), DECORATION_TYPES[d.type].snap ? 'rgba(111,179,122,0.9)' : 'rgba(122,127,140,0.7)');

    const s = worldToScreen(d);
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DECORATION_TYPES[d.type].icon, s.x, s.y);
    drawFacingArrow(d, '#f2c14e');
  }

  // Boxutca-útvonal: NYITOTT, egyenes szakaszos vonal (nincs Catmull-Rom
  // simítás, mint a fő pályánál — lásd a pitLanePoints deklarációját), arany
  // színnel, a tényleges szélességét (RACE.pitStop.laneWidth) áttetsző sávval
  // jelezve, hogy a szerkesztőben is lásd, mekkora terület lesz burkolat.
  if (pitLanePoints.length >= 1) {
    if (pitLanePoints.length >= 2) {
      const halfPx = (RACE.pitStop.laneWidth / 2) * pxPerMeter;
      ctx.beginPath();
      for (let i = 0; i < pitLanePoints.length - 1; i++) {
        const a = pitLanePoints[i];
        const b = pitLanePoints[i + 1];
        const dir = Math.atan2(b.z - a.z, b.x - a.x);
        const sa = worldToScreen(a);
        const sb = worldToScreen(b);
        const ox = -Math.sin(dir) * halfPx;
        const oy = Math.cos(dir) * halfPx;
        ctx.moveTo(sa.x - ox, sa.y - oy);
        ctx.lineTo(sb.x - ox, sb.y - oy);
        ctx.lineTo(sb.x + ox, sb.y + oy);
        ctx.lineTo(sa.x + ox, sa.y + oy);
        ctx.closePath();
      }
      ctx.fillStyle = 'rgba(212,169,78,0.28)';
      ctx.fill();
    }
    ctx.strokeStyle = '#d4a94e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pitLanePoints.forEach((p, i) => {
      const s = worldToScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    pitLanePoints.forEach((p) => {
      const s = worldToScreen(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#d4a94e';
      ctx.fill();
      ctx.strokeStyle = '#12141a';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  // Boxutca-mód hover-előnézet: a KÖVETKEZŐ pont pozíciója (a főúthoz illesztve,
  // ha elég közel van, lásd snapToTrackCenterline) — halvány jelölő, mielőtt
  // ténylegesen kattintanál.
  if (hover && mode === 'pitlane' && dragIndex === null) {
    const snapped = snapToTrackCenterline(hover.worldPt);
    const s = worldToScreen(snapped);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#f2c14e';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Egy boxhely "rács" jelölése — valódi versenypályához hasonló, festett
  // doboz (külső keret + 2 harmadoló vonal), a lane helyi irányához igazítva.
  function drawBoxGrid(pos, label) {
    const dir = laneDirectionNear(pos);
    // toScreen(lx, lz): lx = HALADÁSI irányban (hosszában), lz = arra
    // MERŐLEGESEN (jobb oldal felé) — ezért a hosszú oldal a boxDepth, a
    // keskeny (lane-en belüli) oldal a boxWidth (VILÁG-méterben).
    const hw = RACE.pitStop.boxDepth / 2; // hosszában
    const hd = RACE.pitStop.boxWidth / 2; // keresztben
    const s = worldToScreen(pos);
    // worldToScreen egyenes (nem tükrözött) skálázás — screenX=worldX,
    // screenY=worldZ —, ezért a világ-térbeli forgatás UGYANÚGY, tükrözés
    // nélkül vetül a vászonra.
    const cos = Math.cos(dir);
    const sin = Math.sin(dir);
    const toScreen = (lx, lz) => ({ x: s.x + (lx * cos - lz * sin) * pxPerMeter, y: s.y + (lx * sin + lz * cos) * pxPerMeter });
    // Egyszerű téglalap — csak a külső keret (nincs belső osztóvonal).
    const local = [
      [[-hw, -hd], [hw, -hd]], [[hw, -hd], [hw, hd]], [[hw, hd], [-hw, hd]], [[-hw, hd], [-hw, -hd]],
    ];
    ctx.strokeStyle = '#e05a5a';
    ctx.lineWidth = 2;
    for (const [p1, p2] of local) {
      const a = toScreen(p1[0], p1[1]);
      const b = toScreen(p2[0], p2[1]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (label) {
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e05a5a';
      ctx.fillText(label, s.x, s.y);
    }
  }

  // A kijelölt BOXHELYEK — mindegyik egy egyszerű téglalap, sorszámmal (hogy
  // multiplayerben lásd, melyik játékosnak melyik jut, lásd sim/race.js
  // pitBoxForSlot: az 1. jelölt hely a slotIndex=0 játékosé, stb.).
  pitBoxPoints.forEach((p, i) => drawBoxGrid(p, String(i + 1)));

  // Boxhely-mód hover-előnézet: a legközelebbi pont a MEGRAJZOLT boxutcán.
  if (hover && mode === 'pitbox' && pitBoxPoints.length < RACE.pitStop.maxBoxes) {
    const snapped = snapToPitLane(hover.worldPt);
    if (snapped) {
      ctx.globalAlpha = 0.6;
      drawBoxGrid(offsetToRightSide(snapped, snapped.dir), null);
      ctx.globalAlpha = 1;
    }
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
        drawFootprintRect(existing, scaledFootprint(existing, fp), '#e05a5a');
      } else {
        const s = worldToScreen(existing);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
        ctx.strokeStyle = '#e05a5a';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (activeDecorType) {
      // "Üres kéz" (ESC — activeDecorType===null) esetén nincs mit
      // előnézetezni, a hover ilyenkor egyszerűen nem rajzol semmit. A
      // "kézben" lévő elem méret-szorzóját (activeScale — görgővel
      // állítható, lásd a wheel-kezelőt) is a footprint-en át jelenítjük meg,
      // hogy a lerakás ELŐTT lásd a tényleges méretet.
      const snap = computeSnap(hover.worldPt, activeDecorType, activeRot, activeScale);
      const preview = snap
        ? { x: snap.x, z: snap.z, rot: snap.rot }
        : { x: hover.worldPt.x, z: hover.worldPt.z, rot: activeRot };
      const fp = footprints[activeDecorType];
      const dfp = fp ? { width: fp.width * activeScale, depth: fp.depth * activeScale } : fp;
      if (dfp) drawFootprintRect(preview, dfp, snap ? '#f2c14e' : 'rgba(217,154,63,0.6)');

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
  const angle = (d.rot || 0) - Math.PI / 2;
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
function loadLayoutIntoEditor(savedLayout, savedDecorations, savedPitLane) {
  points.length = 0;
  decorations.length = 0;
  pitLanePoints.length = 0;
  pitBoxPoints.length = 0;
  closed = false;
  // A boxhely-jelölők (isBox:true) KÜLÖN kerülnek ki a tömbből — lásd
  // pitBoxPoints/pitLaneForSave megjegyzését.
  for (const p of savedPitLane || []) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.z)) continue;
    if (p.isBox) pitBoxPoints.push({ x: p.x, z: p.z });
    else pitLanePoints.push({ x: p.x, z: p.z });
  }
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
    decorations.push({
      x: d.dgx * TRACK.tile,
      z: d.dgy * TRACK.tile,
      type: d.type,
      rot: normalizeRotToRadians(d.rot), // régi (0–3 negyedfordulat) mentések migrálása radiánná
      scale: Number.isFinite(d.scale) && d.scale > 0 ? d.scale : 1, // régi mentés = nincs scale mező → 1
    });
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
        pushUndo();
        loadLayoutIntoEditor(entry.layout, entry.decorations, entry.pitLane);
        trackNameInput.value = entry.name;
        setActiveTrack(entry.name, entry.layout, entry.decorations, entry.pitLane);
        render();
        updateStatus();
        renderSavedTracksList();
        refresh3DIfVisible();
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
  const relPitLane = pitLaneForSave();
  saveAsBtn.disabled = true;
  try {
    await apiSaveTrack({ name, layout, decorations: relDecorations, pitLane: relPitLane });
    setActiveTrack(name, layout, relDecorations, relPitLane);
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
loadLayoutIntoEditor(loadCustomLayout(), loadCustomDecorations(), loadPitLane());
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
    pitLanePoints,
    footprints,
    get closed() { return closed; },
    get mode() { return mode; },
    pitBoxPoints,
    validate: () => validateSplineTrack(points),
    computeSnap,
    setActiveDecorType: (t) => { activeDecorType = t; },
    setMode,
    get view() { return view; },
    setView,
    get editor3d() { return editor3d; },
    get cameraController() { return cameraController; },
    get pointMarkers() { return pointMarkers; },
    get undoStackLength() { return undoStack.length; },
    applyUndo,
    pushUndo,
  };
}
