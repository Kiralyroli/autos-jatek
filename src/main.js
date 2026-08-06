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
import { createRaceState, raceStep, segmentsCross, updatePitStop, isInPitLane, pitLaneReady, pitBoxForSlot } from './sim/race.js';
import { createKeyboard, NEUTRAL_INPUT, encodeInput } from './input.js';
import { isTouchDevice, createTouchControls, requestFullscreen } from './touchControls.js';
import { createScene3D, setCarModel, applyTexture, loadTrackTiles } from './render3d/scene.js';
import { loadTrackRibbon } from './render3d/trackRibbon.js';
import { loadDecorations } from './render3d/decorations.js';
import { addGrassField } from './render3d/grassField.js';
import { loadModel, loadTexture, loadModelTexture, fitCarModel } from './render3d/assets.js';
import { setupWheels } from './render3d/wheels.js';
import { createCarEffects } from './render3d/carEffects.js';
import { createNameplate, nameplateOpacityForDistance } from './render3d/nameplate.js';
import { createPitMarker, updatePitMarker, setMyBoxIndex } from './render3d/pitMarker.js';
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
  loadPitLane,
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
  apiGetGhost,
} from './net/leaderboardApi.js';
import { hashLayout } from './sim/trackKey.js';
import { TRACK, CAR, CARS, DEFAULT_LAYOUT, applyPhysicsPreset, DEFAULT_PHYSICS, PHYSICS_PRESETS } from './config.js';
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

// Ghost car (Hot Lap) kinézete: a JELENLEG választott autómodell, csak
// áttetszőre és halvány lilásra színezve — nem a rekord-tulajdonos autóját
// próbáljuk visszaadni (a ranglista nem tárolja, melyik autóval futotta),
// ez itt tisztán VIZUÁLIS jelzés, hogy "ez egy szellem, nem egy másik élő
// versenyző". `depthWrite:false`, hogy áttetsző rétegek (pl. szélvédő) ne
// takarják ki egymást hibásan.
function tintGhostHolder(holder) {
  holder.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.transparent = true;
      m.opacity = 0.4;
      m.depthWrite = false;
      if (m.color) m.color.lerp(new THREE.Color(0xa678e0), 0.55); // --purple, lásd index.html HUD-paletta
    }
  });
  return holder;
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
  loadTrackRibbon(scene, trackState.track, trackState.roadHalf, loadPitLane());
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
const speedNumEl = document.getElementById('speedNum');

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

// Jobb felső "i" gomb — az irányítás-segédletet (#hud, lásd hud.js-től
// független, mert versenymódtól függetlenül elérhető) nyitja/zárja. A
// megjelenítést a startSingleplayer/MP-indítás kapcsolja be (lásd lent, a
// minimap.style.display mellett) — csak verseny közben van értelme.
const hudLegendEl = document.getElementById('hud');
const infoBtnEl = document.getElementById('infoBtn');
infoBtnEl.addEventListener('click', () => {
  const open = hudLegendEl.classList.toggle('open');
  infoBtnEl.classList.toggle('active', open);
});

// --- "R" gomb HOSSZAN nyomva = gyors újraindítás egérhez nyúlás nélkül ---
// Amelyik reset-gomb ÉPP LÁTHATÓ (Hot Lapben a #hotlapReset, célba érés után
// a #restart), azt "kattintjuk meg" programozottan — a hud.js-ben MÁR bekötött
// click-figyelőket (onHotlapResetClick/onRestartClick) hívja, nincs duplikált
// logika. RÖVID megnyomás szándékosan NEM elég, hogy egy véletlen billentyű-
// koccanás közepén egy futó (esetleg rekordkísérlet) kör ne vesszen el.
const RESET_HOLD_MS = 550;
document.documentElement.style.setProperty('--reset-hold-ms', `${RESET_HOLD_MS}ms`);
let resetHoldTimer = null;
let resetHoldBtn = null;

function activeResetButton() {
  const hot = document.getElementById('hotlapReset');
  if (hot && getComputedStyle(hot).display !== 'none') return hot;
  const restart = document.getElementById('restart');
  if (restart && getComputedStyle(restart).display !== 'none') return restart;
  return null;
}
function cancelResetHold() {
  if (resetHoldTimer) clearTimeout(resetHoldTimer);
  resetHoldTimer = null;
  if (resetHoldBtn) resetHoldBtn.classList.remove('holding');
  resetHoldBtn = null;
}
window.addEventListener('keydown', (e) => {
  // e.repeat: a lenyomva tartás automatikus ismétlő keydown-jait a böngésző
  // küldi — enélkül minden ismétlésnél újraindulna a számláló, sosem érné el a
  // küszöböt.
  if (e.code !== 'KeyR' || e.repeat || resetHoldTimer) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // ne zavarjon be gépelés közben
  const btn = activeResetButton();
  if (!btn) return;
  resetHoldBtn = btn;
  // Force-reflow, hogy a width:0% biztosan alkalmazódjon a .holding hozzáadása
  // ELŐTT — enélkül a böngésző néha összevonja a két stílusváltást, és a sáv
  // rögtön 100%-ról indulna animáció helyett.
  btn.classList.remove('holding');
  void btn.offsetWidth;
  btn.classList.add('holding');
  resetHoldTimer = setTimeout(() => {
    btn.click();
    cancelResetHold();
  }, RESET_HOLD_MS);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyR') cancelResetHold();
});
window.addEventListener('blur', cancelResetHold);

// --- Menü / lobby DOM ---
const menuEl = document.getElementById('menu');
const lobbyEl = document.getElementById('lobby');
const standingsEl = document.getElementById('standings');
const nameInput = document.getElementById('playerName');
const menuStatus = document.getElementById('menuStatus');
const lobbyStatus = document.getElementById('lobbyStatus');

const lapsInput = document.getElementById('lapsInput');
const physicsSelect = document.getElementById('physicsSelect');
const pitStopInput = document.getElementById('pitStopRequired');
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
const carPickMeta = document.getElementById('carPickMeta');
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
const trackPickMeta = document.getElementById('trackPickMeta');
const btnMpPickTrack = document.getElementById('btnMpPickTrack');
const mpTrackPickCanvas = document.getElementById('mpTrackPickCanvas');
const mpTrackPickName = document.getElementById('mpTrackPickName');

// --- Multiplayer beállítások panel (autó BÁRKI, pálya/körök/fizika a host) —
// a lobbiból ÉS a végeredmény-panelről is előhozható (lásd startMultiplayer). ---
const mpSettingsEl = document.getElementById('mpSettings');
const mpHostSettingsEl = document.getElementById('mpHostSettings');
const mpLapsInput = document.getElementById('mpLapsInput');
const mpPhysicsSelect = document.getElementById('mpPhysicsSelect');
const mpPitStopInput = document.getElementById('mpPitStopRequired');
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
  const idx = selectedCar % CARS.length;
  const c = CARS[idx];
  carPickThumb.src = withBase(c.preview);
  carPickName.textContent = c.name;
  // Meta-sor a hero-kártyán a név alatt (a pálya-kártya hossz/rekord sorának
  // párja) — itt a listabeli hely, hogy látszódjon, mekkora a választék.
  if (carPickMeta) carPickMeta.textContent = `${c.icon} ${idx + 1}. a ${CARS.length} autóból`;
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
// A `selectedTrackId === ''` ÖNMAGÁBAN kétértelmű: vagy a felhasználó TÉNYLEG
// az "Alap pálya" kártyát választotta a rács-választóban, VAGY egyszerűen
// nincs katalógus-egyezés az aktív (localStorage) egyedi pályára — pl. mert a
// szerkesztőben NÉV NÉLKÜL mentett ("Mentés és játék"), tehát sosem került
// fel a szerverre (lásd initTrackSelection). Élő hibajelentés: ez utóbbi
// esetben a régi kód playWithSelectedTrack-ban TÖRÖLTE a friss, még be sem
// mutatott egyedi pályát (layout+dekoráció+boxutca), mert a törés-ágat
// (`clearCustomLayout()`) az `id` puszta hiánya váltotta ki. Ez a flag csak
// akkor igaz, ha a felhasználó VALÓBAN a rács "Alap pálya" kártyájára
// kattintott — csak EKKOR szabad ténylegesen törölni.
let explicitBaseTrackChosen = false;
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

// ÉLŐ HIBAJELENTÉS: "néha a ranglista/köridő-mentés az Alap pályára esik
// vissza, pedig egyedi pályán vagyok". A gyökér-ok EZ a függvény volt: sikertelen
// lekérésnél korábban `trackCatalog = []`-t állított — az `[]` viszont IGAZ
// értékű, ezért a fenti `if (trackCatalog) return trackCatalog;` a KÖVETKEZŐ
// hívásnál rögtön visszaadta ezt az üres tömböt, ÚJRAPRÓBÁLKOZÁS NÉLKÜL, a
// session hátralévő részére. Egyetlen átmeneti hálózati hiba (pl. "kihűlt"
// Railway-szerver — lásd a köridő-beküldés retry-backoff megjegyzését lentebb)
// tehát VÉGLEGESEN üresre zárta a katalógust: a `findCatalogEntry(selectedTrackId)`
// utána sosem találta meg az egyedi pályát, és a `currentTrackInfo()` a
// `hashLayout(DEFAULT_LAYOUT)`-ra esett vissza — MIND a ranglista-lekérésnél,
// MIND a köridő-beküldésnél. A 3D pálya maga eközben helyesen futott (az a
// config.js induláskori, localStorage-alapú betöltéséből jön, FÜGGETLEN ettől
// a katalógustól) — ezért tűnt úgy, mintha "minden jó, csak a mentés rossz".
// Most: siker esetén cache-elünk (mint eddig), hiba esetén NEM — a következő
// hívás (pl. a következő menü-megnyitás) újra megpróbálja.
async function loadTrackCatalog() {
  if (trackCatalog) return trackCatalog;
  try {
    trackCatalog = await apiListTracks();
    return trackCatalog;
  } catch {
    return []; // csak ERRE a hívásra — a katalógus MARAD null, legközelebb újra próbálkozunk
  }
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
  // A VISSZATÉRÉSI értéket használjuk, NEM a modul-szintű trackCatalog-ot —
  // sikertelen lekérésnél a kettő eltér (lásd loadTrackCatalog megjegyzését):
  // a modul-változó ilyenkor SZÁNDÉKOSAN marad üres (null), hogy legközelebb
  // újrapróbálkozzon, a visszatérési érték viszont mindig biztonságos tömb.
  const catalog = await loadTrackCatalog();
  const currentId = target === 'mp' ? mpSelectedTrackId : selectedTrackId;
  const entries = [{ id: '', name: 'Alap pálya (beépített)' }, ...catalog];
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
        explicitBaseTrackChosen = t.id === ''; // lásd a deklaráció megjegyzését
        clearGhostSelection(); // más pálya = más koordináták, a régi ghost értelmetlen lenne
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

// A pálya hero-kártya meta-sora: "1840 m · rekord 0:52.10". A két adat KÉT
// külön forrásból, más-más időben érkezik (a hossz a pálya középvonalából
// számolva, a rekord a ranglista-lekérésből), ezért mindkettő egy-egy modul-
// szintű változóba kerül, és ez a függvény rakja össze, amelyik épp megvan.
let selectedTrackLengthM = null;
let selectedTrackRecord = null;

function renderTrackMeta() {
  if (!trackPickMeta) return;
  const parts = [];
  if (selectedTrackLengthM != null) parts.push(`${Math.round(selectedTrackLengthM)} m`);
  parts.push(selectedTrackRecord != null ? `rekord ${fmtTime(selectedTrackRecord)}` : 'nincs még rekord');
  trackPickMeta.textContent = parts.join(' · ');
}

// A pálya hossza a KÖZÉPVONAL zárt poligonjának kerülete (a mintapontok közti
// húrok összege) — ugyanaz a görbe, amiből a minitérkép/thumbnail is rajzol.
function trackLengthFromCenter(center) {
  if (!center || center.length < 2) return null;
  let len = 0;
  for (let i = 0; i < center.length; i++) {
    const a = center[i];
    const b = center[(i + 1) % center.length]; // zárt kör: az utolsó→első is számít
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

function updateTrackPickButton() {
  trackPickName.textContent = selectedTrackName;
  selectedTrackLengthM = null;
  renderTrackMeta();
  getTrackCenter(selectedTrackId).then((center) => {
    drawTrackThumb(trackPickCanvas, center);
    // Időközben másik pályára válthatott a felhasználó — az elavult választ eldobjuk.
    if (trackPickName.textContent !== selectedTrackName) return;
    selectedTrackLengthM = trackLengthFromCenter(center);
    renderTrackMeta();
  });
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
if (pitStopInput) pitStopInput.checked = localStorage.getItem('autos-jatek:pitStopRequired') === '1';
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
// Kötelező kerékcsere kapcsoló (a menü checkboxából) — perzisztálva, mint laps/
// physics. Csak akkor jelent bármit, ha a választott pályán VAN is legalább
// 2 pontos boxutca-útvonal (lásd trackStorage.js loadPitLane) — enélkül a cél
// sosem zárulna le, ezért a hívók (startSingleplayer/doCreate) mindig ÉS-elik
// az útvonal meglétével.
function chosenPitStopRequired() {
  const on = !!(pitStopInput && pitStopInput.checked);
  localStorage.setItem('autos-jatek:pitStopRequired', on ? '1' : '0');
  return on;
}

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
  // Ez a hívás dönti el a TELJES session pálya-kiválasztását — ha itt a
  // katalógus-lekérés elbukik (pl. "kihűlt" Railway-szerver épp induláskor),
  // a régi kód CSENDBEN "Alap pálya"-ra váltott, akkor is, ha a játékos
  // valójában egy egyedi pályán állt (a 3D jelenet ettől függetlenül helyesen
  // futott tovább, lásd loadTrackCatalog megjegyzését) — ez okozta, hogy a
  // ranglista/köridő-mentés "néha" rossz pályára ment. Néhány gyors
  // újrapróbálkozás (rövid, növekvő várakozással) egy egyszeri hálózati
  // döccenőt átvisz anélkül, hogy a játékos ezt észrevenné.
  const activeName = getActiveTrackName();
  let catalog = await loadTrackCatalog();
  // Csak akkor éri meg újrapróbálkozni, ha VAN mit keresni benne (a játékos
  // előzőleg egy egyedi pályán állt) ÉS a katalógus üresen jött vissza —
  // egy valóban üres szerver-tár (nincs mentett egyedi pálya) esetén ez
  // ugyanígy üres lenne, ott a próbálkozás felesleges várakozás lenne.
  for (let attempt = 0; activeName && catalog.length === 0 && attempt < 2; attempt++) {
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    catalog = await loadTrackCatalog();
  }
  const match = activeName ? catalog.find((t) => t.name === activeName) : null;
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

// =============================================================================
//  GHOST CAR (Hot Lap) — egy KIVÁLASZTOTT ranglista-bejegyzés rögzített körét
//  jelenítjük meg átlátszó autóként, a saját köridőnkkel szinkronban. Az
//  ADATOT (a "hogyan mentsük el pontosan ugyanazt" kérdésre) NEM bemenet-
//  visszajátszással oldjuk meg (az a Planck.js lebegőpontos determinizmusára
//  bízná magát — kockázatos egy 10-60 s-os körön felhalmozódó eltéréssel),
//  hanem közvetlen (x, y, angle) POZÍCIÓ-mintavétellel, GHOST_SAMPLE_HZ
//  rátán — ez garantáltan ugyanazt mutatja, ami valójában történt, és a
//  visszajátszás is csak egyszerű keret-interpoláció (lásd setupGhostPlayback
//  a startSingleplayer hotLap ágában), nem újra-szimuláció.
// =============================================================================
const GHOST_SAMPLE_STRIDE = 3; // fixedDt=1/60 mellett 3 lépésenként → 20 Hz
const GHOST_SAMPLE_HZ = 60 / GHOST_SAMPLE_STRIDE;

// A jelenleg kiválasztott ghost forrás-játékosa + a letöltött mintasora — a
// KIVÁLASZTÁS a menüben ÉS Hot Lap közben is elérhető (lásd paintLeaderboardEntries
// 👻 gombja), a TÉNYLEGES lejátszás csak akkor történik, ha épp fut egy Hot Lap
// (lásd startSingleplayer). Track/fizika-váltáskor törlődik (lásd lejjebb), mert
// egy másik pálya ghost-koordinátái értelmezhetetlenek lennének az újon.
let selectedGhostPlayerName = null;
let activeGhostSamples = null;

async function selectGhost(playerName) {
  if (selectedGhostPlayerName === playerName) {
    // Újra ugyanarra kattintva — kikapcsolás.
    selectedGhostPlayerName = null;
    activeGhostSamples = null;
    renderLeaderboard();
    return;
  }
  const { trackKey } = currentTrackInfo();
  const samples = await apiGetGhost(trackKey, chosenPhysics(), playerName);
  if (!samples) return; // 404/hálózati hiba — marad az eddigi kiválasztás
  selectedGhostPlayerName = playerName;
  activeGhostSamples = samples;
  renderLeaderboard();
}

// Track/fizika-váltáskor a kiválasztott ghost ÉRTELMÉT VESZTI (más pálya
// koordinátái) — ezt hívja meg a physicsSelect 'change' figyelője és a
// pálya-választó kártya kattintása (lásd lejjebb).
function clearGhostSelection() {
  selectedGhostPlayerName = null;
  activeGhostSamples = null;
}

// Egy ranglista-lista kirajzolása egy adott elembe — a menü sidepanelje ÉS a
// Hot Lap oldali panel (raceLeaderboardListEl) is EZT hívja, azonos adatból
// (lásd renderLeaderboard), hogy ne kelljen a köridőt kétszer lekérni.
// A törlés-gomb (dev mód) csak ott jelenik meg, ahol `allowDelete` igaz — a
// race-panel tisztán megjelenítő, versenyközben nincs értelme törlőgombnak.
// A ghost-gomb (👻) fordítva: csak ott, ahol `allowGhost` igaz — a ghost autó
// KIZÁRÓLAG Hot Lap KÖZBEN jelenik meg a pályán (lásd startSingleplayer), a
// főmenüben a kiválasztásnak még nincs mit megjelenítenie, csak zavaró lenne.
function paintLeaderboardEntries(el, entries, dev, allowDelete, allowGhost) {
  if (entries.length === 0) {
    el.innerHTML = '<p>Még nincs rögzített köridő ehhez a pályához.</p>';
    return;
  }
  el.innerHTML = entries
    .map((e, i) => `
      <div class="lbRow${allowGhost && e.playerName === selectedGhostPlayerName ? ' ghostActive' : ''}">
        <span class="lbPos">${i + 1}.</span>
        <span class="lbName">${escapeHtml(e.playerName)}</span>
        <span class="lbTime">${fmtTime(e.lapTime)}</span>
        ${allowGhost && e.hasGhost ? `<button class="lbGhost" data-name="${escapeHtml(e.playerName)}" title="Ghost autó ehhez a körhöz">👻</button>` : ''}
        ${dev && allowDelete ? `<button class="lbDel" data-name="${escapeHtml(e.playerName)}">✕</button>` : ''}
      </div>
    `)
    .join('');
  if (allowGhost) {
    el.querySelectorAll('.lbGhost').forEach((btn) => {
      btn.onclick = () => selectGhost(btn.dataset.name);
    });
  }
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

  // A pálya-rekord a lista ELSŐ eleme (a szerver idő szerint rendezve adja
  // vissza) — ez megy a pálya hero-kártya meta-sorába is.
  selectedTrackRecord = entries.length > 0 ? entries[0].lapTime : null;
  renderTrackMeta();

  paintLeaderboardEntries(leaderboardListEl, entries, dev, true, false);
  paintLeaderboardEntries(raceLeaderboardListEl, entries, dev, false, true);
}

physicsSelect.addEventListener('change', () => {
  clearGhostSelection(); // más fizika = más köridők/ghostok, a régi kiválasztás nem passzol
  renderLeaderboard();
});
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
      setActiveTrack(t.name, t.layout, t.decorations, t.pitLane, editorView);
    } else if (explicitBaseTrackChosen) {
      clearCustomLayout(); // a felhasználó TÉNYLEG az "Alap pálya" kártyát választotta
    }
    // Ha `id` üres, de a felhasználó NEM választotta explicit az "Alap
    // pályát" (pl. a szerkesztőben most mentett egy név nélküli egyedi
    // pályát, ami emiatt nincs a katalógusban) — a jelenleg AKTÍV
    // localStorage-pálya marad érintetlen, lásd a flag megjegyzését.
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

// A boxutcában (ha van a pályán) valós versenyekhez hasonló sebességkorlát
// érvényes — FÜGGETLENÜL attól, hogy a "Kötelező kerékcsere" be van-e
// kapcsolva (lásd config.js RACE.pitStop.maxLaneSpeed). A boost SEM léphet
// túl rajta (boostMaxSpeedMultiplier: 1) — a boxutcában a korlát abszolút.
// `undefined`-et ad vissza a lane-en KÍVÜL, hogy a hívó (sim/car.js updateCar)
// a saját alapértelmezett (CAR) paramétereire essen vissza.
function carParamsFor(x, y, pitLanePoints) {
  // offRoadExcess átadva: a bekötési pontoknál (a boxutca kezdete/vége) a
  // lane-tűrés NE terjedjen át a rendes pálya aszfaltjára (lásd isInPitLane).
  if (!pitLanePoints || pitLanePoints.length < 2 || !isInPitLane(x, y, pitLanePoints, offRoadExcess)) return undefined;
  return { ...CAR, maxForwardSpeed: RACE.pitStop.maxLaneSpeed, boostMaxSpeedMultiplier: 1 };
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
  infoBtnEl.style.display = 'flex';
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

  // Kötelező kerékcsere: csak akkor "él", ha a pályán TÉNYLEG van boxutca-
  // útvonal ÉS kijelölt boxhely (lásd sim/race.js pitLaneReady/updatePitStop)
  // — Hot Lapben nincs értelme (a menü fieldPitStop ott is rejtve van, lásd
  // MENU_MODES).
  const pitLanePoints = loadPitLane();
  const pitStopRequired = !hotLap && chosenPitStopRequired() && pitLaneReady(pitLanePoints);
  // Egyjátékosban mindig a 0. (első kijelölt) boxhely a sajátunk — nincs
  // "más játékos", akivel osztozni kellene rajta.
  const myPitBox = pitBoxForSlot(pitLanePoints, 0);
  // Vizuális jelölés a boxutca-útvonalon (minden boxhely rácsa + a SAJÁT
  // helyünk fölött lebegő "BOX" felirat) — csak akkor jön létre, ha TÉNYLEG
  // kötelező, és amíg nem teljesült, a frame() ciklus animálja/mutatja (lásd
  // lejjebb); utána elrejtjük.
  const pitMarker = pitStopRequired ? createPitMarker(pitLanePoints, 0) : null;
  if (pitMarker) scene.add(pitMarker.group);

  // Hot Lap: a rajtvonaltól hátrébb (guruló rajt) — lásd sim/trackFactory.js
  // pointBeforeStart. Normál módban ez egyszerűen a rajtvonal (spawn).
  const startPoint = hotLap ? trackState.pointBeforeStart(RACE.hotlapRunupMeters) : spawn;

  const world = createWorld();
  const carBody = createCarBody(world, startPoint.x, startPoint.y, startPoint.angle);
  const stepper = createStepper();
  const laps = chosenLaps();
  const race = createRaceState(hotLap ? Infinity : laps, pitStopRequired);
  race.isHotLap = hotLap; // csak megjelenítéshez (hud.js) — a raceStep nem használja
  const drive = createDriveState();
  // Guruló rajtnál a TÉNYLEGES rajtvonal első átszeléséig a köridő nem indul —
  // a raceStep ezt a crossingot magától is figyelmen kívül hagyja (nextCheckpoint=1,
  // a 0. checkpoint kívül esik a lookahead-ablakán), itt csak ÉSZLELJÜK, és
  // onnantól nullázzuk az órát, hogy a mért kör valódi "flying lap" legyen.
  let hotLapArmed = hotLap;

  const prev = { x: startPoint.x, y: startPoint.y, angle: startPoint.angle };
  const curr = { x: startPoint.x, y: startPoint.y, angle: startPoint.angle };

  // --- Ghost car FELVÉTEL (Hot Lap) — lásd a paintLeaderboardEntries feletti
  // fejléc-megjegyzést a "miért pozíció, nem input-visszajátszás" döntésről.
  // `currentLapGhost`: az ÉPPEN futó (mért) kör eddigi mintái. `pendingGhostSamples`:
  // a legutóbbi ÉRVÉNYES, ÚJ REKORD kör TELJES mintasora — ez megy a szerverre a
  // köridővel együtt (lásd lejjebb a submit-blokkban).
  let ghostStepCounter = 0;
  let currentLapGhost = [];
  let pendingGhostSamples = null;
  // Ghost car MEGJELENÍTÉS: a kiválasztott (más játékos) rekord-köre, lásd
  // selectGhost/activeGhostSamples fentebb — a mesh csak Hot Lapben létezik.
  let ghostGroup = null;
  if (hotLap) {
    (async () => {
      const car = CARS[selectedCar % CARS.length];
      const model = await loadModel(car.model);
      const holder = tintGhostHolder(buildCarHolder(car, model));
      holder.visible = false;
      scene.add(holder);
      ghostGroup = holder;
    })();
  }

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
    // magának nem esemény, csak nekünk jelzi, hogy innentől "éles" a kör. A
    // boost is itt tölt újra: a guruló rajt szakaszán (a rajtvonalig hátrébb
    // eső résztől) elhasznált üzemanyag NE vigyük át a mért körbe.
    if (hotLapArmed && segmentsCross(prev, curr, checkpoints[0].a, checkpoints[0].b)) {
      hotLapArmed = false;
      race.time = 0;
      race.lapStartTime = 0;
      race.lapValid = true; // a guruló-rajt szakasza (letérés, sarok) ne rontsa el az ELSŐ mért kört
      race.currentSplits = [];
      refillBoost(drive);
    }
    // A TELJES autó elhagyta a pályát, VAGY terelőkúpnak ütközött → a kör érvénytelen.
    const offTrack =
      isFullyOffRoad(carBody, offRoadExcess) || hitsCone(carBody, conePoints, RACE.coneHitRadius);
    // Kötelező kerékcsere haladása — a raceStep MELLETT, ugyanabból a friss
    // pozícióból/sebességből (lásd sim/race.js updatePitStop).
    const carVel = carBody.getLinearVelocity();
    updatePitStop(race, curr.x, curr.y, Math.hypot(carVel.x, carVel.y), myPitBox, SIM.fixedDt);
    const raceEvents = raceStep(race, prev, curr, SIM.fixedDt, checkpoints, offTrack, trackHeadingAt);
    // Amíg a guruló rajt tart (a countdown már lezajlott, phase='racing', de a
    // rajtvonalat MÉG nem értük el), a raceStep MAGÁTÓL is méri az időt (a
    // GO!/visszaszámlálás emiatt fut normálisan) — a KIJELZETT köridőt viszont
    // (race.time - race.lapStartTime, lásd hud.js) 0-n tartjuk azzal, hogy
    // lapStartTime-ot minden képkockában time-ra csúsztatjuk. Enélkül a
    // számláló felfutott a guruló szakaszon, majd a vonalnál visszaugrott
    // 0-ra — úgy tűnt, mintha az időmérés a vonal ELŐTT elindulna.
    if (hotLapArmed) race.lapStartTime = race.time;
    // Boost-üzemanyag újratöltése minden körváltásnál (és célba éréskor) —
    // lásd config.js BOOST.maxPerLap / sim/car.js refillBoost.
    if (raceEvents.some((e) => e.type === 'lap' || e.type === 'finish')) refillBoost(drive);

    // Ghost car felvétel: csak a TÉNYLEGES, mért kör alatt mintavételezünk
    // (guruló rajton nem — az nem része a körnek). GHOST_SAMPLE_STRIDE
    // lépésenként egy minta (lásd a konstans megjegyzését) — a curr itt MÁR a
    // frissített pozíció, ugyanaz, amit raceStep is épp most használt. NEM csak
    // Hot Lapben: normál egyjátékos versenyben is felvesszük (Hot Lapnél
    // `hotLapArmed` a rajtvonalig igaz, normál versenynél viszont sosem — lásd
    // `let hotLapArmed = hotLap;` — tehát `!hotLapArmed` itt magától is helyes
    // mindkét módra). A LEJÁTSZÁS (ghostGroup) viszont továbbra is Hot Lap-only,
    // lásd lejjebb a frame()-ben — normál versenyben csak MENTJÜK, nem mutatjuk.
    if (!hotLapArmed) {
      ghostStepCounter++;
      if (ghostStepCounter >= GHOST_SAMPLE_STRIDE) {
        ghostStepCounter = 0;
        currentLapGhost.push([
          Math.round(curr.x * 100) / 100,
          Math.round(curr.y * 100) / 100,
          Math.round(curr.angle * 100) / 100,
        ]);
      }
      // A 'finish' esemény (normál verseny UTOLSÓ köre) is kör-lezárás — ha csak
      // 'lap'-ot néznénk, egy záró, épp leggyorsabb kör ghostja sose mentődne el
      // (a raceStep a lastLapTime/lastLapValid/bestLapTime mezőket MINDKÉT
      // esetben ugyanúgy frissíti a event-küldés előtt, lásd sim/race.js — ezért
      // ezeket olvassuk az eseményen lévő mezők helyett, mindkét típusra egyformán).
      const lapDone = raceEvents.some((e) => e.type === 'lap' || e.type === 'finish');
      if (lapDone) {
        // Csak ÉRVÉNYES és ÚJ REKORD kör ghostja kerül beküldésre — egy lassabb
        // (akár érvényes) kör ghostja félrevezető lenne a ranglistán a köridő mellett.
        if (race.lastLapValid && Math.abs(race.bestLapTime - race.lastLapTime) < 1e-6) {
          pendingGhostSamples = currentLapGhost;
        }
        currentLapGhost = [];
        ghostStepCounter = 0;
      }
    }

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
      // pendingGhostSamples EBBEN a pillanatban a timeToSubmit-hez tartozó kör
      // felvétele (a kettő UGYANANNÁL a 'lap' eseménynél frissül együtt — lásd
      // recordState) — később, ha időközben egy MÉG jobb kör születne, mindkettő
      // együtt lép tovább, sosem térnek el egymástól. Normál versenyben is megy
      // (nem csak Hot Lapben) — csak a MEGJELENÍTÉS Hot Lap-only, a mentés nem.
      const ghostToSubmit = pendingGhostSamples;
      // A modul-szintű pendingLapSubmission-be is elmentjük — a "← Főmenü"
      // gomb ezt várja meg, mielőtt reload-olna (lásd ott a megjegyzést).
      pendingLapSubmission = apiSubmitLap({
        trackKey,
        trackName,
        physics: physicsName,
        playerName: playerName(),
        lapTime: timeToSubmit,
        ghost: ghostToSubmit,
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
    Object.assign(race, createRaceState(laps, pitStopRequired));
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
    // A folyamatban lévő (be nem fejezett) kör felvétele eldobandó — lásd
    // ugyanezt onHotlapResetClick-nél.
    currentLapGhost = [];
    ghostStepCounter = 0;
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
      // A folyamatban lévő (be nem fejezett) kör felvétele eldobandó — a
      // pendingGhostSamples (a legutóbbi KÉSZ rekord-kör) viszont megmarad,
      // ugyanúgy, ahogy a bestLapTime is megmarad Hot Lap reset után.
      currentLapGhost = [];
      ghostStepCounter = 0;
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
        else {
          const pos = carBody.getPosition();
          updateCar(carBody, input, fixedDt, drive, offRoadExcess, carParamsFor(pos.x, pos.y, pitLanePoints));
        }
      },
      recordState
    );

    const x = lerp(prev.x, curr.x, alpha);
    const z = lerp(prev.y, curr.y, alpha);
    const angle = lerpAngle(prev.angle, curr.angle, alpha);

    carMesh.position.set(x, 0.12, z);
    carMesh.rotation.y = -angle;
    carWheels.update(forwardSpeed(carBody), drive.steer, dt);

    // Ghost car lejátszás: a SAJÁT jelenlegi kör-idővel (race.time - lapStartTime)
    // szinkronban — keret-interpoláció a rögzített mintasoron, NEM újra-szimuláció
    // (lásd a felvétel feletti fejléc-megjegyzést). Guruló rajton, vagy ha nincs
    // kiválasztott ghost, egyszerűen rejtve marad.
    if (hotLap && ghostGroup) {
      const playing = activeGhostSamples && race.phase === 'racing' && !hotLapArmed;
      if (playing) {
        const elapsed = race.time - race.lapStartTime;
        const idxF = elapsed * GHOST_SAMPLE_HZ;
        const i0 = Math.floor(idxF);
        if (i0 >= 0 && i0 < activeGhostSamples.length - 1) {
          const s0 = activeGhostSamples[i0];
          const s1 = activeGhostSamples[i0 + 1];
          const f = idxF - i0;
          ghostGroup.position.set(lerp(s0[0], s1[0], f), 0.12, lerp(s0[1], s1[1], f));
          ghostGroup.rotation.y = -lerpAngle(s0[2], s1[2], f);
          ghostGroup.visible = true;
        } else {
          ghostGroup.visible = false; // a rögzített kör ennyi ideje már véget ért — a következő kör elején jelenik meg újra
        }
      } else {
        ghostGroup.visible = false;
      }
    }
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

    if (pitMarker) {
      pitMarker.group.visible = !race.pitStopDone;
      if (!race.pitStopDone) updatePitMarker(pitMarker, race.time);
    }

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

    if (speedNumEl) speedNumEl.textContent = String(Math.round(speedKmh(carBody)));
    race.boostRemaining = drive.boostRemaining; // csak megjelenítéshez (hud.js)
    updateHud(race);
    minimap.draw([{ x, z, color: CARS[selectedCar]?.color, isMe: true }]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    window.__GAME = {
      world, carBody, camera, scene, race, audio, renderer, drive, minimap, carEffects, updateHud,
      // Ghost car belső állapota — csak DEV, hibakereséshez (lásd a felvétel/
      // lejátszás fejléc-megjegyzését recordState/frame felett).
      get ghostGroup() { return ghostGroup; },
      get activeGhostSamples() { return activeGhostSamples; },
      get pendingGhostSamples() { return pendingGhostSamples; },
    };
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
  saveCustomTrack(init.layout, init.decorations, init.pitLane);
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
  infoBtnEl.style.display = 'flex';
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
  let mpPitStopRequired = false; // a szoba-beállításból (init/roomSettings/raceStart)
  // Boxutca-útvonal VILÁG-koordinátái — ugyanaz a forrás, mint mpConePoints,
  // lásd trackStorage.js loadPitLane (ua. a kliens/szerver-geometria).
  const mpPitLanePoints = loadPitLane();
  // A SAJÁT boxhelyünk — a szoba a 'raceStart' üzenetben küldi a slotIndexet
  // (lásd server/RaceRoom.js), addig 0 az alapérték (lásd mySlotIndex).
  let mySlotIndex = 0;
  let myPitBox = pitBoxForSlot(mpPitLanePoints, mySlotIndex);
  // Vizuális jelölés — MINDEN kijelölt boxhely rácsa + a SAJÁT helyünk fölött
  // lebegő "BOX" felirat (lásd render3d/pitMarker.js) — a láthatóságot
  // mpRace.pitStopDone vezérli a frame() ciklusban.
  const mpPitMarker = pitLaneReady(mpPitLanePoints) ? createPitMarker(mpPitLanePoints, mySlotIndex) : null;
  if (mpPitMarker) scene.add(mpPitMarker.group);
  const mpRace = createRaceState(mpTotalLaps, mpPitStopRequired && pitLaneReady(mpPitLanePoints));
  const mpPrev = { x: mySpawn.x, y: mySpawn.y, angle: mySpawn.angle };
  const mpCurr = { x: mySpawn.x, y: mySpawn.y, angle: mySpawn.angle };
  // Ghost car FELVÉTEL multiplayerben — ugyanaz az elv, mint egyjátékosban
  // (lásd startSingleplayer recordState felette a bővebb megjegyzést), csak
  // itt a "ez volt-e az új legjobb kör" döntést NEM a kliens hozza meg (a
  // verseny szerver-mért, lásd CLAUDE.md), hanem elküldjük a SZERVERNEK minden
  // helyben lezárt, érvényes kör felvételét ('lapGhost' üzenet), és a szerver
  // csatolja a ranglistára, ha a SAJÁT mérése szerint tényleg ez lett a legjobb
  // (lásd server/RaceRoom.js p.pendingGhost). Itt sosem jelenik meg (ghost
  // LEJÁTSZÁS csak Hot Lapben van), csak felvétel+beküldés.
  let mpGhostStepCounter = 0;
  let mpCurrentLapGhost = [];
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
    Object.assign(mpRace, createRaceState(mpTotalLaps, mpPitStopRequired && pitLaneReady(mpPitLanePoints)));
    Object.assign(mpDrive, createDriveState());
    mpStartedRacing = false;
    mpSentFinish = false;
    mpGhostStepCounter = 0;
    mpCurrentLapGhost = [];
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
  // Névtábla-sprite id-nként — a kamerától mért távolság alapján halványítjuk
  // el frame-ről frame-re (lásd lejjebb), hogy közvetlen közelről (pl. valaki
  // mögöttünk hajt) ne takarja ki a kilátást.
  const nameplates = new Map();

  async function ensureMesh(id, colorIdx, name) {
    if (meshes.has(id) || loadingMeshes.has(id)) return;
    loadingMeshes.add(id);
    const car = CARS[colorIdx % CARS.length];
    const model = await loadModel(car.model);
    // A kit-jének megfelelően (Car Kit: colormap, Racing Kit: natív anyagszín).
    const group = buildCarHolder(car, model);
    // A TÖBBI játékos autója fölé lebegő névtábla (a sajátunk fölé nem kell).
    if (id !== myId) {
      const plate = createNameplate(name, carColor(colorIdx));
      group.add(plate);
      nameplates.set(id, plate);
    }
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
        nameplates.delete(id);
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
        // `mpTrackListLoaded` CSAK sikeres lekérés után áll igazra (lásd lejjebb)
        // — korábban ELŐRE lett igazra állítva, ezért egy sikertelen próbálkozás
        // után a panel ÚJRAnyitásakor sem próbálkozott újra (lásd loadTrackCatalog
        // megjegyzését ugyanerről a hibaosztályról).
        const catalog = await loadTrackCatalog();
        if (trackCatalog) mpTrackListLoaded = true;
        // Preselect: a szoba JELENLEGI pályáját (mpTrackName, a szervertől)
        // keressük névre a katalógusban — ua. elv, mint korábban a <select>.
        const match = catalog.find((t) => t.name === mpTrackName);
        mpSelectedTrackId = match ? match.id : '';
        mpSelectedTrackName = match ? match.name : 'Alap pálya';
      }
      updateMpTrackPickButton();
      mpLapsInput.value = String(mpTotalLaps);
      mpPhysicsSelect.value = mpPhysicsName;
      if (mpPitStopInput) mpPitStopInput.checked = mpPitStopRequired;
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
      let pitLane;
      let trackName;
      if (id) {
        const t = await apiGetTrack(id);
        layout = t.layout;
        decorations = t.decorations;
        pitLane = t.pitLane;
        trackName = t.name;
      } else {
        layout = DEFAULT_LAYOUT;
        decorations = [];
        pitLane = [];
        trackName = 'Alap pálya';
      }
      const n = parseInt(mpLapsInput.value, 10);
      room.send('hostSettings', {
        layout,
        decorations,
        pitLane,
        trackName,
        laps: Number.isFinite(n) && n >= 1 && n <= 50 ? n : mpTotalLaps,
        physics: mpPhysicsSelect.value,
        pitStopRequired: !!(mpPitStopInput && mpPitStopInput.checked),
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
    if (typeof m.pitStopRequired === 'boolean') mpPitStopRequired = m.pitStopRequired;
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
    // A SAJÁT boxhelyünk a szoba által adott slotIndexből (lásd
    // server/RaceRoom.js) — ez versenyenként változhat (belépési sorrend
    // szerint osztódik újra), ezért itt, minden raceStart-nál frissítjük.
    if (m.slots && m.slots[myId] && Number.isFinite(m.slots[myId].slotIndex)) {
      mySlotIndex = m.slots[myId].slotIndex;
      myPitBox = pitBoxForSlot(mpPitLanePoints, mySlotIndex);
      if (mpPitMarker) setMyBoxIndex(mpPitMarker, mySlotIndex);
    }
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
    if (typeof init.pitStopRequired === 'boolean') mpPitStopRequired = init.pitStopRequired;
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
            else {
              const pos = mpCar.getPosition();
              updateCar(mpCar, input, fixedDt, mpDrive, offRoadExcess, carParamsFor(pos.x, pos.y, mpPitLanePoints));
            }
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
              // Kötelező kerékcsere haladása — a raceStep MELLETT, mint egyjátékosban
              // (lásd startSingleplayer recordState). Ez csak a HELYI HUD-ot vezérli;
              // a hivatalos döntést a szerver hozza meg ugyanezzel a logikával
              // (server/raceTracker.js), a bejelentett pozíciókból.
              const mpVel = mpCar.getLinearVelocity();
              updatePitStop(mpRace, mpCurr.x, mpCurr.y, Math.hypot(mpVel.x, mpVel.y), myPitBox, SIM.fixedDt);
              const mpRaceEvents = raceStep(mpRace, mpPrev, mpCurr, SIM.fixedDt, checkpoints, offTrack, trackHeadingAt);
              if (mpRaceEvents.some((e) => e.type === 'lap' || e.type === 'finish')) refillBoost(mpDrive);

              // Ghost car felvétel (lásd a mpCurrentLapGhost fenti megjegyzését) —
              // ugyanaz a mintavételi ütem (GHOST_SAMPLE_STRIDE), mint egyjátékosban.
              mpGhostStepCounter++;
              if (mpGhostStepCounter >= GHOST_SAMPLE_STRIDE) {
                mpGhostStepCounter = 0;
                mpCurrentLapGhost.push([
                  Math.round(mpCurr.x * 100) / 100,
                  Math.round(mpCurr.y * 100) / 100,
                  Math.round(mpCurr.angle * 100) / 100,
                ]);
              }
              const mpLapDone = mpRaceEvents.some((e) => e.type === 'lap' || e.type === 'finish');
              if (mpLapDone) {
                // A DÖNTÉS ("ez az új legjobb kör?") a szerveré — itt csak akkor
                // küldjük el, ha a HELYI mérésünk szerint érvényes volt (ne
                // pazaroljunk hálózati forgalmat egy eleve érvénytelen felvételre,
                // amit a szerver úgysem tudna felhasználni).
                if (mpRace.lastLapValid && mpCurrentLapGhost.length > 0) {
                  room.send('lapGhost', { samples: mpCurrentLapGhost });
                }
                mpCurrentLapGhost = [];
                mpGhostStepCounter = 0;
              }
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
        // Névtábla elhalványítása közelről (lásd nameplate.js megjegyzését) —
        // a `camera` ITT még az ELŐZŐ képkocka pozícióján áll (updateCamera
        // lejjebb fut), egy képkockányi késés a fokozatos elhalványodásnál
        // észrevehetetlen.
        const plate = nameplates.get(id);
        if (plate) plate.material.opacity = nameplateOpacityForDistance(camera.position.distanceTo(mesh.position));
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
      const myBestLap = me && me.bestLap != null ? me.bestLap : mpRace.bestLapTime;
      // Mezőny-legjobb kör (a snapshot bestLap mezőiből, lásd RaceRoom.js) — nincs
      // élő, checkpontonkénti szakasz-adatunk a TÖBBI játékostól, ezért a
      // "mezőny-rekord" jelzést (sectordelta lila állapota, lásd hud.js) azzal
      // közelítjük, hogy MOST a MI legjobb TELJES körünk-e a legjobb a szobában —
      // ha igen, egy nálunk is jobb szakasz-idő valószínűleg tényleg vezető.
      let fieldBestLap = null;
      for (const p of Object.values(sampled.players)) {
        if (p.bestLap != null && (fieldBestLap === null || p.bestLap < fieldBestLap)) fieldBestLap = p.bestLap;
      }
      const sectorFieldBest = myBestLap != null && fieldBestLap != null && myBestLap <= fieldBestLap + 1e-6;

      const hudRace = {
        phase: myFinished ? 'finished' : serverPhase === 'racing' ? 'racing' : 'countdown',
        countdownLeft: sampled.countdownLeft,
        lap: me ? me.lap : mpRace.lap,
        time: mpRace.time,
        totalLaps: mpTotalLaps,
        lapStartTime: mpRace.lapStartTime,
        lastLapTime: me && me.lastLap != null ? me.lastLap : mpRace.lastLapTime,
        bestLapTime: myBestLap,
        wrongWay: mpRace.wrongWay,
        lapValid: mpRace.lapValid,
        lastSplitDelta: mpRace.lastSplitDelta,
        lastSplitAt: mpRace.lastSplitAt,
        sectorFieldBest,
        place: me ? me.place || null : null, // hányadikként értünk célba (szervertől)
        hideRestart: true, // MP-ben az újraindítás a végeredmény-panelen van
        boostRemaining: mpDrive.boostRemaining, // csak megjelenítéshez (hud.js)
        // Kötelező kerékcsere: a HELYI (kliens-oldali) mérésből — a szerver nem
        // küldi vissza HUD-célra, csak a célzár-döntésnél veszi figyelembe.
        pitStopRequired: mpRace.pitStopRequired,
        pitStopDone: mpRace.pitStopDone,
        pitStopTimer: mpRace.pitStopTimer,
      };
      updateHud(hudRace);
      if (mpPitMarker) {
        mpPitMarker.group.visible = !mpRace.pitStopDone;
        if (!mpRace.pitStopDone) updatePitMarker(mpPitMarker, mpRace.time);
      }
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
      if (speedNumEl) speedNumEl.textContent = String(Math.round(ownSpeed));

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

    // A mezőny abszolút leggyorsabb köre — ez kapja a lila kiemelést a "Legj."
    // oszlopban (lásd .standRow .stBest.fastest), ugyanaz a szín, mint a
    // sectordelta 'mezőny-rekord' állapotánál (hud.js sectorFieldBest).
    let fieldBestLap = null;
    for (const p of list) {
      if (p.bestLap != null && (fieldBestLap === null || p.bestLap < fieldBestLap)) fieldBestLap = p.bestLap;
    }

    standingsEl.style.display = roomPhase === 'lobby' ? 'none' : 'flex';
    const rows = list
      .map((p, i) => {
        const icon = carIcon(p.colorIdx);
        const isMe = p.id === myId;

        let gapHtml = '<span class="stGap gapSelf">—</span>';
        if (!isMe) {
          if (p.finished) {
            gapHtml = '<span class="stGap">🏁</span>';
          } else if (canEstimateGap) {
            const pDist = (p.lap - 1 + (p.progress || 0)) * trackLen;
            const gapSec = (myDist - pDist) / mySpeedMs;
            const cls = gapSec < 0 ? 'gapAhead' : 'gapBehind';
            const sign = gapSec > 0 ? '+' : '';
            gapHtml = `<span class="stGap ${cls}">${sign}${gapSec.toFixed(1)}s</span>`;
          } else {
            gapHtml = '<span class="stGap gapSelf">–</span>';
          }
        }

        const isFieldBest = p.bestLap != null && fieldBestLap != null && p.bestLap <= fieldBestLap + 1e-6;
        const bestHtml = p.bestLap != null
          ? `<span class="stBest${isFieldBest ? ' fastest' : ''}">${fmtTime(p.bestLap)}</span>`
          : '<span class="stBest">–</span>';

        let lastCls = '';
        if (p.lastLap != null && p.bestLap != null) {
          lastCls = p.lastLap <= p.bestLap + 1e-6 ? ' faster' : ' slower';
        }
        const lastHtml = p.lastLap != null
          ? `<span class="stLast${lastCls}">${fmtTime(p.lastLap)}</span>`
          : '<span class="stLast">–</span>';

        return `<div class="standRow${isMe ? ' me' : ''}${i === 0 ? ' p1' : ''}">` +
          `<span class="stPos">${i + 1}</span>` +
          `<span class="stName">${icon} ${escapeHtml(p.name)}${isMe ? ' (te)' : ''}</span>` +
          `${gapHtml}${bestHtml}${lastHtml}</div>`;
      })
      .join('');

    standingsEl.innerHTML =
      `<div class="standHead"><span>Verseny állás</span><span>${list.length} induló</span></div>` +
      `<div class="standCols"><span>#</span><span>Név</span><span>Rés</span><span>Legj.</span><span>Utolsó</span></div>` +
      rows +
      '<div class="standFoot">Rés: <span class="kAhead">−</span> előtted · ' +
      '<span class="kBehind">+</span> mögötted &nbsp;·&nbsp; ' +
      '<span class="kBest">lila</span> = mezőny-rekord</div>';
  }

  if (import.meta.env.DEV) {
    window.__GAME = { camera, scene, audio, renderer, room, buffer, mpCar, mpRace, mpDrive, minimap, remoteCars, carEffects, meshes, nameplates };
  }
}

async function doCreate() {
  menuStatus.textContent = 'Kapcsolódás a szerverhez…';
  try {
    const room = await createRoom({
      name: playerName(),
      layout: loadCustomLayout(),
      decorations: loadCustomDecorations(),
      pitLane: loadPitLane(),
      laps: chosenLaps(),
      carIdx: selectedCar,
      physics: chosenPhysics(),
      trackName: getActiveTrackName() || 'Alap pálya',
      pitStopRequired: chosenPitStopRequired(),
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
// --- MÓD-VÁLASZTÓ (Verseny / Hot Lap / Többjátékos) ---
// A három játékmód EGY szegmens-kapcsolóban él (index.html #modeSwitch), és a
// kiválasztott mód dönti el, (a) mit csinál az egyetlen indító-gomb, (b) mely
// mezők értelmesek, (c) látszik-e a szoba-csatlakozás blokk. Korábban három
// külön, eltérő színű gomb volt egymás alatt — abból nem derült ki, hogy ezek
// EGYMÁST KIZÁRÓ módok, és a multiplayer csatlakozás is mindig ott lógott.
const MENU_MODES = {
  single: {
    cta: '🏁 Verseny indítása',
    hint: 'Fix körszám, álló rajt visszaszámlálással. A legjobb köröd felkerül a ranglistára.',
    laps: true,
    join: false,
  },
  hotlap: {
    cta: '🔥 Hot Lap indítása',
    hint: 'Végtelen kör, guruló rajtból — tiszta időmérő edzés. A körszám itt nem számít.',
    laps: false,
    join: false,
  },
  create: {
    cta: '👥 Szoba létrehozása',
    hint: 'Létrehozol egy szobát, és a kódját elküldöd 2–4 játékosnak. A pályát és a körszámot te (a host) állítod.',
    laps: true,
    join: true,
  },
};

const modeSwitchEl = document.getElementById('modeSwitch');
const modeHintEl = document.getElementById('modeHint');
const btnStartModeEl = document.getElementById('btnStartMode');
const fieldLapsEl = document.getElementById('fieldLaps');
const fieldPitStopEl = document.getElementById('fieldPitStop');
const mpJoinBlockEl = document.getElementById('mpJoinBlock');

let selectedMode = localStorage.getItem('autos-jatek:mode');
if (!MENU_MODES[selectedMode]) selectedMode = 'single';

function setMode(mode) {
  if (!MENU_MODES[mode]) return;
  selectedMode = mode;
  localStorage.setItem('autos-jatek:mode', mode);
  const cfg = MENU_MODES[mode];
  for (const btn of modeSwitchEl.querySelectorAll('.modeBtn')) {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  btnStartModeEl.textContent = cfg.cta;
  modeHintEl.textContent = cfg.hint;
  fieldLapsEl.classList.toggle('is-disabled', !cfg.laps);
  lapsInput.disabled = !cfg.laps;
  if (fieldPitStopEl) fieldPitStopEl.classList.toggle('is-disabled', !cfg.laps);
  if (pitStopInput) pitStopInput.disabled = !cfg.laps;
  mpJoinBlockEl.classList.toggle('is-open', cfg.join);
}

modeSwitchEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.modeBtn');
  if (btn) setMode(btn.dataset.mode);
});
setMode(selectedMode);

// A teljes képernyő kérése (touch-eszközön) MINDIG a kattintás-eseményből,
// szinkron módon, MIELŐTT bármi async munka (pl. szerver-csatlakozás) elindulna.
btnStartModeEl.onclick = () => {
  if (touch) requestFullscreen();
  playWithSelectedTrack(selectedMode);
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
