// =============================================================================
//  PÁLYA-SZERKESZTŐ — rács-alapú útvonal-rajzoló + dekoráció-elhelyező.
//
//  Két mód van ugyanazon a rácson:
//   - "track": a felhasználó cellánként kattintva kijelöli a pálya középvonalát
//     (mint egy kígyó-játékban). Ebből automatikusan levezetjük, hol legyen
//     egyenes és hol kanyar, majd a sim/trackbuilder.js formátumában elmentjük.
//   - "decor": a felhasználó egy kiválasztott Kenney-elemet (fal, fa, épület...)
//     helyez le tetszőleges cellákra, forgatva. A dekorációk a PÁLYA RAJT-
//     CELLÁJÁHOZ KÉPEST relatív rács-eltolásként mentődnek (dgx,dgy), hogy a
//     játék egyszerűen világ-koordinátává tudja számolni: world = d*TRACK.tile.
//
//  A "nincs cella-ismétlés" szabály miatt a kész útvonal MINDIG egyszerű
//  (nem metsző önmagát) zárt sokszög — ezt nem kell külön ellenőrizni.
// =============================================================================
import {
  saveCustomTrack,
  clearCustomLayout,
  loadCustomLayout,
  loadCustomDecorations,
  listSavedTracks,
  saveNamedTrack,
  loadNamedTrack,
  deleteSavedTrack,
  getActiveTrackName,
} from './trackStorage.js';
import { DECORATION_TYPES } from './config.js';

const GRID_COLS = 20;
const GRID_ROWS = 14;
const CELL = 40; // px

const canvas = document.getElementById('editorCanvas');
canvas.width = GRID_COLS * CELL;
canvas.height = GRID_ROWS * CELL;
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

// A pálya-útvonal: cellák sorozata {x, y} rács-koordinátában. path[0] = rajt.
const path = [];
let closed = false;
let hover = null; // az egér alatti cella

// Dekorációk: {gx, gy, type, rot} — ABSZOLÚT rács-koordinátában (mentéskor
// váltjuk a rajt-cellához képesti relatívra).
const decorations = [];
const decorTypeKeys = Object.keys(DECORATION_TYPES);
let activeDecorType = decorTypeKeys[0];
let activeRot = 0;

let mode = 'track'; // 'track' | 'decor'

function cellsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
}

function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function inPath(cell) {
  return path.some((p) => cellsEqual(p, cell));
}

// Érvényes-e a `cell` mint a következő kattintás célja (track mód).
function isValidNext(cell) {
  if (path.length === 0) return true;
  const last = path[path.length - 1];
  if (!isAdjacent(last, cell)) return false;
  if (path.length >= 4 && cellsEqual(cell, path[0])) return true; // zárás
  return !inPath(cell); // nem ismételhető cella
}

// Egy cellában EGY talaj- (pl. fű) ÉS EGY objektum-elem (fal, fa, épület...)
// lehet EGYSZERRE, egymástól függetlenül — ezért réteg szerint kell keresni.
function decorationAt(cell, layer) {
  return decorations.find(
    (d) => d.gx === cell.x && d.gy === cell.y && DECORATION_TYPES[d.type].layer === layer
  );
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
    ? 'Kattints egy cellára a kezdéshez, majd a szomszédos cellákra, hogy megrajzold a pálya útvonalát. Ha eleget haladtál, kattints vissza az arany rajt-cellára a hurok zárásához. Zárt pálya esetén a kanyar-cellákra kattintva ciklikusan válthatod a kanyar sugarát (sima → nagy → extra nagy → sima...) — a méretet egy szám jelzi a cellán.'
    : 'Válaszd ki az elemet lent, majd kattints egy cellára a lerakáshoz. Meglévő elemre kattintva eltávolítod. A "Forgatás" gomb az elem irányát állítja lerakás előtt — a fénykaput (útra helyezve) az útiránnyal egybe kell forgatni. A terelőkúp SZABADON, rácstól függetlenül pontosan a kattintott helyre kerül — a közelébe kattintva törölhető.';
  hover = null;
  render();
  updateStatus();
}

modeTrackBtn.addEventListener('click', () => setMode('track'));
modeDecorBtn.addEventListener('click', () => setMode('decor'));

// Dekoráció-paletta felépítése a config.js DECORATION_TYPES alapján, réteg
// szerint csoportosítva. Jelenleg csak 'object' réteg van használatban (a
// 'ground' — a fű-folt — megszűnt, mióta a teljes pálya alapból fű, lásd
// render3d/grassField.js) — a réteg-rendszer maga megmaradt, ha a jövőben
// kellene újra talaj-típusú elem, de üres réteghez nem jelenít meg fejlécet.
const layerLabels = { ground: 'Talaj (a cella alapja)', object: 'Objektum (a talajra kerül)' };
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
    const def = DECORATION_TYPES[key];
    const btn = document.createElement('button');
    btn.textContent = `${def.icon} ${def.label}`;
    btn.dataset.type = key;
    if (key === activeDecorType) btn.classList.add('active');
    btn.addEventListener('click', () => {
      activeDecorType = key;
      for (const b of decorPaletteEl.querySelectorAll('button')) b.classList.remove('active');
      btn.classList.add('active');
    });
    group.appendChild(btn);
  }
  decorPaletteEl.appendChild(group);
}

rotateBtn.addEventListener('click', () => {
  activeRot = (activeRot + 1) % 4;
  render();
});

// --- Layout levezetése az útvonalból ---

function computeSteps() {
  const n = path.length;
  const steps = [];
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    steps.push({ dx: b.x - a.x, dy: b.y - a.y });
  }
  return steps;
}

// Minden csempéhez (path[k]) megállapítja: egyenes, vagy kanyar (+irány).
// A bejövő irány a k-1-edik lépés, a kimenő a k-adik (körkörösen).
function computeTileTypes() {
  const steps = computeSteps();
  const n = steps.length;
  const types = [];
  for (let k = 0; k < n; k++) {
    const din = steps[(k - 1 + n) % n];
    const dout = steps[k];
    if (din.dx === dout.dx && din.dy === dout.dy) {
      types.push({ type: 'straight' });
    } else {
      const cross = din.dx * dout.dy - din.dy * dout.dx; // ±1 (90°-os lépés)
      types.push({ type: 'corner', turn: cross > 0 ? 1 : -1 });
    }
  }
  return types;
}

// Hány egymást követő 'straight' cella van közvetlenül `idx` előtt/után (a `dir`
// irányban lépkedve, körkörösen), és melyik kanyar-cellánál ér véget ez a futás
// (ha egyáltalán kanyarnál — pl. egy teljesen kör alakú, csupa-kanyaros pálya
// esetén elméletileg az egész úton nincs straight, ekkor length=0 minden határon).
function straightRunInfo(idx, types, dir) {
  const n = types.length;
  let count = 0;
  let i = (idx + dir + n) % n;
  while (types[i].type === 'straight' && count < n) {
    count++;
    i = (i + dir + n) % n;
  }
  return { length: count, otherCornerIdx: types[i].type === 'corner' ? i : null };
}

// Egy kanyar-cella LEGNAGYOBB megengedhető mérete (1/2/3) — a nagyobb sugarú
// kanyar (size-1) csempényit "belenyúlik" MINDKÉT szomszédos egyenesbe (lásd
// sim/trackbuilder.js applyCornerSizeCompensation), ezért csak akkora méret
// engedhető meg, amennyit a szomszédos egyenesek (mínusz amit a TÚLOLDALI
// kanyaruk esetleg már lefoglalt belőle) még elbírnak — különben a pálya nem
// zárna vissza pontosan a kiinduló pontra.
function maxFeasibleCornerSize(idx) {
  const types = computeTileTypes();
  if (types[idx].type !== 'corner') return 1;
  const before = straightRunInfo(idx, types, -1);
  const after = straightRunInfo(idx, types, 1);
  const otherBefore = before.otherCornerIdx != null ? path[before.otherCornerIdx].cornerSize || 1 : 1;
  const otherAfter = after.otherCornerIdx != null ? path[after.otherCornerIdx].cornerSize || 1 : 1;
  const availBefore = before.length - (otherBefore - 1);
  const availAfter = after.length - (otherAfter - 1);
  // size <= availBefore/availAfter kell (NEM +1) — a kanyar mérete (size-1)
  // csempét von el, a szomszédos egyenesnek pedig legalább 1 csempének kell
  // maradnia utána: run.length - (size-1) >= 1  <=>  size <= run.length.
  return Math.max(1, Math.min(3, availBefore, availAfter));
}

// Egyenes-futásokat összevonja {type:'straight', n} formába (lásd config.js RECT).
function computeLayout() {
  if (!closed || path.length < 4) return null;
  const types = computeTileTypes();
  const layout = [];
  let i = 0;
  while (i < types.length) {
    if (types[i].type === 'straight') {
      let n = 0;
      while (i < types.length && types[i].type === 'straight') {
        n++;
        i++;
      }
      layout.push({ type: 'straight', n });
    } else {
      // A kanyar mérete (1=sima, 2=Large, 3=Larger) a path-cellán tárolva —
      // lásd a canvas click-kezelőt (zárt pályán a kanyar-cellára kattintva váltható).
      layout.push({ type: 'corner', turn: types[i].turn, size: path[i].cornerSize || 1 });
      i++;
    }
  }
  return layout;
}

// A computeLayout() INVERZE: egy mentett layout-ból visszaépíti a cella-sorozatot,
// hogy a szerkesztő megnyitásakor a jelenlegi pálya legyen betöltve (ne kelljen
// mindig előről kezdeni). A kezdő irány tetszőleges (mindig kelet, dx=1,dy=0) —
// ez csak az EGÉSZ alakzat elforgatását/eltolását befolyásolja, a layout maga
// (és így a dekorációk path[0]-hoz képesti relatív pozíciója is) INVARIÁNS erre,
// mert a computeTileTypes() a lépések EGYMÁSHOZ KÉPESTI irányából, nem abszolút
// tájolásból számol. (Ellenőrizve: layoutToPath(L) → computeLayout() === L.)
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
      // FONTOS: computeTileTypes() a kanyar-cellát a FORDULÁS ELŐTTI utolsó
      // cellaként azonosítja (ahol a bejövő és kimenő lépésirány eltér) — ez a
      // cells tömb JELENLEGI utolsó eleme, NEM az itt lentebb frissen felvett
      // (fordulás UTÁNI) cella. A cornerSize-t ezért a MEGLÉVŐ utolsó cellára
      // kell írni, mielőtt továbblépünk — különben mentés/betöltés után a méret
      // egy szomszédos (rossz) cellára "csúszna át".
      const turn = seg.turn;
      if (seg.size && seg.size !== 1) cells[cells.length - 1].cornerSize = seg.size;
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

// --- Interakció ---

function pixelToCell(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((clientX - rect.left) / rect.width) * GRID_COLS);
  const y = Math.floor(((clientY - rect.top) / rect.height) * GRID_ROWS);
  return { x, y };
}

// Rács-igazítás NÉLKÜLI, folytonos pozíció ("free" dekorációkhoz) — a kattintás
// PONTOS helyét adja vissza rács-egységben (pl. x=6.35 = a 6. cella 35%-ánál).
function pixelToPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * GRID_COLS;
  const y = ((clientY - rect.top) / rect.height) * GRID_ROWS;
  return { x, y };
}

// FONTOS: a kirajzolt cella-négyzet (p.x*CELL .. (p.x+1)*CELL) NEM ugyanott van,
// mint a valódi útburkolat! A pálya középvonala a rács-EGÉSZ értékeken fut (ott
// van a track.center), az út pedig ROAD_HALF (=fél csempe) távolságra terjed ki
// MINDKÉT irányban a középvonaltól — vagyis a burkolat a p.x-0.5..p.x+0.5 sávban
// van, NEM a p.x..p.x+1 sávban, amit a kirajzolt kék négyzet mutat! Emiatt a kék
// cella "második fele" valójában már a füvön van. A "free" elemeknél ezért a
// nyers kattintás-pozíciót (pixelToPoint) -0.5-tel el kell tolni MENTÉS előtt,
// hogy a kattintott pont a burkolathoz (nem a kék négyzethez) legyen igazítva —
// a megjelenítéskor (render) ugyanezt +0.5-tel visszatoljuk, hogy a jelölő
// PONTOSAN ott jelenjen meg, ahova kattintottunk (WYSIWYG).
function freeClickToGrid(pt) {
  return { gx: pt.x - 0.5, gy: pt.y - 0.5 };
}
function freeGridToPx(d) {
  return { px: (d.gx + 0.5) * CELL, py: (d.gy + 0.5) * CELL };
}

function isFreeType(type) {
  return !!DECORATION_TYPES[type]?.free;
}

canvas.addEventListener('mousemove', (e) => {
  if (mode === 'track') {
    const cell = pixelToCell(e.clientX, e.clientY);
    hover = isValidNext(cell) ? cell : null;
  } else {
    // Dekoráció-módban bárhova lehet; "free" elemnél folytonos pozíció (nincs
    // rács-igazítás), különben a szokásos cella.
    hover = isFreeType(activeDecorType)
      ? pixelToPoint(e.clientX, e.clientY)
      : pixelToCell(e.clientX, e.clientY);
  }
  render();
});

canvas.addEventListener('mouseleave', () => {
  hover = null;
  render();
});

// "Free" elemnél a törléshez nem cella-egyezés kell, hanem a legközelebbi
// azonos típusú elem a kattintás egy kis sugarú környezetében.
const FREE_REMOVE_RADIUS = 0.35; // rács-egységben

canvas.addEventListener('click', (e) => {
  if (mode === 'decor') {
    if (isFreeType(activeDecorType)) {
      // Rács-igazítás NÉLKÜL, pontosan a kattintott helyre kerül — nem függ
      // attól, melyik cellába esik, és egy cellán belül is bárhová tehető.
      // (freeClickToGrid: lásd fent, a kék cella-négyzet és a valódi burkolat
      // fél-cellás eltérése miatt szükséges korrekció.)
      const g = freeClickToGrid(pixelToPoint(e.clientX, e.clientY));
      const existing = decorations.find(
        (d) => d.type === activeDecorType && Math.hypot(d.gx - g.gx, d.gy - g.gy) < FREE_REMOVE_RADIUS
      );
      if (existing) {
        decorations.splice(decorations.indexOf(existing), 1);
      } else {
        decorations.push({ gx: g.gx, gy: g.gy, type: activeDecorType, rot: activeRot });
      }
      render();
      updateStatus();
      return;
    }

    const cell = pixelToCell(e.clientX, e.clientY);
    // A kijelölt elem RÉTEGÉBEN (talaj vagy objektum) nézzük, van-e már valami
    // ebben a cellában — a másik réteg (pl. az odarakott fű) érintetlen marad.
    const layer = DECORATION_TYPES[activeDecorType].layer;
    const existing = decorationAt(cell, layer);
    if (existing) {
      decorations.splice(decorations.indexOf(existing), 1);
    } else {
      decorations.push({ gx: cell.x, gy: cell.y, type: activeDecorType, rot: activeRot });
    }
    render();
    updateStatus();
    return;
  }

  const cell = pixelToCell(e.clientX, e.clientY);

  if (closed) {
    // Zárt pályán a kanyar-cellákra kattintva ciklikusan váltható a kanyar
    // sugara: 1 (sima) → 2 (Large) → 3 (Larger) → 1... (lásd render3d/scene.js).
    // A ciklus CSAK a szomszédos egyenesek hossza által megengedett méretig megy
    // (maxFeasibleCornerSize) — enélkül a nagyobb kanyar "belenyúlna" a szomszédos
    // egyenesekbe és a pálya nem zárna vissza pontosan a kiinduló pontra.
    const idx = path.findIndex((p) => cellsEqual(p, cell));
    if (idx === -1) return;
    if (computeTileTypes()[idx].type !== 'corner') return;
    const maxSize = maxFeasibleCornerSize(idx);
    const cur = path[idx].cornerSize || 1;
    path[idx].cornerSize = cur >= maxSize ? 1 : cur + 1;
    if (maxSize === 1) {
      statusEl.textContent = 'Ehhez a kanyarhoz a szomszédos egyenesek túl rövidek a nagyobb sugárhoz — hosszabbítsd meg őket, vagy válassz másik kanyart.';
    } else {
      updateStatus();
    }
    render();
    return;
  }
  if (!isValidNext(cell)) return;

  if (path.length >= 4 && cellsEqual(cell, path[0])) {
    closed = true;
  } else {
    path.push(cell);
  }
  hover = null;
  render();
  updateStatus();
});

undoBtn.addEventListener('click', () => {
  if (mode === 'decor') {
    decorations.pop();
  } else if (closed) {
    closed = false;
  } else {
    path.pop();
  }
  render();
  updateStatus();
});

clearBtn.addEventListener('click', () => {
  path.length = 0;
  closed = false;
  decorations.length = 0;
  render();
  updateStatus();
});

saveBtn.addEventListener('click', () => {
  const layout = computeLayout();
  if (!layout) return;
  // A dekorációkat a rajt-cellához (path[0]) képesti relatív rács-eltolásként mentjük.
  const relDecorations = decorations.map((d) => ({
    type: d.type,
    dgx: d.gx - path[0].x,
    dgy: d.gy - path[0].y,
    rot: d.rot,
  }));
  // Ha van megadott név, névvel is elmentjük (bekerül/frissül a listában),
  // különben csak az aktív (névtelen) slotba — mindkét esetben ez indul a játékban.
  const name = trackNameInput.value.trim();
  if (name) {
    saveNamedTrack(name, layout, relDecorations);
  } else {
    saveCustomTrack(layout, relDecorations);
  }
  window.location.href = '/index.html';
});

resetDefaultBtn.addEventListener('click', () => {
  clearCustomLayout();
  path.length = 0;
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
  if (path.length === 0) {
    statusEl.textContent = 'Kattints egy cellára a kezdéshez.';
  } else if (!closed) {
    const hint = path.length >= 4 ? ' Vagy zárd a hurkot a rajt-cellára kattintva.' : '';
    statusEl.textContent = `${path.length} cella kijelölve.${hint}`;
  } else {
    const layout = computeLayout();
    const straights = layout.filter((s) => s.type === 'straight').length;
    const corners = layout.filter((s) => s.type === 'corner').length;
    const decorNote = decorations.length ? `, ${decorations.length} dekoráció` : '';
    statusEl.textContent = `Kész! ${path.length} cella, zárt hurok (${straights} egyenes szakasz, ${corners} kanyar${decorNote}).`;
    statusEl.classList.add('closed');
    saveBtn.disabled = false;
  }
}

// --- Renderelés ---

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Rácsvonalak.
  ctx.strokeStyle = '#33363f';
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= GRID_ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL);
    ctx.lineTo(canvas.width, y * CELL);
    ctx.stroke();
  }

  // Kijelölt útvonal-cellák. Az első KÉT cella a rajt/cél-KAPU helye (a Kenney
  // roadStart.glb modell 2 csempényi hosszú — lásd render3d/scene.js), ezért
  // mindkettő a rajt-színnel jelölve, nem csak path[0].
  path.forEach((p, i) => {
    let color = '#5c8fd6';
    if (i === 0 || i === 1) color = '#f2c14e';
    ctx.fillStyle = color;
    ctx.fillRect(p.x * CELL + 3, p.y * CELL + 3, CELL - 6, CELL - 6);
  });

  // Kanyar-méret jelvény: zárt pályán, ha egy kanyar-cella mérete >1 (Large/Larger),
  // egy kis szám mutatja rajta (1-nél nincs jelvény, az az alapértelmezett sima kanyar).
  // A nagyobb kanyar (size-1) csempényit "belenyúlik" mindkét szomszédos egyenesbe
  // (lásd sim/trackbuilder.js applyCornerSizeCompensation) — ezeket a "bekebelezett"
  // cellákat sraffozott mintával jelöljük, hogy a felhasználó lássa a valódi
  // helyfoglalást (ne csak 1 cellának tűnjön a nagy kanyar).
  if (closed && path.length >= 4) {
    const types = computeTileTypes();
    const n = path.length;
    path.forEach((p, i) => {
      if (types[i].type !== 'corner') return;
      const size = p.cornerSize || 1;
      if (size <= 1) return;

      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(String(size), p.x * CELL + CELL / 2, p.y * CELL + CELL / 2);

      const extra = size - 1;
      for (const dir of [-1, 1]) {
        for (let s = 1; s <= extra; s++) {
          const j = (i + dir * s + n) % n;
          if (types[j].type !== 'straight') break; // kanyarba ütköztünk, nincs több hely
          const cp = path[j];
          ctx.fillStyle = 'rgba(217,154,63,0.4)';
          ctx.fillRect(cp.x * CELL + 6, cp.y * CELL + 6, CELL - 12, CELL - 12);
        }
      }
    });
  }

  // Rajt/cél-kapu jelölő ikon a két rajt-cella közös élén.
  if (path.length >= 2) {
    const a = path[0];
    const b = path[1];
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1a1a1a';
    ctx.fillText('🏁', (a.x + b.x + 1) * CELL / 2, (a.y + b.y + 1) * CELL / 2);
  }

  // Kapcsoló élek (nyilak) a cellák között.
  ctx.strokeStyle = '#e8eaef';
  ctx.lineWidth = 2;
  const n = path.length;
  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    drawArrow(a, b);
  }

  // Hover-jelölés az érvényes következő cellára / dekoráció-célra.
  if (hover) {
    if (mode === 'track' && !closed) {
      const isClose = path.length >= 4 && cellsEqual(hover, path[0]);
      ctx.fillStyle = isClose ? 'rgba(242,193,78,0.5)' : 'rgba(58,90,58,0.7)';
      ctx.fillRect(hover.x * CELL + 3, hover.y * CELL + 3, CELL - 6, CELL - 6);
    } else if (mode === 'decor' && isFreeType(activeDecorType)) {
      // "Free" elem: nincs cella-fillRect, csak egy kis kör a pontos helyen.
      ctx.beginPath();
      ctx.arc(hover.x * CELL, hover.y * CELL, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(217,154,63,0.5)';
      ctx.fill();
    } else if (mode === 'decor') {
      ctx.fillStyle = 'rgba(217,154,63,0.35)';
      ctx.fillRect(hover.x * CELL + 3, hover.y * CELL + 3, CELL - 6, CELL - 6);
    }
  }

  // Dekorációk: előbb a TALAJ-réteg (halvány zöld cella-alap), utána az
  // OBJEKTUM-réteg (ikon + forgás-jelző) — így mindkét réteg látszik egy cellán.
  for (const d of decorations) {
    if (DECORATION_TYPES[d.type].layer !== 'ground') continue;
    ctx.fillStyle = 'rgba(90,160,90,0.55)';
    ctx.fillRect(d.gx * CELL + 2, d.gy * CELL + 2, CELL - 4, CELL - 4);
  }
  for (const d of decorations) {
    if (DECORATION_TYPES[d.type].layer !== 'object') continue;
    // "Free" elemnél d.gx/d.gy a burkolathoz igazított (fél cellával eltolt)
    // tárolt érték — a megjelenítéshez freeGridToPx-szel visszaalakítjuk arra a
    // pixelre, ahova a felhasználó ténylegesen kattintott (WYSIWYG).
    const free = DECORATION_TYPES[d.type].free;
    const freePx = free ? freeGridToPx(d) : null;
    const cx = free ? freePx.px : d.gx * CELL + CELL / 2;
    const cy = free ? freePx.py : d.gy * CELL + CELL / 2;
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DECORATION_TYPES[d.type].icon, cx, cy);
    // Forgás-jelző: rövid vonal a cella szélétől a rot szerinti irányba.
    const angle = (d.rot * Math.PI) / 2 - Math.PI / 2;
    ctx.strokeStyle = '#d99a3f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * (CELL / 2 - 4), cy + Math.sin(angle) * (CELL / 2 - 4));
    ctx.stroke();
  }
}

function drawArrow(a, b) {
  const ax = a.x * CELL + CELL / 2;
  const ay = a.y * CELL + CELL / 2;
  const bx = b.x * CELL + CELL / 2;
  const by = b.y * CELL + CELL / 2;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  const angle = Math.atan2(by - ay, bx - ax);
  const headLen = 7;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - headLen * Math.cos(angle - Math.PI / 6), by - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(bx - headLen * Math.cos(angle + Math.PI / 6), by - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = '#e8eaef';
  ctx.fill();
}

// Egy {layout, decorations} pályaadatot tölt be SZERKESZTÉSRE — kiüríti a
// jelenlegi path/decorations állapotot, majd a layoutToPath inverzzel
// visszaépíti a cella-sorozatot, és a mentett (path[0]-hoz relatív) dekorációkat
// is elhelyezi. Ugyanezt a logikát használja az induláskori "utoljára aktív
// pálya" betöltés ÉS a mentett pályák listájának "Betöltés" gombja is.
function loadLayoutIntoEditor(savedLayout, savedDecorations) {
  path.length = 0;
  decorations.length = 0;
  closed = false;
  if (!savedLayout) return;

  const restored = layoutToPath(savedLayout);

  // A rács-igazítás: a legkisebb x/y (a pálya VAGY a dekorációk közül) kapjon
  // egy kis margót, hogy semmi ne essen a látható rácson kívülre (negatívba).
  const rawStartX = restored[0].x;
  const rawStartY = restored[0].y;
  const minX = Math.min(...restored.map((c) => c.x), ...savedDecorations.map((d) => rawStartX + d.dgx));
  const minY = Math.min(...restored.map((c) => c.y), ...savedDecorations.map((d) => rawStartY + d.dgy));
  const offX = 2 - minX;
  const offY = 2 - minY;

  for (const c of restored) {
    c.x += offX;
    c.y += offY;
  }
  path.push(...restored);
  closed = true;

  for (const d of savedDecorations) {
    // Egy korábban mentett, azóta megszűnt típusú elemet (pl. a törölt "grass"
    // fű-folt) kihagyunk — enélkül a DECORATION_TYPES[d.type] undefined lenne,
    // és a render/kattintás-kezelő elszállna rajta.
    if (!DECORATION_TYPES[d.type]) continue;
    decorations.push({ gx: path[0].x + d.dgx, gy: path[0].y + d.dgy, type: d.type, rot: d.rot });
  }
}

// --- Mentett pályák listája (mentés névvel, betöltés, törlés) ---

function renderSavedTracksList() {
  savedTracksListEl.innerHTML = '';
  const names = listSavedTracks();
  const activeName = getActiveTrackName();
  if (names.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Még nincs névvel mentett pálya.';
    savedTracksListEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'savedTrackRow';

    const label = document.createElement('span');
    label.className = 'savedTrackName';
    label.textContent = (name === activeName ? '▶ ' : '') + name;
    row.appendChild(label);

    const loadBtn = document.createElement('button');
    loadBtn.textContent = '📂';
    loadBtn.title = 'Betöltés szerkesztésre';
    loadBtn.addEventListener('click', () => {
      const entry = loadNamedTrack(name);
      if (!entry) return;
      loadLayoutIntoEditor(entry.layout, entry.decorations);
      trackNameInput.value = name;
      render();
      updateStatus();
      renderSavedTracksList();
      statusEl.textContent = `📂 "${name}" betöltve szerkesztésre.`;
      statusEl.classList.add('closed');
    });
    row.appendChild(loadBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑️';
    delBtn.className = 'danger';
    delBtn.title = 'Törlés';
    delBtn.addEventListener('click', () => {
      if (!confirm(`Biztosan törlöd a(z) "${name}" pályát? Ez nem vonható vissza.`)) return;
      deleteSavedTrack(name);
      renderSavedTracksList();
    });
    row.appendChild(delBtn);

    savedTracksListEl.appendChild(row);
  }
}

saveAsBtn.addEventListener('click', () => {
  const name = trackNameInput.value.trim();
  if (!name) {
    statusEl.textContent = 'Adj nevet a pályának a mentéshez!';
    statusEl.classList.remove('closed');
    return;
  }
  const layout = computeLayout();
  if (!layout) {
    statusEl.textContent = 'A pálya még nincs lezárva — előbb zárd a hurkot.';
    statusEl.classList.remove('closed');
    return;
  }
  const relDecorations = decorations.map((d) => ({
    type: d.type,
    dgx: d.gx - path[0].x,
    dgy: d.gy - path[0].y,
    rot: d.rot,
  }));
  saveNamedTrack(name, layout, relDecorations);
  renderSavedTracksList();
  statusEl.textContent = `✅ "${name}" néven elmentve.`;
  statusEl.classList.add('closed');
});

// Induláskor: az utoljára aktív pálya betöltése szerkesztésre (ne kelljen
// mindig előről kezdeni), és a mentett pályák listájának felépítése.
loadLayoutIntoEditor(loadCustomLayout(), loadCustomDecorations());
const activeNameOnLoad = getActiveTrackName();
if (activeNameOnLoad) trackNameInput.value = activeNameOnLoad;
renderSavedTracksList();

render();
updateStatus();

// Fejlesztői debug-hozzáférés a böngésző-konzolból.
if (import.meta.env.DEV) {
  window.__EDITOR = {
    path,
    decorations,
    get closed() { return closed; },
    get mode() { return mode; },
    computeLayout,
    CELL,
    GRID_COLS,
    GRID_ROWS,
  };
}
