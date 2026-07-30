// =============================================================================
//  BELÉPÉSI PONT — közös 3D jelenet + mód-választó főmenü.
//
//  Két játékmód, ugyanarra a jelenetre építve:
//   - EGYJÁTÉKOS: minden lokális (fizika + verseny-logika a böngészőben) —
//     ez a korábbi 1-2. fázis változatlan viselkedése.
//   - MULTIPLAYER (3. fázis): a Colyseus szerver futtatja a fizikát/versenyt,
//     mi inputot küldünk és a snapshot-okból renderelünk minden autót.
// =============================================================================
import { SIM, ASSETS, RACE, NET } from './config.js';
import { createWorld, createStepper } from './sim/world.js';
import { spawn, checkpoints, offRoadExcess, trackHeadingAt, trackState } from './sim/track.js';
import {
  createCarBody,
  updateCar,
  coastToStop,
  resetCar,
  speedKmh,
  forwardSpeed,
  lateralSpeed,
  corneringLoad,
  createDriveState,
  isFullyOffRoad,
  hitsCone,
  separateBodyFromPoints,
  refillBoost,
} from './sim/car.js';
import { createRaceState, raceStep, segmentsCross } from './sim/race.js';
import { createKeyboard, NEUTRAL_INPUT, encodeInput } from './input.js';
import { isTouchDevice, createTouchControls, requestFullscreen } from './touchControls.js';
import { createScene3D, setCarModel, applyTexture, loadTrackTiles } from './render3d/scene.js';
import { loadTrackRibbon } from './render3d/trackRibbon.js';
import { loadDecorations } from './render3d/decorations.js';
import { addGrassField } from './render3d/grassField.js';
import { loadModel, loadTexture, loadModelTexture, fitCarModel } from './render3d/assets.js';
import { setupWheels } from './render3d/wheels.js';
import { createCarEffects } from './render3d/carEffects.js';
import { createNameplate } from './render3d/nameplate.js';
import { createChaseCamera } from './render3d/camera.js';
import { applyStoredCamera, createCameraSettings } from './cameraSettings.js';
import { createHud, fmt as fmtTime } from './hud.js';
import { createMinimap } from './minimap.js';
import { createAudio } from './audio.js';
import { lerp, lerpAngle } from './utils.js';
import * as THREE from 'three';
import { createRoom, joinRoom, reconnectRoom, createSnapshotBuffer } from './net/mpClient.js';
import { createRemoteCars } from './net/remoteCars.js';
import { createTrackState } from './sim/trackFactory.js';

// Gyökér-relatív ('/assets/...') utak GitHub Pages al-útvonalára (/autos-jatek/)
// prefixelve — ugyanaz a minta, mint render3d/assets.js withBase-je (itt egy
// sima <img src>-hez kell, ami nem megy át a GLTFLoader/TextureLoader-en).
function withBase(url) {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + url;
}
import {
  loadCustomLayout,
  loadCustomDecorations,
  saveCustomTrack,
  setActiveTrack,
  clearCustomLayout,
  getActiveTrackName,
} from './trackStorage.js';
import { apiListTracks, apiGetTrack } from './net/trackApi.js';
import {
  apiGetLeaderboard,
  apiSubmitLap,
  apiDeleteLeaderboardEntry,
  apiClearLeaderboard,
} from './net/leaderboardApi.js';
import { hashLayout } from './sim/trackKey.js';
import { TRACK, CARS, DEFAULT_LAYOUT, applyPhysicsPreset, DEFAULT_PHYSICS, PHYSICS_PRESETS } from './config.js';
import { isDevMode } from './devmode.js';
import { loadCarTuning, resetCarToDefaults, createTuningPanel } from './tuning.js';

// --- Közös megjelenítés (mindkét módhoz) ---
const { renderer, scene, camera, carMesh, asphaltMesh } = createScene3D(
  document.getElementById('game')
);

// Guminyom + porfelhő (render3d/carEffects.js) — egyetlen megosztott effekt-
// rendszer mindkét módhoz (SP: saját autó; MP: saját + minden távoli autó).
const carEffects = createCarEffects(scene);

// A menüben választott autó indexe (CARS lista) — perzisztálva. A saját autó
// modellje (SP + MP) ÉS multiplayerben a hálón küldött választás is ez.
let selectedCar = (() => {
  const n = parseInt(localStorage.getItem('autos-jatek:carIdx') || '0', 10);
  return Number.isInteger(n) && n >= 0 && n < CARS.length ? n : 0;
})();

let carColormapTex = null; // a Car Kit (textúrás) autókhoz — a Racing Kit-eseknek nem kell
let carWheels = { update() {} }; // a saját autó kerék-animátora (modell betöltése után)
(async () => {
  const [asphaltTex, carColormap] = await Promise.all([
    loadTexture(ASSETS.textures.asphalt, 1),
    loadModelTexture(ASSETS.car.colormap),
  ]);
  carColormapTex = carColormap;
  applyTexture(asphaltMesh, asphaltTex);
  await setPlayerCar(selectedCar); // a menüben választott autó betöltése a carMesh-be
})();

// Egy CARS-elem betöltött modelljét a saját kit-je szerint készíti el: a TEXTÚRÁS
// (Car Kit, colormap-es) autóra rátesszük a szín-atlaszt, a Racing Kit versenyautók
// a natív anyag-színükkel maradnak (colormap nélkül) — lásd config.CARS.
function buildCarHolder(car, model) {
  if (!model) return new THREE.Group();
  return fitCarModel(model, car.colormap ? carColormapTex : null);
}

// A saját autó (carMesh) modelljét a választott CARS-elemre cseréli — az üresjárati
// menü-előnézet ÉS az egyjátékos/multiplayer saját autó is ezt használja.
async function setPlayerCar(idx) {
  const car = CARS[idx % CARS.length];
  const model = await loadModel(car.model);
  const holder = buildCarHolder(car, model);
  setCarModel(carMesh, holder);
  carWheels = setupWheels(holder);
}

// Szabadvonalas (spline) pályánál `track.tiles` üres (lásd sim/trackFactory.js
// buildSplineTrack) — ilyenkor a procedurális szalag-hálót rakjuk le a diszkrét
// Kenney-csempék helyett; a régi (rács-alapú) pályáknál minden a régiben marad.
if (trackState.track.tiles.length === 0) {
  loadTrackRibbon(scene, trackState.track, trackState.roadHalf);
} else {
  loadTrackTiles(scene);
}
addGrassField(scene);
loadDecorations(scene);
// A mentett kamera-beállítás (távolság/magasság/szög) betöltése MÉG a chase
// kamera létrehozása/az első render előtt, hogy rögtön a választott nézettel induljon.
applyStoredCamera();
const cameraSettings = createCameraSettings();
const updateCamera = createChaseCamera(camera);
const readKeyboard = createKeyboard();
// Érintős vezérlés: CSAK touch-képes eszközön hozzuk létre (a gombok DOM-ja +
// pointer-listenerei feleslegesek desktopon). A tényleges input a kettő OR-a
// — egy touch laptopon a billentyűzet a gombok mellett is működik tovább.
const touch = isTouchDevice() ? createTouchControls() : null;
function readInput() {
  const k = readKeyboard();
  if (!touch) return k;
  const t = touch.readInput();
  return {
    up: k.up || t.up,
    down: k.down || t.down,
    left: k.left || t.left,
    right: k.right || t.right,
    drift: k.drift || t.drift,
    boost: k.boost || t.boost,
  };
}
const audio = createAudio();
const speedEl = document.getElementById('speed');

// Szöveg biztonságos beszúrása HTML-sablonba (XSS-védelem).
//
// MINDEN olyan szöveget át kell rajta engedni, ami NEM tőlünk származik: a
// játékosnevek és a PÁLYANEVEK is más felhasználóktól jönnek (a szerver csak
// hosszra vágja őket), és több helyen `innerHTML`-lel épített listákba kerülnek —
// escape nélkül egy `<img src=x onerror=…>` nevű pálya MINDEN játékos böngészőjében
// lefutna, amikor megnyitja a pálya-választót. Második védvonal a szerver CSP-je
// (server/security.js) és a nevek `<>`-szűrése (server/RaceRoom.js cleanName).
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Csalás miatti kizárás panelje (#kickedOverlay) ---
// Igaz, amíg a kizárás-panel látszik: ilyenkor NEM küldünk több állapotot a
// szervernek (a kapcsolat már zárva — a room.send hibát dobna minden képkockában).
let kickedShown = false;

function showKicked(reason) {
  kickedShown = true;
  // A verseny/lobby paneljei zárva — csak a kizárás-panel maradjon.
  lobbyEl.style.display = 'none';
  document.getElementById('results').style.display = 'none';
  document.getElementById('standings').style.display = 'none';
  document.getElementById('countdown').style.display = 'none';
  // Az indoklás a SZERVERTŐL jön; textContent (nem innerHTML), tehát semmilyen
  // jelölés nem értelmeződik benne.
  document.getElementById('kickedReason').textContent = reason;
  document.getElementById('kickedOverlay').style.display = 'flex';
}

// A panel egyetlen gombja: vissza a főmenübe. A reload SZÁNDÉKOSAN itt van (nem az
// onLeave-ben), hogy a játékos el tudja olvasni az indoklást, mielőtt eltűnik.
document.getElementById('btnKickedBack').onclick = () => window.location.reload();

// A restart / hot lap reset gomb viselkedése módfüggő — a dispatcher az aktív
// mód kezelőjét hívja.
let onRestartClick = () => {};
let onHotlapResetClick = () => {};
const updateHud = createHud(() => onRestartClick(), () => onHotlapResetClick());
// Kis felülnézeti pálya-rajz versenyközben (lásd minimap.js) — a jelenleg
// aktív pálya középvonalából épül fel, EGYSZER (a pálya csak reloaddal
// változik, lásd ensureTrackMatches), mind SP, mind MP frame-loop ezt hívja.
const minimapEl = document.getElementById('minimap');
const minimap = createMinimap(minimapEl, trackState.track.center);

// --- Menü / lobby DOM ---
const menuEl = document.getElementById('menu');
const lobbyEl = document.getElementById('lobby');
const standingsEl = document.getElementById('standings');
const nameInput = document.getElementById('playerName');
const menuStatus = document.getElementById('menuStatus');
const lobbyStatus = document.getElementById('lobbyStatus');

const lapsInput = document.getElementById('lapsInput');
const physicsSelect = document.getElementById('physicsSelect');
const leaderboardListEl = document.getElementById('leaderboardList');
const btnClearLeaderboard = document.getElementById('btnClearLeaderboard');
// Hot Lap: mindig látható ranglista-panel oldalt (lásd startSingleplayer) —
// UGYANAZT a tartalmat kapja, mint a menü sidepanelje (lásd renderLeaderboard).
const raceLeaderboardEl = document.getElementById('raceLeaderboard');
const raceLeaderboardListEl = document.getElementById('raceLeaderboardList');

// --- Autó-választó FELUGRÓ PANEL (lásd index.html #carPicker) — a sok (25+)
// jármű nem fér el kényelmesen egy 240px-es sidepanelben, ezért egy gomb
// (#btnPickCar a főmenüben, #btnMpPickCar a multiplayer beállításokban) nyitja
// meg ugyanazt a tágas, közös rácsot. ---
const carPickerEl = document.getElementById('carPicker');
const carPickerGridEl = document.getElementById('carPickerGrid');
const btnCarPickerClose = document.getElementById('btnCarPickerClose');
const btnPickCar = document.getElementById('btnPickCar');
const carPickThumb = document.getElementById('carPickThumb');
const carPickName = document.getElementById('carPickName');
const btnMpPickCar = document.getElementById('btnMpPickCar');
const mpCarPickThumb = document.getElementById('mpCarPickThumb');
const mpCarPickName = document.getElementById('mpCarPickName');

// --- Pálya-választó FELUGRÓ PANEL (lásd index.html #trackPicker) — ugyanaz a
// minta, mint az autó-választónál, csak a kártyákon egy kis pálya-RAJZ van
// (lásd drawTrackThumb) a puszta név helyett. ---
const trackPickerEl = document.getElementById('trackPicker');
const trackPickerGridEl = document.getElementById('trackPickerGrid');
const btnTrackPickerClose = document.getElementById('btnTrackPickerClose');
const btnPickTrack = document.getElementById('btnPickTrack');
const trackPickCanvas = document.getElementById('trackPickCanvas');
const trackPickName = document.getElementById('trackPickName');
const btnMpPickTrack = document.getElementById('btnMpPickTrack');
const mpTrackPickCanvas = document.getElementById('mpTrackPickCanvas');
const mpTrackPickName = document.getElementById('mpTrackPickName');

// --- Multiplayer beállítások panel (autó BÁRKI, pálya/körök/fizika a host) —
// a lobbiból ÉS a végeredmény-panelről is előhozható (lásd startMultiplayer). ---
const mpSettingsEl = document.getElementById('mpSettings');
const mpHostSettingsEl = document.getElementById('mpHostSettings');
const mpLapsInput = document.getElementById('mpLapsInput');
const mpPhysicsSelect = document.getElementById('mpPhysicsSelect');
const btnMpApplySettings = document.getElementById('btnMpApplySettings');
const mpSettingsStatus = document.getElementById('mpSettingsStatus');
const btnMpSettingsClose = document.getElementById('btnMpSettingsClose');
const btnLobbySettings = document.getElementById('btnLobbySettings');
const btnResultsSettings = document.getElementById('btnResultsSettings');

// Autó-választó: a CARS listából kattintható kártyák a #carPicker felugró
// panelben (index.html). A választás perzisztál, a 3D-előnézet (carMesh)
// azonnal a választott autóra vált (setPlayerCar), a KÉT trigger-gomb
// (főmenü + multiplayer beállítások) mindig a jelenlegi választást mutatja
// (updateCarPickButtons). Multiplayerben a választás a szervernek is
// elküldődik (`onCarChanged`, csak ott van beállítva).
let onCarChanged = null;

function renderCarPickerGrid() {
  carPickerGridEl.innerHTML = '';
  CARS.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'carswatch' + (i === selectedCar ? ' active' : '');
    // Kép-előnézet (Kenney Car Kit preview), HOGY LÁTSZÓDJON az autó, ne csak
    // a neve — lásd config.js CARS[].preview. A sarok-pötty (dot) a
    // névtábla/állás-jelölő SZÍNÉT mutatja továbbra is, kis kiegészítőként.
    btn.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <img class="carThumb" src="${withBase(c.preview)}" alt="" draggable="false" />
      <span class="carName">${c.name}</span>
    `;
    btn.onclick = () => {
      selectedCar = i;
      localStorage.setItem('autos-jatek:carIdx', String(i));
      setPlayerCar(i);
      updateCarPickButtons();
      if (onCarChanged) onCarChanged(i);
      closeCarPicker(); // választás = kész, a modal automatikusan bezáródik
    };
    carPickerGridEl.appendChild(btn);
  });
}

// A KÉT trigger-gomb (főmenü #btnPickCar + multiplayer #btnMpPickCar) kis
// előnézete — mindig a JELENLEGI választást mutatja, akkor is, ha az a másik
// gombon/panelen (vagy a hálózaton, lásd onCarChanged) keresztül változott.
function updateCarPickButtons() {
  const c = CARS[selectedCar % CARS.length];
  carPickThumb.src = withBase(c.preview);
  carPickName.textContent = c.name;
  mpCarPickThumb.src = withBase(c.preview);
  mpCarPickName.textContent = c.name;
}

function openCarPicker() {
  renderCarPickerGrid();
  carPickerEl.style.display = 'flex';
}
function closeCarPicker() {
  carPickerEl.style.display = 'none';
}
btnPickCar.onclick = openCarPicker;
btnMpPickCar.onclick = openCarPicker;
btnCarPickerClose.onclick = closeCarPicker;
updateCarPickButtons();

// Pálya-választó: a globális katalógusból (szerver, lásd trackApi.js) kattintható
// kártyák a #trackPicker felugró panelben — mindegyiken egy kis RAJZ (canvas),
// ugyanazzal a bbox-illesztéses skálázással, mint a versenyközbeni minitérkép
// (lásd minimap.js) — hogy LÁTSZÓDJON a pálya alakja, ne csak a neve.
//
// A FŐMENÜ és a MULTIPLAYER BEÁLLÍTÁSOK (host) EGYMÁSTÓL FÜGGETLEN kiválasztást
// tartanak (ugyanúgy, ahogy korábban a két külön <select> is független volt) —
// innen az `openTrackPicker(target)` 'menu'/'mp' paramétere.
let trackCatalog = null; // [{id,name,trackKey,...}] — egyszer lekérve, újrahasznosítva
let selectedTrackId = ''; // '' = beépített Alap pálya (főmenü)
let selectedTrackName = 'Alap pálya';
let mpSelectedTrackId = ''; // ua., de a multiplayer beállítások panelen
let mpSelectedTrackName = 'Alap pálya';

// A pálya-rajzokhoz kellő középvonal-pontok id→pontok gyorsítótára — a katalógus
// csak metaadatot ad (lásd server/trackStore.js listTracks), a teljes layoutot
// (és belőle a rajzhoz a középvonalat) csak igény szerint, egyszer töltjük le.
const trackCenterCache = new Map();
trackCenterCache.set(
  '',
  createTrackState(DEFAULT_LAYOUT, {
    tile: TRACK.tile,
    curbWidth: 0,
    gravelWidth: 0,
    checkpointCount: 1,
    start: TRACK.start,
  }).track.center
);

async function loadTrackCatalog() {
  if (trackCatalog) return trackCatalog;
  try {
    trackCatalog = await apiListTracks();
  } catch {
    trackCatalog = []; // szerver nem elérhető — marad csak az "Alap pálya"
  }
  return trackCatalog;
}
function findCatalogEntry(id) {
  return (trackCatalog || []).find((t) => t.id === id) || null;
}
async function getTrackCenter(id) {
  if (trackCenterCache.has(id)) return trackCenterCache.get(id);
  let center = null;
  try {
    const t = await apiGetTrack(id);
    center = createTrackState(t.layout, {
      tile: TRACK.tile,
      curbWidth: 0,
      gravelWidth: 0,
      checkpointCount: 1,
      start: TRACK.start,
    }).track.center;
  } catch {
    /* a kártya rajz nélkül, csak névvel marad — nem törik el a választó */
  }
  trackCenterCache.set(id, center);
  return center;
}

// A minimap.js-ével AZONOS elvű (bbox-illesztéses, torzításmentes) rajz, csak
// statikus (nincsenek versenyző-pontok) és kis canvasra méretezve.
function drawTrackThumb(canvas, centerPoints) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const PAD = 5;
  ctx.clearRect(0, 0, W, H);
  if (!centerPoints || centerPoints.length === 0) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of centerPoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxZ - minZ);
  const scale = Math.min((W - PAD * 2) / worldW, (H - PAD * 2) / worldH);
  const offX = (W - worldW * scale) / 2;
  const offY = (H - worldH * scale) / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  centerPoints.forEach((p, i) => {
    const cx = offX + (p.x - minX) * scale;
    const cy = offY + (p.z - minZ) * scale;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.stroke();
}

async function renderTrackPickerGrid(target) {
  await loadTrackCatalog();
  const currentId = target === 'mp' ? mpSelectedTrackId : selectedTrackId;
  const entries = [{ id: '', name: 'Alap pálya (beépített)' }, ...trackCatalog];
  trackPickerGridEl.innerHTML = '';
  for (const t of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // Ugyanaz a kártya-CSS ('carswatch'), mint az autó-választónál (lásd
    // index.html .carSelectGrid .carswatch) — csak a belső elem tér el
    // (canvas.trackThumb egy img.carThumb helyett).
    btn.className = 'carswatch' + (t.id === currentId ? ' active' : '');
    btn.innerHTML = `<canvas class="trackThumb" width="130" height="88"></canvas><span class="carName">${escapeHtml(t.name)}</span>`;
    btn.onclick = () => {
      if (target === 'mp') {
        mpSelectedTrackId = t.id;
        mpSelectedTrackName = t.name;
        updateMpTrackPickButton();
      } else {
        selectedTrackId = t.id;
        selectedTrackName = t.name;
        updateTrackPickButton();
        renderLeaderboard();
      }
      closeTrackPicker();
    };
    trackPickerGridEl.appendChild(btn);
    const canvas = btn.querySelector('canvas');
    getTrackCenter(t.id).then((center) => drawTrackThumb(canvas, center));
  }
}

function updateTrackPickButton() {
  trackPickName.textContent = selectedTrackName;
  getTrackCenter(selectedTrackId).then((center) => drawTrackThumb(trackPickCanvas, center));
}
function updateMpTrackPickButton() {
  mpTrackPickName.textContent = mpSelectedTrackName;
  getTrackCenter(mpSelectedTrackId).then((center) => drawTrackThumb(mpTrackPickCanvas, center));
}
function openTrackPicker(target) {
  renderTrackPickerGrid(target);
  trackPickerEl.style.display = 'flex';
}
function closeTrackPicker() {
  trackPickerEl.style.display = 'none';
}
btnPickTrack.onclick = () => openTrackPicker('menu');
btnMpPickTrack.onclick = () => openTrackPicker('mp');
btnTrackPickerClose.onclick = closeTrackPicker;

// --- Dev mód (?dev=1): pálya-szerkesztő link + élő autó-hangoló panel ---
// A szerkesztő linkje csak dev módban látszik (maga az editor.html is átirányít
// dev mód nélkül). A hangoló csúszkák a CAR-t élőben mutálják (lásd tuning.js);
// a mentett hangolást már induláskor alkalmazzuk, hogy a játék azzal fusson.
const editorLink = document.querySelector('#hud a[href*="editor"]');
let tuningPanel = null;
if (isDevMode()) {
  loadCarTuning();
  tuningPanel = createTuningPanel();
} else if (editorLink) {
  editorLink.parentElement.style.display = 'none';
}

nameInput.value = localStorage.getItem('autos-jatek:playerName') || '';
lapsInput.value = localStorage.getItem('autos-jatek:laps') || '3';
physicsSelect.value = Object.prototype.hasOwnProperty.call(
  PHYSICS_PRESETS,
  localStorage.getItem('autos-jatek:physics')
)
  ? localStorage.getItem('autos-jatek:physics')
  : DEFAULT_PHYSICS;

function playerName() {
  const n = nameInput.value.trim() || 'Játékos';
  localStorage.setItem('autos-jatek:playerName', n);
  return n;
}

// A választott körszám (a menü legördülőjéből). Perzisztálva, hogy az egyjátékos
// pálya-váltás miatti reload (playWithSelectedTrack) után is megmaradjon.
function chosenLaps() {
  const n = parseInt(lapsInput.value, 10);
  const laps = Number.isFinite(n) && n >= 1 && n <= 50 ? n : 3;
  lapsInput.value = String(laps); // érvénytelen/üres bevitel esetén visszaírjuk
  localStorage.setItem('autos-jatek:laps', String(laps));
  return laps;
}

// A választott autó-fizika (a menü legördülőjéből) — 'realistic' vagy 'light'.
// Perzisztálva. Egyjátékosnál KÖZVETLENÜL erre állítjuk a CAR-t (applyPhysicsPreset);
// multiplayerben csak ELKÜLDJÜK a szervernek (createRoom), a ténylegesen használt
// nevet a szoba az 'init' üzenetben adja vissza — azt alkalmazzuk (lásd startMultiplayer),
// mert a szerver egy Node-folyamatban több szobát szolgál ki, a globális CAR-t csak
// egy-egy kliens (SP/saját predikció) mutálja biztonságosan, a szerver nem.
function chosenPhysics() {
  const name = Object.prototype.hasOwnProperty.call(PHYSICS_PRESETS, physicsSelect.value)
    ? physicsSelect.value
    : DEFAULT_PHYSICS;
  physicsSelect.value = name;
  localStorage.setItem('autos-jatek:physics', name);
  return name;
}

// A jelenleg BETÖLTÖTT pálya aláírása (config.js ezt olvasta induláskor a
// localStorage aktív slotjából). Ha a menüben másik pályát választunk, ehhez
// hasonlítunk: eltérés esetén újratöltés kell, hogy a config.js/track.js az új
// pályával épüljön fel (a rejoin-mintát követve).
const initialTrackSig = JSON.stringify({
  l: loadCustomLayout(),
  d: loadCustomDecorations(),
});

// A főmenü kezdeti pálya-kiválasztása: a katalógus betöltése után, ha a
// localStorage aktív pályája (getActiveTrackName) egyezik egy katalógus-
// bejegyzés nevével, azt jelöljük ki — egyébként marad az "Alap pálya".
// Ugyanaz a preselect-logika, mint korábban a <select>-es populateTrackSelect
// vitte véghez; itt a #btnPickTrack gombot és a ranglistát frissíti.
async function initTrackSelection() {
  await loadTrackCatalog();
  const activeName = getActiveTrackName();
  const match = activeName ? trackCatalog.find((t) => t.name === activeName) : null;
  selectedTrackId = match ? match.id : '';
  selectedTrackName = match ? match.name : 'Alap pálya';
  updateTrackPickButton();
  renderLeaderboard();
}

// A kiválasztott pálya ranglista-azonosítója + neve (lásd selectedTrackId/
// selectedTrackName fent, illetve findCatalogEntry a trackKey-hez).
function currentTrackInfo() {
  const entry = findCatalogEntry(selectedTrackId);
  return {
    trackKey: entry?.trackKey || hashLayout(DEFAULT_LAYOUT),
    trackName: selectedTrackName,
  };
}

// Egy ranglista-lista kirajzolása egy adott elembe — a menü sidepanelje ÉS a
// Hot Lap oldali panel (raceLeaderboardListEl) is EZT hívja, azonos adatból
// (lásd renderLeaderboard), hogy ne kelljen a köridőt kétszer lekérni.
// A törlés-gomb (dev mód) csak ott jelenik meg, ahol `allowDelete` igaz — a
// race-panel tisztán megjelenítő, versenyközben nincs értelme törlőgombnak.
function paintLeaderboardEntries(el, entries, dev, allowDelete) {
  if (entries.length === 0) {
    el.innerHTML = '<p>Még nincs rögzített köridő ehhez a pályához.</p>';
    return;
  }
  el.innerHTML = entries
    .map((e, i) => `
      <div class="lbRow">
        <span class="lbPos">${i + 1}.</span>
        <span class="lbName">${escapeHtml(e.playerName)}</span>
        <span class="lbTime">${fmtTime(e.lapTime)}</span>
        ${dev && allowDelete ? `<button class="lbDel" data-name="${escapeHtml(e.playerName)}">✕</button>` : ''}
      </div>
    `)
    .join('');
  if (dev && allowDelete) {
    el.querySelectorAll('.lbDel').forEach((btn) => {
      btn.onclick = async () => {
        const { trackKey: tk } = currentTrackInfo();
        await apiDeleteLeaderboardEntry(tk, chosenPhysics(), btn.dataset.name);
        renderLeaderboard();
      };
    });
  }
}

// A jelenleg választott pálya + fizika örök-ranglistájának betöltése és
// kirajzolása a főmenübe ÉS (ha épp látszik) a Hot Lap oldali panelbe. Dev
// módban törlés-gombok is megjelennek soronként, illetve az egész tábla
// törlésére is (btnClearLeaderboard, lásd index.html).
async function renderLeaderboard() {
  const { trackKey, trackName } = currentTrackInfo();
  const physics = chosenPhysics();
  const dev = isDevMode();
  btnClearLeaderboard.style.display = dev ? 'block' : 'none';
  leaderboardListEl.textContent = 'Betöltés…';
  let entries = [];
  try {
    entries = await apiGetLeaderboard(trackKey, physics);
  } catch {
    leaderboardListEl.innerHTML = '<p>Nem sikerült betölteni a ranglistát.</p>';
    raceLeaderboardListEl.innerHTML = '<p>Nem sikerült betölteni a ranglistát.</p>';
    return;
  }
  // Időközben másik pályára/fizikára válthatott a felhasználó — eldobjuk a válasz.
  const now = currentTrackInfo();
  if (now.trackKey !== trackKey || chosenPhysics() !== physics) return;

  paintLeaderboardEntries(leaderboardListEl, entries, dev, true);
  paintLeaderboardEntries(raceLeaderboardListEl, entries, dev, false);
}

physicsSelect.addEventListener('change', renderLeaderboard);
btnClearLeaderboard.addEventListener('click', async () => {
  const { trackKey, trackName } = currentTrackInfo();
  if (!confirm(`Biztosan törlöd a(z) "${trackName}" pálya teljes ranglistáját?`)) return;
  await apiClearLeaderboard(trackKey, chosenPhysics());
  renderLeaderboard();
});
renderLeaderboard();

// A kiválasztott pálya alkalmazása, majd a kért akció (egyjátékos / szoba).
// Ha az új pálya eltér a jelenleg betöltöttől, elmentjük aktívnak és újratöltünk
// egy "pending" akcióval — az oldal újratöltése után a config.js már az új
// pályával épül, és a pending akció automatikusan lefut.
async function playWithSelectedTrack(action) {
  const id = selectedTrackId;
  menuStatus.textContent = 'Pálya betöltése…';
  try {
    if (id) {
      const t = await apiGetTrack(id);
      const editorView = t.editorPath
        ? { path: t.editorPath, decorations: t.editorDecorations || [] }
        : null;
      setActiveTrack(t.name, t.layout, t.decorations, editorView);
    } else {
      clearCustomLayout(); // "Alap pálya" — a beépített layout
    }
  } catch (e) {
    menuStatus.textContent = `Nem sikerült a pálya betöltése: ${e.message || 'ismeretlen hiba'}`;
    return;
  }
  menuStatus.textContent = '';

  const sig = JSON.stringify({ l: loadCustomLayout(), d: loadCustomDecorations() });
  if (sig !== initialTrackSig) {
    sessionStorage.setItem(
      'autos-jatek:pending',
      JSON.stringify({ action, name: playerName() })
    );
    window.location.reload();
    return;
  }
  if (action === 'single') startSingleplayer();
  else if (action === 'hotlap') startSingleplayer(true);
  else doCreate();
}

// --- Üresjárati render (amíg a menüben vagyunk): lassan körbeforgó kamera ---
let mode = 'menu'; // 'menu' | 'single' | 'multi'
let currentRoom = null; // multiplayerben a Colyseus room — a Főmenü-gomb ebből lép ki
let lastTime = performance.now();

// SP-ben a köridő-beküldés (apiSubmitLap) folyamatban lévő Promise-a, vagy
// null, ha épp nincs ilyen — lásd startSingleplayer recordState(). ÉLŐ
// HIBAJELENTÉS: a javított köridő gyakran "eltűnt", mert a "← Főmenü" gomb
// AZONNAL reload-olt, ami megszakította a még folyamatban lévő beküldést
// (pont akkor, amikor a legvalószínűbb, hogy a versenyt/kört most fejezte be
// és rögtön kilépett). A lenti kilépés-gomb ezért — a keepalive fetch
// (leaderboardApi.js) mellett MÁSODIK védelmi rétegként — MEGVÁRJA (korlátos
// ideig), amíg ez lezárul, mielőtt újratöltene.
let pendingLapSubmission = null;

// Verseny közben (SP vagy MP) elérhető "vissza a főmenübe" gomb — MP-ben
// tisztán kilép a szobából, utána (mindkét módban) egyszerűen újratöltjük az
// oldalt: ez ugyanaz a minta, mint a lobby/eredmény "Kilépés"/"Vissza" gombjai
// (btnLeave, btnResultsLeave) — pending session-adat nélkül a reload után a
// főmenü jelenik meg.
const btnQuitRaceEl = document.getElementById('btnQuitRace');
btnQuitRaceEl.onclick = async () => {
  if (currentRoom) currentRoom.leave();
  if (pendingLapSubmission) {
    // Rövid, LÁTHATÓ várakozás — a gomb ne tűnjön "beragadtnak", de a
    // beküldésnek adjunk esélyt lezárulni (normál esetben ez ezredmásodpercek,
    // csak "kihűlt" Railway-szerver ébredésekor tarthat pár másodpercig).
    const prevText = btnQuitRaceEl.textContent;
    const prevDisabled = btnQuitRaceEl.disabled;
    btnQuitRaceEl.textContent = 'Köridő mentése…';
    btnQuitRaceEl.disabled = true;
    await Promise.race([pendingLapSubmission, new Promise((r) => setTimeout(r, 4000))]);
    btnQuitRaceEl.textContent = prevText;
    btnQuitRaceEl.disabled = prevDisabled;
  }
  window.location.reload();
};

function idleFrame(now) {
  if (mode !== 'menu') return;
  const t = now / 1000;
  const cx = spawn.x, cz = spawn.y;
  camera.position.set(cx + Math.cos(t * 0.15) * 60, 35, cz + Math.sin(t * 0.15) * 60);
  camera.lookAt(cx, 0, cz);
  renderer.render(scene, camera);
  requestAnimationFrame(idleFrame);
}

// =============================================================================
//  EGYJÁTÉKOS MÓD — a korábbi (1-2. fázis) lokális játék, változatlan logikával.
//  `hotLap`: gyakorló mód — nincs körszám-limit, a rajt/cél vonaltól hátrébb,
//  guruló rajttal indulunk, és a rajtvonalig tartó szakasz NEM számít bele a
//  mért időbe (lásd lent a hotLapStarted logikát) — csak az onnantól futott,
//  valódi ("flying") kör.
// =============================================================================
function startSingleplayer(hotLap = false) {
  mode = 'single';
  menuEl.style.display = 'none';
  document.getElementById('btnQuitRace').style.display = 'block';
  minimapEl.style.display = 'block';
  cameraSettings.show();
  if (touch) touch.show();
  carEffects.reset(); // friss guminyom/porfelhő-állapot minden versenykezdésnél

  // Hot Lap: a ranglista mindig látszik oldalt, versenyközben is — enélkül a
  // menü bezárásával eltűnt, pedig épp Hot Lap közben a leghasznosabb élőben
  // látni, hol állsz. Normál egyjátékosnál/MP-ben marad rejtve (nem kérték).
  raceLeaderboardEl.style.display = hotLap ? 'flex' : 'none';
  if (hotLap) renderLeaderboard();

  // A menüben választott autó-fizika (realistic/light) a globális CAR-ra — SP-ben
  // csak egy versenyt futtatunk ebben a lapban, ezt biztonságosan mutálhatjuk.
  const physicsName = chosenPhysics();
  applyPhysicsPreset(physicsName);

  // ÖRÖK RANGLISTA: SP-ben nincs authoritative szerver, ezért a KLIENS küldi be
  // a köridőt REST-en — csak akkor, ha az eddigi beküldötthöz képest javult
  // (a tároló amúgy is csak jobb időt fogad el, ez csak a felesleges hívásokat spórolja meg).
  const { trackKey, trackName } = currentTrackInfo();
  let lastSubmittedBest = null;
  let submitInFlight = false; // egyszerre csak egy beküldés — lásd recordState
  // ÉLŐ HIBAJELENTÉS: "gyakran nem menti el a köridőt". A gyökér-ok egy FÉKEZÉS
  // NÉLKÜLI újrapróbálkozás volt — ha egy beküldés BÁRMIÉRT elbukott (átmeneti
  // hálózati hiba, "kihűlt" Railway-szerver, forgalomkorlát), a régi kód a
  // KÖVETKEZŐ fizika-lépésben (1/60 s múlva) AZONNAL újra megpróbálta, minden
  // sikertelen próbálkozást is beleértve a szerver ÍRÁSI forgalomkorlátjába
  // (30/perc) — így a saját újrapróbálkozás-áradata tartotta magát tartósan
  // korlátozva, akár egy teljes percig, függetlenül attól, hány további kört
  // futott közben a játékos. A hiba emellett CSENDBEN lett elnyelve
  // (.catch(()=>{})), tehát semmi nyoma nem maradt. Növekvő várakozással
  // (1s → max 20s) és console.error-ral javítva.
  let nextSubmitAttemptAt = 0; // performance.now() időbélyeg — eddig NEM próbálkozunk újra
  let submitBackoffMs = 1000;
  let consecutiveSubmitFailures = 0;

  // Terelőkúpok VILÁG-koordinátái (lásd render3d/decorations.js ugyanezt a
  // world = dgx/dgy * TRACK.tile képletet) — a kör-érvényesség ellenőrzéséhez.
  const conePoints = loadCustomDecorations()
    .filter((d) => d.type === 'pylon')
    .map((d) => ({ x: d.dgx * TRACK.tile, y: d.dgy * TRACK.tile }));

  // Hot Lap: a rajtvonaltól hátrébb (guruló rajt) — lásd sim/trackFactory.js
  // pointBeforeStart. Normál módban ez egyszerűen a rajtvonal (spawn).
  const startPoint = hotLap ? trackState.pointBeforeStart(RACE.hotlapRunupMeters) : spawn;

  const world = createWorld();
  const carBody = createCarBody(world, startPoint.x, startPoint.y, startPoint.angle);
  const stepper = createStepper();
  const laps = chosenLaps();
  const race = createRaceState(hotLap ? Infinity : laps);
  race.isHotLap = hotLap; // csak megjelenítéshez (hud.js) — a raceStep nem használja
  const drive = createDriveState();
  // Guruló rajtnál a TÉNYLEGES rajtvonal első átszeléséig a köridő nem indul —
  // a raceStep ezt a crossingot magától is figyelmen kívül hagyja (nextCheckpoint=1,
  // a 0. checkpoint kívül esik a lookahead-ablakán), itt csak ÉSZLELJÜK, és
  // onnantól nullázzuk az órát, hogy a mért kör valódi "flying lap" legyen.
  let hotLapArmed = hotLap;

  const prev = { x: startPoint.x, y: startPoint.y, angle: startPoint.angle };
  const curr = { x: startPoint.x, y: startPoint.y, angle: startPoint.angle };

  function recordState() {
    prev.x = curr.x;
    prev.y = curr.y;
    prev.angle = curr.angle;
    const p = carBody.getPosition();
    curr.x = p.x;
    curr.y = p.y;
    curr.angle = carBody.getAngle();
    // Guruló rajt: a TÉNYLEGES rajtvonal első átszelésekor nullázzuk az órát
    // (lásd a hotLapArmed deklarációját fentebb) — ez a crossing raceStep-nek
    // magának nem esemény, csak nekünk jelzi, hogy innentől "éles" a kör.
    if (hotLapArmed && segmentsCross(prev, curr, checkpoints[0].a, checkpoints[0].b)) {
      hotLapArmed = false;
      race.time = 0;
      race.lapStartTime = 0;
      race.lapValid = true; // a guruló-rajt szakasza (letérés, sarok) ne rontsa el az ELSŐ mért kört
      race.currentSplits = [];
    }
    // A TELJES autó elhagyta a pályát, VAGY terelőkúpnak ütközött → a kör érvénytelen.
    const offTrack =
      isFullyOffRoad(carBody, offRoadExcess) || hitsCone(carBody, conePoints, RACE.coneHitRadius);
    const raceEvents = raceStep(race, prev, curr, SIM.fixedDt, checkpoints, offTrack, trackHeadingAt);
    // Boost-üzemanyag újratöltése minden körváltásnál (és célba éréskor) —
    // lásd config.js BOOST.maxPerLap / sim/car.js refillBoost.
    if (raceEvents.some((e) => e.type === 'lap' || e.type === 'finish')) refillBoost(drive);

    // FONTOS: lastSubmittedBest CSAK sikeres válasz után frissül (nem rögtön a
    // hívás előtt) — így ha egy beküldés elhasal, a KÖVETKEZŐ próbálkozás
    // (lásd nextSubmitAttemptAt — NÖVEKVŐ várakozással, nem azonnal) újra
    // megpróbálja UGYANEZT az időt, amíg nem sikerül.
    if (
      !submitInFlight &&
      performance.now() >= nextSubmitAttemptAt &&
      race.bestLapTime !== null &&
      (lastSubmittedBest === null || race.bestLapTime < lastSubmittedBest - 1e-6)
    ) {
      submitInFlight = true;
      const timeToSubmit = race.bestLapTime;
      // A modul-szintű pendingLapSubmission-be is elmentjük — a "← Főmenü"
      // gomb ezt várja meg, mielőtt reload-olna (lásd ott a megjegyzést).
      pendingLapSubmission = apiSubmitLap({
        trackKey,
        trackName,
        physics: physicsName,
        playerName: playerName(),
        lapTime: timeToSubmit,
      })
        .then(() => {
          lastSubmittedBest = timeToSubmit;
          submitBackoffMs = 1000; // sikeres beküldés után a KÖVETKEZŐ hiba megint gyors próbával induljon
          consecutiveSubmitFailures = 0;
          race.lapSaveFailing = false;
          renderLeaderboard();
        })
        .catch((e) => {
          // ÉLŐ HIBAJELENTÉS: korábban ez csendben el lett nyelve — most legalább
          // a konzolban látszik, MIÉRT nem mentődött el a köridő.
          console.error(`Köridő beküldése sikertelen (${timeToSubmit.toFixed(2)} s):`, e?.message || e);
          consecutiveSubmitFailures++;
          // Növekvő várakozás (1s → 2s → 4s ... max 20s), hogy a saját
          // újrapróbálkozásunk ne tartsa magát tartósan a szerver írási
          // forgalomkorlátján (30/perc) — élő hibajelentés: enélkül a
          // visszapattanó kérések önmagukat tartották kizárva akár egy percig.
          nextSubmitAttemptAt = performance.now() + submitBackoffMs;
          submitBackoffMs = Math.min(submitBackoffMs * 2, 20000);
          // 3+ egymást követő sikertelen próbálkozás után LÁTHATÓ jelzés
          // (lásd hud.js) — egy-két átmeneti hiba még nem riaszt, de a
          // játékos tudja meg, ha TARTÓSAN nem sikerül menteni.
          if (consecutiveSubmitFailures >= 3) race.lapSaveFailing = true;
        })
        .finally(() => {
          submitInFlight = false;
          pendingLapSubmission = null;
        });
    }
  }

  onRestartClick = () => {
    resetCar(carBody, spawn.x, spawn.y, spawn.angle);
    Object.assign(race, createRaceState(laps));
    Object.assign(drive, createDriveState());
    prev.x = curr.x = spawn.x;
    prev.y = curr.y = spawn.y;
    prev.angle = curr.angle = spawn.angle;
    carEffects.reset();
    // Friss próba — a HUD-figyelmeztetés (ha volt) ne ragadjon rajta, és a
    // visszafogási időzítő se várakoztasson feleslegesen egy régi hibán.
    race.lapSaveFailing = false;
    nextSubmitAttemptAt = 0;
    submitBackoffMs = 1000;
    consecutiveSubmitFailures = 0;
  };

  // Hot Lap reset: azonnal vissza a guruló-rajt pontra, új próba — a
  // személyes legjobb (bestLapTime/lapTimes) MEGMARAD, csak a folyamatban lévő
  // kör/idő nullázódik, hogy a gyakorlás közben lehessen a rekordot kergetni.
  if (hotLap) {
    onHotlapResetClick = () => {
      resetCar(carBody, startPoint.x, startPoint.y, startPoint.angle);
      const fresh = createRaceState(Infinity);
      fresh.isHotLap = true;
      fresh.bestLapTime = race.bestLapTime;
      fresh.bestLapSplits = race.bestLapSplits;
      fresh.lapTimes = race.lapTimes;
      Object.assign(race, fresh);
      Object.assign(drive, createDriveState());
      prev.x = curr.x = startPoint.x;
      prev.y = curr.y = startPoint.y;
      prev.angle = curr.angle = startPoint.angle;
      hotLapArmed = true;
      carEffects.reset();
    };
  }

  let lastCountInt = null;
  let lastPhase = race.phase;
  // "Nincs üzemanyag" hiba-hang csak ÚJ próbálkozásonként szóljon (élfigyelés),
  // ne minden képkockában, amíg a gombot üres tartállyal nyomva tartja.
  let wasBoostDenied = false;
  lastTime = performance.now();

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    const input = race.phase === 'racing' ? readInput() : NEUTRAL_INPUT;
    const alpha = stepper(
      world,
      dt,
      (fixedDt) => {
        if (race.phase === 'finished') coastToStop(carBody);
        else updateCar(carBody, input, fixedDt, drive, offRoadExcess);
      },
      recordState
    );

    const x = lerp(prev.x, curr.x, alpha);
    const z = lerp(prev.y, curr.y, alpha);
    const angle = lerpAngle(prev.angle, curr.angle, alpha);

    carMesh.position.set(x, 0.12, z);
    carMesh.rotation.y = -angle;
    carWheels.update(forwardSpeed(carBody), drive.steer, dt);
    carEffects.update(
      [{
        id: 'me', x, z, angle,
        lateralSpeed: lateralSpeed(carBody),
        forwardSpeed: forwardSpeed(carBody),
        corneringLoad: corneringLoad(carBody),
        boosting: drive.boosting,
      }],
      dt,
      offRoadExcess
    );

    if (window.__TOP) {
      camera.position.set(x, window.__TOP, z + 0.001);
      camera.lookAt(x, 0, z);
    } else {
      updateCamera(x, z, angle, dt, drive.boosting);
    }
    renderer.render(scene, camera);

    if (race.phase === 'countdown') {
      const c = Math.ceil(race.countdownLeft);
      if (c !== lastCountInt && c > 0) audio.beep(520, 0.16);
      lastCountInt = c;
    }
    if (lastPhase === 'countdown' && race.phase === 'racing') audio.beep(880, 0.35);
    lastPhase = race.phase;

    audio.update({
      speedKmh: speedKmh(carBody),
      throttle: race.phase === 'racing' && input.up,
      corneringLoad: race.phase === 'finished' ? 0 : corneringLoad(carBody),
      boosting: race.phase === 'racing' && drive.boosting,
    });

    // "Nincs boost-üzemanyag" hiba-hang: gomb+gáz nyomva, DE üres a tartály —
    // csak az ÚJ próbálkozás pillanatában szól (lásd wasBoostDenied fent).
    const boostDenied =
      race.phase === 'racing' && input.boost && input.up && drive.boostRemaining <= 0;
    if (boostDenied && !wasBoostDenied) audio.playBoostEmpty();
    wasBoostDenied = boostDenied;

    if (speedEl) speedEl.textContent = `Sebesség: ${Math.round(speedKmh(carBody))} km/h`;
    race.boostRemaining = drive.boostRemaining; // csak megjelenítéshez (hud.js)
    updateHud(race);
    minimap.draw([{ x, z, color: CARS[selectedCar]?.color, isMe: true }]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    window.__GAME = { world, carBody, camera, scene, race, audio, renderer, drive, minimap, carEffects, updateHud };
  }
}

// =============================================================================
//  MULTIPLAYER MÓD — a szerver az igazság, mi inputot küldünk és renderelünk.
// =============================================================================

// Az autó-modell + jelölőszín + ikon a config.CARS listából (a colorIdx = ez az index).
const carColor = (i) => CARS[i % CARS.length].color;
const carIcon = (i) => CARS[i % CARS.length].icon;

// A szoba pályája a MI lokálisan felépített pályánk-e? Ha nem, elmentjük a
// szerverét aktívnak, és újratöltjük az oldalt (a pálya-render a betöltéskor
// épül) — a sessionStorage-ba tett "rejoin" adattal automatikusan visszalépünk.
// A `room.reconnectionToken`-t IS elmentjük (nem csak a kódot): a visszatéréskor
// ezzel `reconnect()`-elünk (lásd a fájl végén a rejoin-blokkot), ami a SAJÁT,
// meglévő helyünkre tér vissza (host-szerep/colorIdx megmarad) — sima
// joinRoom(code)-dal ez egy ÚJ csatlakozás lenne (elveszett host-szerep,
// és a szerver `allowReconnection`-je se találná meg, mert az más
// reconnectionTokent várna — lásd server/RaceRoom.js onLeave).
function ensureTrackMatches(init, room) {
  const localLayout = JSON.stringify(TRACK.layout);
  const serverLayout = JSON.stringify(init.layout);
  if (localLayout === serverLayout) return true;
  saveCustomTrack(init.layout, init.decorations);
  sessionStorage.setItem(
    'autos-jatek:mp-rejoin',
    JSON.stringify({ code: room.roomId, reconnectionToken: room.reconnectionToken, name: playerName() })
  );
  window.location.reload();
  return false;
}

async function startMultiplayer(room) {
  mode = 'multi';
  currentRoom = room;
  menuEl.style.display = 'none';
  document.getElementById('btnQuitRace').style.display = 'block';
  minimapEl.style.display = 'block';
  cameraSettings.show();
  if (touch) touch.show();

  // Szerver-ping (RTT) mérése + kijelzése: időbélyeget küldünk, a szerver azonnal
  // visszaküldi ('pong'), a körbeérés ideje a késleltetés. Másodpercenként frissül.
  const pingEl = document.getElementById('ping');
  pingEl.style.display = 'block';
  pingEl.textContent = 'Ping: … ms';
  // A fél RTT (egy irányú út) a távoli autók JELEN-idejű célzásához kell: a
  // snapshot-időbélyeg a küldés pillanatáé, tehát mire ideér, már ennyivel
  // "öreg" (lásd net/remoteCars.js applyAuthoritative `ageSec`).
  let mpHalfRttSec = 0;
  room.onMessage('pong', (t) => {
    const rtt = Math.max(0, performance.now() - t);
    // Simítás: a mérés zajos, ne ugráljon tőle a becslés.
    mpHalfRttSec = mpHalfRttSec === 0 ? rtt / 2000 : mpHalfRttSec * 0.7 + (rtt / 2000) * 0.3;
    pingEl.textContent = `Ping: ${Math.round(rtt)} ms`;
  });
  const pingTimer = setInterval(() => {
    try {
      room.send('ping', performance.now());
    } catch {
      /* a szoba már bezárt — a következő reload úgyis megszünteti */
    }
  }, 1000);

  // Multiplayerben a helyi CAR-hangolás predikció-hibát okozna (a szerver az
  // ALAP értékekkel szimulál) — visszaállunk az alapra, a hangoló panel eltűnik.
  resetCarToDefaults();
  if (tuningPanel) tuningPanel.hide();

  const buffer = createSnapshotBuffer();
  const myId = room.sessionId;
  let mpTotalLaps = RACE.laps; // a szoba körszáma (az init üzenetből)

  // KLIENS-AUTORITATÍV: a saját autót HELYBEN, a teljes egyjátékos-simmel számoljuk
  // (nincs predikció/reconcile → a szerver SOHA nem korrigál/húz). A szerver csak
  // relay: elküldjük neki a kész állapotot, ő szétküldi a többieknek.
  const mpWorld = createWorld();
  let mySpawn = { x: spawn.x, y: spawn.y, angle: spawn.angle };
  const mpCar = createCarBody(mpWorld, mySpawn.x, mySpawn.y, mySpawn.angle);
  const mpStepper = createStepper();
  const mpDrive = createDriveState();
  // A TÖBBI játékos autója — helyben, a VALÓDI fizikán szimulálva, az általuk
  // küldött vezérlésből (lásd net/remoteCars.js). Ugyanabban a világban futnak,
  // mint a saját autónk, ugyanazzal a fix lépésközzel — így a mozgásuk is
  // ugyanolyan sima, és jelen-időben látszanak (nem a múltban).
  const remoteCars = createRemoteCars(mpWorld, offRoadExcess);
  let mpLastAuthT = null; // a legutóbb FELDOLGOZOTT snapshot időbélyege
  const mpRace = createRaceState(mpTotalLaps);
  const mpPrev = { x: mySpawn.x, y: mySpawn.y, angle: mySpawn.angle };
  const mpCurr = { x: mySpawn.x, y: mySpawn.y, angle: mySpawn.angle };
  // Terelőkúpok VILÁG-koordinátái (a kör-érvényességhez, mint egyjátékosban).
  const mpConePoints = loadCustomDecorations()
    .filter((d) => d.type === 'pylon')
    .map((d) => ({ x: d.dgx * TRACK.tile, y: d.dgy * TRACK.tile }));
  let mpPeerPoints = []; // a többi kocsi középpontjai (puha szétnyomáshoz)
  let mpStartedRacing = false; // a szerver countdown→racing váltás egyszeri kezelése
  let mpSentFinish = false; // a cél-jelzést egyszer küldjük
  let mpRaceGen = 0; // a szerver raceStart-jából kapott verseny-generáció (lásd RaceRoom.js)
  let mpLastStateSentAt = 0;

  function mpPlaceAtSpawn() {
    resetCar(mpCar, mySpawn.x, mySpawn.y, mySpawn.angle);
    mpPrev.x = mpCurr.x = mySpawn.x;
    mpPrev.y = mpCurr.y = mySpawn.y;
    mpPrev.angle = mpCurr.angle = mySpawn.angle;
  }

  function mpResetForRace() {
    Object.assign(mpRace, createRaceState(mpTotalLaps));
    Object.assign(mpDrive, createDriveState());
    mpStartedRacing = false;
    mpSentFinish = false;
    mpPlaceAtSpawn();
  }

  // A saját autó bejelentése a szervernek (relay) — throttle-olva NET.sendHz-re
  // (60 Hz, a 40 Hz-es broadcast fölött, hogy minden broadcast friss pozíciót
  // kapjon — lásd config.js sendHz megjegyzése).
  function mpSendState(now, input) {
    // Kizárás után a kapcsolat már zárva — a küldés minden képkockában hibát dobna.
    if (kickedShown) return;
    if (now - mpLastStateSentAt < 1000 / NET.sendHz) return;
    mpLastStateSentAt = now;
    const pos = mpCar.getPosition();
    const vel = mpCar.getLinearVelocity();
    room.send('state', {
      x: pos.x, y: pos.y, angle: mpCar.getAngle(),
      vx: vel.x, vy: vel.y, w: mpCar.getAngularVelocity(),
      // A VEZÉRLÉSÜNK is megy (bitmaszk) — ebből a többi kliens a mi autónkat
      // a valódi fizikán tudja továbbszimulálni (lásd net/remoteCars.js). A
      // boost mezőnél NEM a nyers gombállapotot küldjük, hanem a TÉNYLEGESEN
      // alkalmazott (üzemanyag-korlátos) állapotot (mpDrive.boosting — az
      // updateCar/updateBoost már eldöntötte) — így a távoli megfigyelők
      // pontosan azt látják/szimulálják, amit mi valójában csináltunk, üres
      // üzemanyagnál nem "csalunk" számukra extra gyorsulást.
      inp: encodeInput({ ...(input || NEUTRAL_INPUT), boost: mpDrive.boosting }),
      speed: speedKmh(mpCar), cornering: corneringLoad(mpCar),
      lap: mpRace.lap,
      progress: trackState.trackProgress(pos.x, pos.y),
      curLap: mpRace.time - mpRace.lapStartTime,
      lastLap: mpRace.lastLapTime,
      bestLap: mpRace.bestLapTime,
      lapValid: mpRace.lapValid,
      wrongWay: mpRace.wrongWay,
      finished: mpRace.phase === 'finished',
      totalTime: mpRace.phase === 'finished' ? mpRace.time : null,
      raceGen: mpRaceGen,
    });
  }

  // Távoli (és saját) autó-mesh-ek: id → THREE.Group. A sajátunk a meglévő carMesh.
  const meshes = new Map([[myId, carMesh]]);
  const loadingMeshes = new Set();
  // Kerék-animátorok id-nként (gördülés + kormányzás). A sajátunk a fő carWheels.
  const wheelAnims = new Map([[myId, carWheels]]);

  async function ensureMesh(id, colorIdx, name) {
    if (meshes.has(id) || loadingMeshes.has(id)) return;
    loadingMeshes.add(id);
    const car = CARS[colorIdx % CARS.length];
    const model = await loadModel(car.model);
    // A kit-jének megfelelően (Car Kit: colormap, Racing Kit: natív anyagszín).
    const group = buildCarHolder(car, model);
    // A TÖBBI játékos autója fölé lebegő névtábla (a sajátunk fölé nem kell).
    if (id !== myId) group.add(createNameplate(name, carColor(colorIdx)));
    scene.add(group);
    meshes.set(id, group);
    wheelAnims.set(id, setupWheels(group));
    loadingMeshes.delete(id);
  }

  function removeStaleMeshes(players) {
    for (const [id, mesh] of meshes.entries()) {
      if (id !== myId && !players[id]) {
        scene.remove(mesh);
        meshes.delete(id);
        wheelAnims.delete(id);
        carEffects.remove(id);
      }
    }
  }

  // --- Lobby UI ---
  const lobbyPlayersEl = document.getElementById('lobbyPlayers');
  const lobbyCodeEl = document.getElementById('lobbyCode');
  const btnStart = document.getElementById('btnStart');
  const btnLeave = document.getElementById('btnLeave');
  let isHost = false;
  let roomPhase = 'lobby';

  // --- Végeredmény-panel (verseny vége) ---
  const resultsEl = document.getElementById('results');
  const resultsListEl = document.getElementById('resultsList');
  const btnResultsAgain = document.getElementById('btnResultsAgain');
  const btnResultsLeave = document.getElementById('btnResultsLeave');
  let resultsShown = false;
  btnResultsAgain.onclick = () => room.send('start'); // host: új verseny ugyanabban a szobában
  btnResultsLeave.onclick = () => {
    room.leave();
    window.location.reload();
  };

  // A teljes helyezés-lista kirajzolása és a panel megjelenítése (egyszer/verseny).
  function showResults(players) {
    if (resultsShown) return;
    resultsShown = true;
    const list = Object.values(players).sort((a, b) => {
      if (a.finished && b.finished) return a.place - b.place; // célba értek: helyezés szerint
      if (a.finished) return -1;
      if (b.finished) return 1;
      // DNF-ek egymás közt: aki messzebb jutott (kör + folytonos pálya-progressz), előrébb.
      return (b.lap + (b.progress || 0)) - (a.lap + (a.progress || 0));
    });
    resultsListEl.innerHTML = list
      .map((p, i) => {
        const pos = p.finished ? `${p.place}.` : '–';
        const medal = p.place === 1 ? '🥇' : p.place === 2 ? '🥈' : p.place === 3 ? '🥉' : '';
        const time = p.finished
          ? `<span class="rtime">${p.totalTime.toFixed(2)} s</span>`
          : `<span class="dnf">DNF</span>`;
        const meCls = p.name === playerName() ? ' me' : '';
        const dot = `<span style="color:${carColor(p.colorIdx)}">●</span>`;
        return `<div class="res${meCls}"><span class="pos">${medal || pos}</span>${dot}<span class="rname">${escapeHtml(p.name)}</span>${time}</div>`;
      })
      .join('');
    btnResultsAgain.style.display = isHost ? 'block' : 'none';
    resultsEl.style.display = 'flex';
  }
  function hideResults() {
    resultsShown = false;
    resultsEl.style.display = 'none';
  }

  // --- Multiplayer beállítások panel (autó BÁRKI, pálya/körök/fizika a host) ---
  // A lobbiból ÉS a végeredmény-panelről is előhozható (btnLobbySettings /
  // btnResultsSettings) — ez teszi lehetővé, hogy két verseny közt (vagy már
  // csatlakozás UTÁN, rajt előtt) autót/pályát/fizikát váltsunk anélkül, hogy
  // ki kellene lépni a szobából és újra csatlakozni.
  let mpTrackName = '';
  let mpPhysicsName = DEFAULT_PHYSICS;
  let mpTrackListLoaded = false;

  onCarChanged = (i) => room.send('setCar', i);

  async function openMpSettings() {
    mpSettingsStatus.textContent = '';
    mpHostSettingsEl.style.display = isHost ? 'block' : 'none';
    updateCarPickButtons();
    if (isHost) {
      if (!mpTrackListLoaded) {
        mpTrackListLoaded = true;
        await loadTrackCatalog();
        // Preselect: a szoba JELENLEGI pályáját (mpTrackName, a szervertől)
        // keressük névre a katalógusban — ua. elv, mint korábban a <select>.
        const match = trackCatalog.find((t) => t.name === mpTrackName);
        mpSelectedTrackId = match ? match.id : '';
        mpSelectedTrackName = match ? match.name : 'Alap pálya';
      }
      updateMpTrackPickButton();
      mpLapsInput.value = String(mpTotalLaps);
      mpPhysicsSelect.value = mpPhysicsName;
    }
    mpSettingsEl.style.display = 'flex';
  }
  function closeMpSettings() {
    mpSettingsEl.style.display = 'none';
  }
  btnLobbySettings.onclick = openMpSettings;
  btnResultsSettings.onclick = openMpSettings;
  btnMpSettingsClose.onclick = closeMpSettings;

  btnMpApplySettings.onclick = async () => {
    if (!isHost) return;
    mpSettingsStatus.textContent = 'Alkalmazás…';
    btnMpApplySettings.disabled = true;
    try {
      const id = mpSelectedTrackId;
      let layout;
      let decorations;
      let trackName;
      if (id) {
        const t = await apiGetTrack(id);
        layout = t.layout;
        decorations = t.decorations;
        trackName = t.name;
      } else {
        layout = DEFAULT_LAYOUT;
        decorations = [];
        trackName = 'Alap pálya';
      }
      const n = parseInt(mpLapsInput.value, 10);
      room.send('hostSettings', {
        layout,
        decorations,
        trackName,
        laps: Number.isFinite(n) && n >= 1 && n <= 50 ? n : mpTotalLaps,
        physics: mpPhysicsSelect.value,
      });
    } catch (e) {
      mpSettingsStatus.textContent = `Nem sikerült a pálya betöltése: ${e.message || 'ismeretlen hiba'}`;
    } finally {
      btnMpApplySettings.disabled = false;
    }
  };

  // A host módosítást (vagy a saját magunk induló state-jét) MINDENKI innen
  // kapja — ha a pálya (layout) eltér a nálunk épp betöltöttől, ugyanaz a
  // ment+újratölt+visszalép mintát követjük, mint csatlakozáskor
  // (ensureTrackMatches) — a kör/fizika-váltás nem igényel reloadot.
  room.onMessage('roomSettings', (m) => {
    mpTrackName = m.trackName || mpTrackName;
    if (Number.isFinite(m.laps)) mpTotalLaps = m.laps;
    if (m.physics) {
      mpPhysicsName = applyPhysicsPreset(m.physics);
    }
    if (!ensureTrackMatches(m, room)) return; // reload indult — a többi felesleges
    mpSettingsStatus.textContent = 'Beállítások alkalmazva.';
  });

  room.onMessage('lobby', (m) => {
    isHost = m.hostId === myId;
    // Guestnek csak az autó-választás elérhető itt, a gomb felirata ezt tükrözze
    // (a host-specifikus vezérlők úgyis rejtve maradnak, lásd openMpSettings).
    const settingsLabel = isHost ? '⚙️ Autó / pálya / fizika' : '⚙️ Autó';
    btnLobbySettings.textContent = settingsLabel;
    btnResultsSettings.textContent = settingsLabel;
    roomPhase = m.phase;
    lobbyCodeEl.textContent = m.code;
    lobbyPlayersEl.innerHTML = '';
    for (const p of m.players) {
      const div = document.createElement('div');
      div.className = 'p';
      div.textContent = `${carIcon(p.colorIdx)} ${p.name}${p.id === m.hostId ? ' 👑' : ''}${p.id === myId ? ' (te)' : ''}`;
      lobbyPlayersEl.appendChild(div);
    }
    btnStart.style.display = isHost ? 'block' : 'none';
    lobbyStatus.textContent = isHost
      ? m.players.length > 1
        ? 'Indíthatod a versenyt!'
        : 'Várakozás a játékosokra… (egyedül is indíthatsz)'
      : 'Várakozás a hostra…';
    if (m.phase === 'lobby') lobbyEl.style.display = 'flex';
  });

  // A többi kocsit (és a fázist/visszaszámlálást) a snapshotból rendereljük; a
  // SAJÁT autónkat NEM innen (azt a helyi sim adja) — nincs szerver-korrekció.
  room.onMessage('snapshot', (s) => {
    buffer.push(s);
  });

  // Rajt: a szerver kiosztja a rajt-slotokat — a SAJÁT pozíciónkra állunk, és
  // nulláról indítjuk a helyi verseny-állapotot (a countdownt a szerver vezérli).
  room.onMessage('raceStart', (m) => {
    if (m.slots && m.slots[myId]) mySpawn = m.slots[myId];
    if (Number.isFinite(m.laps)) mpTotalLaps = m.laps;
    if (Number.isFinite(m.raceGen)) mpRaceGen = m.raceGen;
    // A TÖBBI játékos mesh-ét eldobjuk (a sajátunkat nem) — ha valaki két
    // verseny közt (lobby/finished állapotban) autót váltott, az `ensureMesh`
    // különben megtartaná a RÉGI modellt (csak ÚJ id-re tölt be, lásd ott),
    // így e nélkül a váltás csak a KÖVETKEZŐ szoba/rejoin után látszódna.
    for (const [id, mesh] of meshes.entries()) {
      if (id === myId) continue;
      scene.remove(mesh);
      meshes.delete(id);
      wheelAnims.delete(id);
      carEffects.remove(id);
    }
    // A TÁVOLI autók szimulált testét is a rajtrácsra tesszük (itt SZÁNDÉKOSAN
    // ugrunk — új verseny), különben az előző futam végállapotából indulnának,
    // és az első snapshotig rossz helyen látszanának.
    if (m.slots) {
      for (const [id, slot] of Object.entries(m.slots)) {
        if (id !== myId) remoteCars.placeAt(id, slot);
      }
    }
    mpResetForRace();
    carEffects.reset(); // friss pálya minden versenynél — mindenki nyoma törlődik
  });

  // Az init (pálya-adatok + a saját rajt-slot) a 'ready' üzenetünkre érkezik — ha a
  // szoba pályája eltér a lokálistól, ensureTrackMatches ment + újratölt (rejoin).
  room.onMessage('init', (init) => {
    if (Number.isFinite(init.laps)) mpTotalLaps = init.laps;
    mpTrackName = init.trackName || mpTrackName;
    if (init.slot) {
      mySpawn = init.slot;
      mpPlaceAtSpawn();
    }
    // A szoba fizikáját alkalmazzuk a HELYI simre (a host dönt, a szerver küldi).
    if (init.physics) mpPhysicsName = applyPhysicsPreset(init.physics);
    ensureTrackMatches(init, room);
  });

  btnStart.onclick = () => room.send('start');
  btnLeave.onclick = () => {
    room.leave();
    window.location.reload();
  };
  // CSALÁS MIATTI KIRÚGÁS: a szerver-oldali verseny-mérés (server/raceTracker.js)
  // fizikailag lehetetlen mozgást vagy köridőt észlelt. A szerver ELŐBB ezt az
  // üzenetet küldi, csak utána zárja a kapcsolatot — enélkül a játékos csak egy
  // néma szétkapcsolást látna, és hálózati hibának hinné. A `kicked` jelzőből az
  // onLeave tudja, hogy NE csendben újratöltsön: előbb elmondjuk, mi történt.
  let kickedReason = null;
  room.onMessage('kicked', (m) => {
    kickedReason = String(m?.reason || 'Szabálytalan játék.');
  });

  room.onLeave(() => {
    clearInterval(pingTimer);
    if (mode !== 'multi') return;
    if (kickedReason) {
      // Rendes játékbeli panel (nem böngésző-alert): a natív sáv kizökkent, nem
      // stílusozható, és mobilon különösen idegen. A reload-ot NEM itt végezzük —
      // a panel gombja indítja, hogy a játékos elolvashassa az indoklást.
      showKicked(kickedReason);
      return;
    }
    // Egyéb szerver-oldali bontás (pl. a szoba megszűnt) → vissza a menübe.
    window.location.reload();
  });

  onRestartClick = () => {
    if (isHost) room.send('start');
  };

  // Minden kezelő regisztrálva → most kérhetjük el az init-adatokat a szervertől.
  room.send('ready');

  // --- MP game loop: snapshot-interpoláció + kamera + HUD + input ---
  let lastCountInt = null;
  let lastPhase = 'lobby';
  let lastStandingsAt = 0;
  let wasBoostDenied = false; // lásd SP — csak új próbálkozásonként szóljon a hiba-hang
  lastTime = performance.now();

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    const sampled = buffer.sample();
    if (sampled) {
      roomPhase = sampled.phase;
      if (sampled.phase !== 'lobby') lobbyEl.style.display = 'none';

      removeStaleMeshes(sampled.players);
      for (const [id, p] of Object.entries(sampled.players)) {
        ensureMesh(id, p.colorIdx, p.name);
      }

      // --- HITELES ÁLLAPOT a távoli autókra (csak ÚJ snapshotnál) ---
      // A `sample()` (interpolált, múltbeli) adatot a HUD/állás/minitérkép
      // használja; a távoli autók MOZGÁSA viszont a helyi fizikai szimulációból
      // jön (remoteCars), amit itt igazítunk a hiteles állapothoz. Az `ageSec`
      // a JELENRE célzáshoz kell: a snapshot-időbélyeg a küldés pillanatáé, így
      // az adat ennyivel öreg (eltelt idő az érkezés óta + a fél RTT-nyi út).
      const latestT = buffer.latestT;
      const latest = buffer.latest;
      if (latest && latestT !== mpLastAuthT) {
        mpLastAuthT = latestT;
        const ageSec =
          Math.max(0, (buffer.serverNow() - latestT) / 1000) + mpHalfRttSec;
        const liveIds = new Set();
        for (const [id, p] of Object.entries(latest.players)) {
          if (id === myId) continue;
          liveIds.add(id);
          remoteCars.applyAuthoritative(id, p, ageSec);
        }
        remoteCars.pruneExcept(liveIds);
      }

      // --- SAJÁT autó: HELYI sim (kliens-autoritatív) ---
      const serverPhase = sampled.phase;
      // A SAJÁT szerver-oldali állapotunk a snapshotból: helyezés + a SZERVER által
      // mért kör-adatok (lásd server/raceTracker.js — a köridő hivatalos forrása).
      const me = sampled.players[myId];

      // A többi kocsi középpontjai a puha szétnyomáshoz — mostantól a HELYBEN
      // SZIMULÁLT testükből (jelen-idejű, pontos), nem az interpolált (múltbeli)
      // snapshotból. Így az ütközés-érzet is ott van, ahol az autót LÁTOD.
      mpPeerPoints = [];
      for (const id of Object.keys(sampled.players)) {
        if (id === myId) continue;
        const rs = remoteCars.renderState(id, 1);
        if (rs) mpPeerPoints.push({ x: rs.x, y: rs.y });
      }

      // A szerver countdown→racing váltásakor (egyszer) elindítjuk a helyi versenyt.
      if (serverPhase === 'racing' && !mpStartedRacing && mpRace.phase !== 'finished') {
        mpStartedRacing = true;
        mpRace.phase = 'racing';
        mpRace.time = 0;
        mpRace.lapStartTime = 0;
        mpPlaceAtSpawn();
      }

      const myFinished = mpRace.phase === 'finished';
      const racing = serverPhase === 'racing' && mpRace.phase === 'racing';
      const input = racing ? readInput() : NEUTRAL_INPUT;

      let alpha = 0;
      if (racing || myFinished) {
        alpha = mpStepper(
          mpWorld,
          dt,
          (fixedDt) => {
            if (myFinished) coastToStop(mpCar);
            else updateCar(mpCar, input, fixedDt, mpDrive, offRoadExcess);
            // Puha szétnyomás a többi kocsitól (a kapott pozíciók alapján).
            separateBodyFromPoints(mpCar, mpPeerPoints, RACE.carSeparation);
            // A TÁVOLI autók ugyanebben a lépésben, a VALÓDI fizikán, az általuk
            // küldött vezérléssel — ettől írnak igazi ívet és mozognak simán.
            remoteCars.step(fixedDt);
          },
          () => {
            mpPrev.x = mpCurr.x;
            mpPrev.y = mpCurr.y;
            mpPrev.angle = mpCurr.angle;
            const pp = mpCar.getPosition();
            mpCurr.x = pp.x;
            mpCurr.y = pp.y;
            mpCurr.angle = mpCar.getAngle();
            remoteCars.afterStep(SIM.fixedDt);
            if (mpRace.phase === 'racing') {
              const offTrack =
                isFullyOffRoad(mpCar, offRoadExcess) ||
                hitsCone(mpCar, mpConePoints, RACE.coneHitRadius);
              const mpRaceEvents = raceStep(mpRace, mpPrev, mpCurr, SIM.fixedDt, checkpoints, offTrack, trackHeadingAt);
              if (mpRaceEvents.some((e) => e.type === 'lap' || e.type === 'finish')) refillBoost(mpDrive);
            }
          }
        );
      } else if (serverPhase === 'countdown' || serverPhase === 'lobby') {
        // Rajt előtt parkolva a saját rajt-helyünkön (DNF/finished esetén marad ott).
        mpPlaceAtSpawn();
      }

      // Célba érés → azonnali (egyszeri) állapot-küldés, hogy a szerver mielőbb
      // megkapja a finished flaget (helyezés-sorrend + verseny-zárás).
      if (myFinished && !mpSentFinish) {
        mpSentFinish = true;
        mpLastStateSentAt = 0;
      }

      // A saját autó a HELYI simből renderelődik (al-lépés-interpolálva) — nincs
      // szerver-korrekció, tehát nincs "húzás".
      const ownX = lerp(mpPrev.x, mpCurr.x, alpha);
      const ownY = lerp(mpPrev.y, mpCurr.y, alpha);
      const ownA = lerpAngle(mpPrev.angle, mpCurr.angle, alpha);
      const myMesh = meshes.get(myId);
      if (myMesh) {
        myMesh.position.set(ownX, 0.12, ownY);
        myMesh.rotation.y = -ownA;
      }
      carWheels.update(forwardSpeed(mpCar), mpDrive.steer, dt);
      // Guminyom/porfelhő minden RENDERELT autóra — a sajátunkat rögtön
      // felvesszük, a távoliakat a lenti ciklusban a TÉNYLEGESEN kirajzolt
      // (esetleg szeparációval kitolt) pozíciójukkal egészítjük ki.
      const mpEffectsCars = [
        {
          id: myId,
          x: ownX,
          z: ownY,
          angle: ownA,
          lateralSpeed: lateralSpeed(mpCar),
          forwardSpeed: forwardSpeed(mpCar),
          corneringLoad: corneringLoad(mpCar),
          boosting: mpDrive.boosting,
        },
      ];

      // --- TÁVOLI autók renderelése a HELYBEN SZIMULÁLT testükből ---
      // (al-lépés-interpolálva, mint a sajátunk → ugyanolyan sima 60 Hz+).
      for (const id of Object.keys(sampled.players)) {
        if (id === myId) continue;
        const mesh = meshes.get(id);
        if (!mesh) continue;
        const rs = remoteCars.renderState(id, alpha);
        if (!rs) continue;
        let px = rs.x;
        let py = rs.y;
        // VIZUÁLIS meglökés: ha egy PEER a szeparációs küszöbnél közelebb kerül
        // a saját autómhoz (nekimentem), a RENDERJÉT kitoljuk a küszöbre — így
        // a te képernyődön azonnal látszik, hogy odébb csúszik, nem "szikla".
        const dx = px - ownX;
        const dy = py - ownY;
        const d = Math.hypot(dx, dy);
        const md = RACE.carSeparation.minDist;
        if (d > 1e-4 && d < md) {
          const k = md / d;
          px = ownX + dx * k;
          py = ownY + dy * k;
        }
        mesh.position.set(px, 0.12, py);
        mesh.rotation.y = -rs.angle;
        // A kerekek a VALÓDI kormányszögből (a szimulált drive.steer-ből) —
        // nem a korábbi, sebességből visszabecsült közelítésből.
        const anim = wheelAnims.get(id);
        if (anim) anim.update(forwardSpeed(rs.body), rs.steer, dt);
        mpEffectsCars.push({
          id,
          x: px,
          z: py,
          angle: rs.angle,
          lateralSpeed: lateralSpeed(rs.body),
          forwardSpeed: forwardSpeed(rs.body),
          corneringLoad: corneringLoad(rs.body),
          boosting: rs.boosting,
        });
      }
      carEffects.update(mpEffectsCars, dt, offRoadExcess);

      // Kamera a saját autón.
      if (window.__TOP) {
        camera.position.set(ownX, window.__TOP, ownY + 0.001);
        camera.lookAt(ownX, 0, ownY);
      } else {
        updateCamera(ownX, ownY, ownA, dt, mpDrive.boosting);
      }

      // HUD: a FUTÓ óra a helyi állapotból (azonnali, nincs hálózati késés), a
      // BEFEJEZETT körök adatai viszont a SZERVER méréséből (`me`, a snapshotból) —
      // a szerver mér hivatalosan (lásd server/raceTracker.js), és a ranglista is
      // azt kapja. Ha itt a helyi mérést mutatnánk, a HUD "Legjobb" értéke pár
      // század másodperccel eltérne a ranglistán látszó időtől, ami hibának tűnne.
      // Amíg nincs szerver-adat (első pillanatok), a helyi érték az átmeneti tartalék.
      const hudRace = {
        phase: myFinished ? 'finished' : serverPhase === 'racing' ? 'racing' : 'countdown',
        countdownLeft: sampled.countdownLeft,
        lap: me ? me.lap : mpRace.lap,
        time: mpRace.time,
        totalLaps: mpTotalLaps,
        lapStartTime: mpRace.lapStartTime,
        lastLapTime: me && me.lastLap != null ? me.lastLap : mpRace.lastLapTime,
        bestLapTime: me && me.bestLap != null ? me.bestLap : mpRace.bestLapTime,
        wrongWay: mpRace.wrongWay,
        lapValid: mpRace.lapValid,
        lastSplitDelta: mpRace.lastSplitDelta,
        lastSplitAt: mpRace.lastSplitAt,
        place: me ? me.place || null : null, // hányadikként értünk célba (szervertől)
        hideRestart: true, // MP-ben az újraindítás a végeredmény-panelen van
        boostRemaining: mpDrive.boostRemaining, // csak megjelenítéshez (hud.js)
      };
      updateHud(hudRace);
      minimap.draw(
        Object.entries(sampled.players).map(([id, p]) => {
          // MINDENKI a ténylegesen RENDERELT pozíciójáról — a sajátunk a helyi
          // simből, a többiek a helyben szimulált testükből (remoteCars). Így a
          // minitérkép pontosan azt mutatja, amit a 3D jelenetben látsz.
          const rs = id === myId ? null : remoteCars.renderState(id, alpha);
          return {
            x: id === myId ? ownX : rs ? rs.x : p.x,
            z: id === myId ? ownY : rs ? rs.y : p.y,
            color: carColor(p.colorIdx),
            isMe: id === myId,
          };
        })
      );

      // A saját állapot + VEZÉRLÉS bejelentése a szervernek (relay).
      mpSendState(now, input);

      const ownSpeed = speedKmh(mpCar);
      const ownCornering = myFinished ? 0 : corneringLoad(mpCar);
      if (speedEl) speedEl.textContent = `Sebesség: ${Math.round(ownSpeed)} km/h`;

      // Countdown-bipek a fázisból.
      if (serverPhase === 'countdown') {
        const c = Math.ceil(sampled.countdownLeft);
        if (c !== lastCountInt && c > 0) audio.beep(520, 0.16);
        lastCountInt = c;
      }
      if (lastPhase === 'countdown' && serverPhase === 'racing') audio.beep(880, 0.35);
      lastPhase = serverPhase;

      audio.update({
        speedKmh: ownSpeed,
        throttle: racing && input.up,
        corneringLoad: ownCornering,
        boosting: racing && mpDrive.boosting,
      });

      // "Nincs boost-üzemanyag" hiba-hang — lásd SP megjegyzése.
      const boostDenied = racing && input.boost && input.up && mpDrive.boostRemaining <= 0;
      if (boostDenied && !wasBoostDenied) audio.playBoostEmpty();
      wasBoostDenied = boostDenied;

      // Az állás-lista DOM-ját elég 4x/mp újraépíteni (60x/mp felesleges terhelés).
      if (now - lastStandingsAt > 250) {
        lastStandingsAt = now;
        updateStandings(sampled.players);
      }

      // Verseny vége → teljes végeredmény-panel; új verseny indításakor eltűnik.
      if (sampled.phase === 'finished') showResults(sampled.players);
      else hideResults();
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Élő állás-lista a jobb felső sarokban.
  function updateStandings(players) {
    const list = Object.entries(players)
      .map(([id, p]) => ({ ...p, id }))
      .sort((a, b) => {
        if (a.finished && b.finished) return a.totalTime - b.totalTime;
        if (a.finished) return -1;
        if (b.finished) return 1;
        // Kör + folytonos (ívhossz-arányos) pálya-progressz — NEM a durva checkpoint-
        // indexet (ncp) nézzük. Az ncp csak néhány milestone-ot ismer: ha két játékos
        // épp ugyanazt célozza, sorrendjük a régi kódban esetlegesen (tie-break)
        // dőlt el, akkor is, ha valójában jelentős távolság volt köztük — ez okozta,
        // hogy az állás néha megugrott/villogott, főleg a checkpointok köré eső
        // kanyaroknál, anélkül hogy a tényleges sorrend változott volna.
        return (b.lap + (b.progress || 0)) - (a.lap + (a.progress || 0));
      });

    // Időrés-becslés HOZZÁM képest: a pálya-menti TÁVOLSÁG-különbséget (körök +
    // folytonos progressz, a pálya hosszával szorozva) a SAJÁT aktuális
    // sebességemmel osztjuk el — "ilyen tempóban ennyi másodperc választ el
    // ettől a ponttól". Előttem álló = negatív, mögöttem = pozitív (a kért
    // előjel-konvenció). Csak akkor van értelme, ha SE én, SE ő nincs célban,
    // és van elég sebességem a becsléshez (kanyarban/álló helyzetben a nullához
    // közeli saját sebesség irreálisan nagy/végtelen réseket adna).
    const me = players[myId];
    const trackLen = trackState.trackLength;
    const mySpeedMs = me ? me.speed / 3.6 : 0;
    const myDist = me ? (me.lap - 1 + (me.progress || 0)) * trackLen : 0;
    const canEstimateGap = me && !me.finished && mySpeedMs > 2;

    standingsEl.style.display = roomPhase === 'lobby' ? 'none' : 'flex';
    standingsEl.innerHTML = list
      .map((p, i) => {
        const icon = carIcon(p.colorIdx);
        const info = p.finished
          ? `🏁 ${p.totalTime.toFixed(2)} s`
          : `${p.lap}/${mpTotalLaps}. kör`;
        // Legutóbbi kör + (ha van érvényes) legjobb kör — a snapshotból (lásd
        // RaceRoom.js broadcastSnapshot: lastLap/bestLap mezők).
        const lastLap = p.lastLap != null ? `Utolsó: ${fmtTime(p.lastLap)}` : '';
        const bestLap = p.bestLap != null ? `Legjobb: ${fmtTime(p.bestLap)}` : '';
        const laptimes = [lastLap, bestLap].filter(Boolean).join(' · ');
        const lapLine = laptimes ? `<div class="standingsLapTimes">${laptimes}</div>` : '';

        let gapHtml = '';
        if (p.id !== myId && !p.finished && canEstimateGap) {
          const pDist = (p.lap - 1 + (p.progress || 0)) * trackLen;
          const gapSec = (myDist - pDist) / mySpeedMs;
          const cls = gapSec < 0 ? 'gapAhead' : 'gapBehind';
          const sign = gapSec > 0 ? '+' : '';
          gapHtml = `<span class="standingsGap ${cls}">${sign}${gapSec.toFixed(1)}s</span>`;
        }

        return `<div>${i + 1}. ${icon} ${escapeHtml(p.name)}${gapHtml} — ${info}${lapLine}</div>`;
      })
      .join('');
  }

  if (import.meta.env.DEV) {
    window.__GAME = { camera, scene, audio, renderer, room, buffer, mpCar, mpRace, mpDrive, minimap, remoteCars, carEffects };
  }
}

async function doCreate() {
  menuStatus.textContent = 'Kapcsolódás a szerverhez…';
  try {
    const room = await createRoom({
      name: playerName(),
      layout: loadCustomLayout(),
      decorations: loadCustomDecorations(),
      laps: chosenLaps(),
      carIdx: selectedCar,
      physics: chosenPhysics(),
      trackName: getActiveTrackName() || 'Alap pálya',
    });
    startMultiplayer(room);
  } catch (e) {
    menuStatus.textContent = `Nem sikerült: ${e.message || 'a szerver nem elérhető'}`;
  }
}

async function doJoin(code) {
  if (!code.trim()) {
    menuStatus.textContent = 'Írd be a szoba-kódot!';
    return;
  }
  menuStatus.textContent = 'Csatlakozás…';
  try {
    const room = await joinRoom(code, { name: playerName(), carIdx: selectedCar });
    startMultiplayer(room);
  } catch (e) {
    menuStatus.textContent = `Nem sikerült: ${e.message || 'nincs ilyen szoba'}`;
  }
}

// Visszatérés egy pálya/fizika-váltás (vagy átmeneti hálózat-kiesés) miatti
// reload UTÁN — a SAJÁT, meglévő helyünkre `reconnect()`-elünk (nem új
// csatlakozás, lásd ensureTrackMatches/net/mpClient.js).
//
// TÖBBSZÖRÖS PRÓBÁLKOZÁS (élő hibajelentés: localhoston MŰKÖDIK, Railway-en
// mégis a menübe dobott pálya/autó-váltáskor). Ok: valós hálózaton a régi
// WebSocket lezárásának ÉSZLELÉSE a szerveren KÉSHET (a proxy nem azonnal jelzi
// a bontást), így amikor a gyorsan (cache-ből) újratöltött kliens reconnectel,
// a szerver MÉG NEM regisztrálta a `allowReconnection`-t → az ELSŐ reconnect
// "nincs ilyen reconnect-token"-nel elbukik, és a régi kód egyből a
// tartalék `doJoin`-ra, majd (ha az is hibázik) a menübe esett. Localhoston a
// bontás észlelése azonnali, ezért ott sosem jött elő. Megoldás: néhányszor
// ÚJRAPRÓBÁLJUK a reconnectet növekvő várakozással — mire a 2-3. próba fut, a
// szerver már regisztrálta a reconnect-lehetőséget (az ablak 60 s, bőven belefér).
async function doReconnect(token, fallbackCode) {
  menuStatus.textContent = 'Visszacsatlakozás…';
  const delaysMs = [0, 700, 1400, 2200, 3200, 4500, 6000, 8000];
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i]) await new Promise((r) => setTimeout(r, delaysMs[i]));
    try {
      const room = await reconnectRoom(token);
      startMultiplayer(room);
      return;
    } catch {
      menuStatus.textContent = `Visszacsatlakozás… (${i + 1})`;
    }
  }
  // Ha a reconnect végleg nem sikerül (a token tényleg lejárt / a szoba eltűnt),
  // friss csatlakozás a szoba-id-vel — ekkor új játékosként lépünk be (a
  // host-szerep elveszhet, de legalább nem ragadunk be a menüben, ha a szoba él).
  doJoin(fallbackCode);
}

// --- Indulás: rejoin / pending pálya-akció (reload után), vagy főmenü ---
// A teljes képernyő kérése (touch-eszközön) MINDIG a kattintás-eseményből,
// szinkron módon, MIELŐTT bármi async munka (pl. szerver-csatlakozás) elindulna
// — a böngésző csak közvetlenül egy felhasználói gesztusból engedi a kérést.
document.getElementById('btnSingle').onclick = () => {
  if (touch) requestFullscreen();
  playWithSelectedTrack('single');
};
document.getElementById('btnHotLap').onclick = () => {
  if (touch) requestFullscreen();
  playWithSelectedTrack('hotlap');
};
document.getElementById('btnCreate').onclick = () => {
  if (touch) requestFullscreen();
  playWithSelectedTrack('create');
};
document.getElementById('btnJoin').onclick = () => {
  if (touch) requestFullscreen();
  doJoin(document.getElementById('joinCode').value);
};

const rejoinRaw = sessionStorage.getItem('autos-jatek:mp-rejoin');
const pendingRaw = sessionStorage.getItem('autos-jatek:pending');
if (rejoinRaw) {
  // Multiplayer visszalépés a szoba pályájára váltó reload után — lehetőleg
  // reconnectionToken-nel (a SAJÁT helyünkre, lásd doReconnect), ha az valamiért
  // hiányzik (régebbi/sérült sessionStorage-bejegyzés), sima kóddal csatlakozunk.
  sessionStorage.removeItem('autos-jatek:mp-rejoin');
  const { code, name, reconnectionToken } = JSON.parse(rejoinRaw);
  nameInput.value = name;
  if (reconnectionToken) doReconnect(reconnectionToken, code);
  else doJoin(code);
} else if (pendingRaw) {
  // A menüben választott pálya alkalmazása utáni reload — a config.js már az új
  // pályával épült, most lefuttatjuk a halasztott akciót.
  sessionStorage.removeItem('autos-jatek:pending');
  const { action, name } = JSON.parse(pendingRaw);
  nameInput.value = name;
  if (action === 'single') startSingleplayer();
  else if (action === 'hotlap') startSingleplayer(true);
  else doCreate();
} else {
  menuEl.style.display = 'flex';
  initTrackSelection();
}
requestAnimationFrame(idleFrame);
