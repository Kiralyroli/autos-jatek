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
  corneringLoad,
  createDriveState,
  isFullyOffRoad,
  hitsCone,
  separateBodyFromPoints,
} from './sim/car.js';
import { createRaceState, raceStep } from './sim/race.js';
import { createKeyboard, NEUTRAL_INPUT } from './input.js';
import { createScene3D, setCarModel, applyTexture, loadTrackTiles } from './render3d/scene.js';
import { loadTrackRibbon } from './render3d/trackRibbon.js';
import { loadDecorations } from './render3d/decorations.js';
import { addGrassField } from './render3d/grassField.js';
import { loadModel, loadTexture, loadModelTexture, fitCarModel } from './render3d/assets.js';
import { setupWheels } from './render3d/wheels.js';
import { createNameplate } from './render3d/nameplate.js';
import { createChaseCamera } from './render3d/camera.js';
import { createHud, fmt as fmtTime } from './hud.js';
import { createAudio } from './audio.js';
import { lerp, lerpAngle } from './utils.js';
import * as THREE from 'three';
import { createRoom, joinRoom, createSnapshotBuffer } from './net/mpClient.js';
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
import { TRACK, CAR, CARS, DEFAULT_LAYOUT, applyPhysicsPreset, DEFAULT_PHYSICS, PHYSICS_PRESETS } from './config.js';
import { isDevMode } from './devmode.js';
import { loadCarTuning, resetCarToDefaults, createTuningPanel } from './tuning.js';

// --- Közös megjelenítés (mindkét módhoz) ---
const { renderer, scene, camera, carMesh, asphaltMesh } = createScene3D(
  document.getElementById('game')
);

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
const updateCamera = createChaseCamera(camera);
const readInput = createKeyboard();
const audio = createAudio();
const speedEl = document.getElementById('speed');

// A restart gomb viselkedése módfüggő — a dispatcher az aktív mód kezelőjét hívja.
let onRestartClick = () => {};
const updateHud = createHud(() => onRestartClick());

// --- Menü / lobby DOM ---
const menuEl = document.getElementById('menu');
const lobbyEl = document.getElementById('lobby');
const standingsEl = document.getElementById('standings');
const nameInput = document.getElementById('playerName');
const menuStatus = document.getElementById('menuStatus');
const lobbyStatus = document.getElementById('lobbyStatus');

const trackSelect = document.getElementById('trackSelect');
const lapsInput = document.getElementById('lapsInput');
const carSelectEl = document.getElementById('carSelect');
const physicsSelect = document.getElementById('physicsSelect');
const leaderboardListEl = document.getElementById('leaderboardList');
const btnClearLeaderboard = document.getElementById('btnClearLeaderboard');

// --- Multiplayer beállítások panel (autó BÁRKI, pálya/körök/fizika a host) —
// a lobbiból ÉS a végeredmény-panelről is előhozható (lásd startMultiplayer). ---
const mpSettingsEl = document.getElementById('mpSettings');
const mpCarSelectEl = document.getElementById('mpCarSelect');
const mpHostSettingsEl = document.getElementById('mpHostSettings');
const mpTrackSelect = document.getElementById('mpTrackSelect');
const mpLapsInput = document.getElementById('mpLapsInput');
const mpPhysicsSelect = document.getElementById('mpPhysicsSelect');
const btnMpApplySettings = document.getElementById('btnMpApplySettings');
const mpSettingsStatus = document.getElementById('mpSettingsStatus');
const btnMpSettingsClose = document.getElementById('btnMpSettingsClose');
const btnLobbySettings = document.getElementById('btnLobbySettings');
const btnResultsSettings = document.getElementById('btnResultsSettings');

// A trackSelect "Alap pálya" (value="") opciójának is kell egy trackKey (a
// beépített DEFAULT_LAYOUT hash-e), hogy a ranglista rá is tudjon szűrni —
// a katalógusból jövő pályák trackKey-jét a szerver adja (lásd populateTrackSelect).
const defaultTrackOption = trackSelect.querySelector('option[value=""]');
if (defaultTrackOption) defaultTrackOption.dataset.trackKey = hashLayout(DEFAULT_LAYOUT);

// Autó-választó: a CARS listából kattintható kártyák. A választás perzisztál, a
// 3D-előnézet (carMesh) azonnal a választott autóra vált (setPlayerCar). A
// FŐMENÜBEN (carSelectEl) ÉS a multiplayer beállítások panelen (mpCarSelectEl,
// lásd startMultiplayer) is ugyanez jelenik meg — mindkét konténer újrarajzolódik,
// bármelyikben választva (`carSelectContainers`), és multiplayerben a választás
// a szervernek is elküldődik (`onCarChanged`, csak ott van beállítva).
const carSelectContainers = [carSelectEl];
let onCarChanged = null;

function renderCarSelectInto(container) {
  container.innerHTML = '';
  CARS.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'carswatch' + (i === selectedCar ? ' active' : '');
    btn.innerHTML = `<span class="dot" style="background:${c.color}"></span>${c.name}`;
    btn.onclick = () => {
      if (i === selectedCar) return;
      selectedCar = i;
      localStorage.setItem('autos-jatek:carIdx', String(i));
      renderCarSelect();
      setPlayerCar(i);
      if (onCarChanged) onCarChanged(i);
    };
    container.appendChild(btn);
  });
}
function renderCarSelect() {
  for (const el of carSelectContainers) renderCarSelectInto(el);
}
renderCarSelect();

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

// A pálya-választó feltöltése a globális katalógusból. Alapból a főmenü
// trackSelect-jét tölti fel; a multiplayer beállítások panel saját
// mpTrackSelect-je (lásd startMultiplayer) is ugyanezt hívja, más `select`
// paraméterrel és `preselectName`-mel (ott nem a lokális aktív pálya, hanem a
// SZOBA jelenlegi pályája számít).
async function populateTrackSelect(select = trackSelect, preselectName = getActiveTrackName()) {
  let tracks = [];
  try {
    tracks = await apiListTracks();
  } catch {
    return; // szerver nem elérhető — marad csak az "Alap pálya" opció
  }
  for (const t of tracks) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    opt.dataset.trackKey = t.trackKey;
    if (t.name === preselectName) opt.selected = true;
    select.appendChild(opt);
  }
  if (select === trackSelect) {
    // opt.selected = true nem vált ki 'change' eseményt — a ranglistát itt
    // explicit újra kell rajzolni, ha időközben a katalógusból jött egy aktív pálya.
    renderLeaderboard();
  }
}

// A kiválasztott pálya-opció ranglista-azonosítója + neve (a trackSelect
// dataset.trackKey mezőjéből — lásd populateTrackSelect és a defaultTrackOption).
function currentTrackInfo() {
  const opt = trackSelect.selectedOptions[0];
  return {
    trackKey: opt?.dataset.trackKey || hashLayout(DEFAULT_LAYOUT),
    trackName: opt?.textContent || 'Alap pálya',
  };
}

// A jelenleg választott pálya + fizika örök-ranglistájának betöltése és
// kirajzolása a főmenübe. Dev módban törlés-gombok is megjelennek soronként,
// illetve az egész tábla törlésére is (btnClearLeaderboard, lásd index.html).
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
    return;
  }
  // Időközben másik pályára/fizikára válthatott a felhasználó — eldobjuk a válasz.
  const now = currentTrackInfo();
  if (now.trackKey !== trackKey || chosenPhysics() !== physics) return;

  if (entries.length === 0) {
    leaderboardListEl.innerHTML = '<p>Még nincs rögzített köridő ehhez a pályához.</p>';
  } else {
    leaderboardListEl.innerHTML = entries
      .map((e, i) => `
        <div class="lbRow">
          <span class="lbPos">${i + 1}.</span>
          <span class="lbName">${escapeHtml(e.playerName)}</span>
          <span class="lbTime">${fmtTime(e.lapTime)}</span>
          ${dev ? `<button class="lbDel" data-name="${escapeHtml(e.playerName)}">✕</button>` : ''}
        </div>
      `)
      .join('');
    if (dev) {
      leaderboardListEl.querySelectorAll('.lbDel').forEach((btn) => {
        btn.onclick = async () => {
          const { trackKey: tk } = currentTrackInfo();
          await apiDeleteLeaderboardEntry(tk, chosenPhysics(), btn.dataset.name);
          renderLeaderboard();
        };
      });
    }
  }
}

trackSelect.addEventListener('change', renderLeaderboard);
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
  const id = trackSelect.value;
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
  else doCreate();
}

// --- Üresjárati render (amíg a menüben vagyunk): lassan körbeforgó kamera ---
let mode = 'menu'; // 'menu' | 'single' | 'multi'
let currentRoom = null; // multiplayerben a Colyseus room — a Főmenü-gomb ebből lép ki
let lastTime = performance.now();

// Verseny közben (SP vagy MP) elérhető "vissza a főmenübe" gomb — MP-ben
// tisztán kilép a szobából, utána (mindkét módban) egyszerűen újratöltjük az
// oldalt: ez ugyanaz a minta, mint a lobby/eredmény "Kilépés"/"Vissza" gombjai
// (btnLeave, btnResultsLeave) — pending session-adat nélkül a reload után a
// főmenü jelenik meg.
document.getElementById('btnQuitRace').onclick = () => {
  if (currentRoom) currentRoom.leave();
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
// =============================================================================
function startSingleplayer() {
  mode = 'single';
  menuEl.style.display = 'none';
  document.getElementById('btnQuitRace').style.display = 'block';

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

  // Terelőkúpok VILÁG-koordinátái (lásd render3d/decorations.js ugyanezt a
  // world = dgx/dgy * TRACK.tile képletet) — a kör-érvényesség ellenőrzéséhez.
  const conePoints = loadCustomDecorations()
    .filter((d) => d.type === 'pylon')
    .map((d) => ({ x: d.dgx * TRACK.tile, y: d.dgy * TRACK.tile }));

  const world = createWorld();
  const carBody = createCarBody(world, spawn.x, spawn.y, spawn.angle);
  const stepper = createStepper();
  const laps = chosenLaps();
  const race = createRaceState(laps);
  const drive = createDriveState();

  const prev = { x: spawn.x, y: spawn.y, angle: spawn.angle };
  const curr = { x: spawn.x, y: spawn.y, angle: spawn.angle };

  function recordState() {
    prev.x = curr.x;
    prev.y = curr.y;
    prev.angle = curr.angle;
    const p = carBody.getPosition();
    curr.x = p.x;
    curr.y = p.y;
    curr.angle = carBody.getAngle();
    // A TELJES autó elhagyta a pályát, VAGY terelőkúpnak ütközött → a kör érvénytelen.
    const offTrack =
      isFullyOffRoad(carBody, offRoadExcess) || hitsCone(carBody, conePoints, RACE.coneHitRadius);
    raceStep(race, prev, curr, SIM.fixedDt, checkpoints, offTrack, trackHeadingAt);

    // FONTOS: lastSubmittedBest CSAK sikeres válasz után frissül (nem rögtön a
    // hívás előtt) — így ha egy beküldés elhasal (hálózati hiba, Railway "kihűlt"
    // szerver lassú ébredése), a KÖVETKEZŐ fizika-lépés újra megpróbálja UGYANEZT
    // az időt, amíg nem sikerül. A submitInFlight csak azt akadályozza meg, hogy
    // egyetlen still-in-progress kérésre percenként 60x rákérdezzünk.
    if (
      !submitInFlight &&
      race.bestLapTime !== null &&
      (lastSubmittedBest === null || race.bestLapTime < lastSubmittedBest - 1e-6)
    ) {
      submitInFlight = true;
      const timeToSubmit = race.bestLapTime;
      apiSubmitLap({
        trackKey,
        trackName,
        physics: physicsName,
        playerName: playerName(),
        lapTime: timeToSubmit,
      })
        .then(() => {
          lastSubmittedBest = timeToSubmit;
          renderLeaderboard();
        })
        .catch(() => {})
        .finally(() => {
          submitInFlight = false;
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
  };

  let lastCountInt = null;
  let lastPhase = race.phase;
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

    if (window.__TOP) {
      camera.position.set(x, window.__TOP, z + 0.001);
      camera.lookAt(x, 0, z);
    } else {
      updateCamera(x, z, angle, dt);
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
    });

    if (speedEl) speedEl.textContent = `Sebesség: ${Math.round(speedKmh(carBody))} km/h`;
    updateHud(race);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    window.__GAME = { world, carBody, camera, scene, race, audio, renderer, drive };
  }
}

// =============================================================================
//  MULTIPLAYER MÓD — a szerver az igazság, mi inputot küldünk és renderelünk.
// =============================================================================

// Az autó-modell + jelölőszín + ikon a config.CARS listából (a colorIdx = ez az index).
const carColor = (i) => CARS[i % CARS.length].color;
const carIcon = (i) => CARS[i % CARS.length].icon;

// Játékosnév biztonságos beszúrása HTML-be (a végeredmény-listához).
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A szoba pályája a MI lokálisan felépített pályánk-e? Ha nem, elmentjük a
// szerverét aktívnak, és újratöltjük az oldalt (a pálya-render a betöltéskor
// épül) — a sessionStorage-ba tett "rejoin" adattal automatikusan visszalépünk.
function ensureTrackMatches(init, roomCode) {
  const localLayout = JSON.stringify(TRACK.layout);
  const serverLayout = JSON.stringify(init.layout);
  if (localLayout === serverLayout) return true;
  saveCustomTrack(init.layout, init.decorations);
  sessionStorage.setItem(
    'autos-jatek:mp-rejoin',
    JSON.stringify({ code: roomCode, name: playerName() })
  );
  window.location.reload();
  return false;
}

async function startMultiplayer(room) {
  mode = 'multi';
  currentRoom = room;
  menuEl.style.display = 'none';
  document.getElementById('btnQuitRace').style.display = 'block';

  // Szerver-ping (RTT) mérése + kijelzése: időbélyeget küldünk, a szerver azonnal
  // visszaküldi ('pong'), a körbeérés ideje a késleltetés. Másodpercenként frissül.
  const pingEl = document.getElementById('ping');
  pingEl.style.display = 'block';
  pingEl.textContent = 'Ping: … ms';
  room.onMessage('pong', (t) => {
    pingEl.textContent = `Ping: ${Math.max(0, Math.round(performance.now() - t))} ms`;
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

  // A saját autó bejelentése a szervernek (relay) — throttle-olva ~snapshotHz-re.
  function mpSendState(now) {
    if (now - mpLastStateSentAt < 1000 / NET.snapshotHz) return;
    mpLastStateSentAt = now;
    const pos = mpCar.getPosition();
    const vel = mpCar.getLinearVelocity();
    room.send('state', {
      x: pos.x, y: pos.y, angle: mpCar.getAngle(),
      vx: vel.x, vy: vel.y, w: mpCar.getAngularVelocity(),
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

  carSelectContainers.push(mpCarSelectEl);
  onCarChanged = (i) => room.send('setCar', i);

  function openMpSettings() {
    mpSettingsStatus.textContent = '';
    mpHostSettingsEl.style.display = isHost ? 'block' : 'none';
    renderCarSelect();
    if (isHost) {
      if (!mpTrackListLoaded) {
        mpTrackListLoaded = true;
        populateTrackSelect(mpTrackSelect, mpTrackName);
      }
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
      const id = mpTrackSelect.value;
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
    if (!ensureTrackMatches(m, room.roomId)) return; // reload indult — a többi felesleges
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
    }
    mpResetForRace();
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
    ensureTrackMatches(init, room.roomId);
  });

  btnStart.onclick = () => room.send('start');
  btnLeave.onclick = () => {
    room.leave();
    window.location.reload();
  };
  room.onLeave(() => {
    clearInterval(pingTimer);
    // Szerver-oldali bontás (pl. szoba megszűnt) → vissza a menübe.
    if (mode === 'multi') window.location.reload();
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
  lastTime = performance.now();

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    const sampled = buffer.sample();
    if (sampled) {
      roomPhase = sampled.phase;
      if (sampled.phase !== 'lobby') lobbyEl.style.display = 'none';

      removeStaleMeshes(sampled.players);
      // A saját autó AKTUÁLIS pozíciója — a peer-ek "meglökésének" vizuális
      // referenciája (lásd lentebb). A helyi simből, azonnali.
      const myPos = mpCar.getPosition();
      for (const [id, p] of Object.entries(sampled.players)) {
        ensureMesh(id, p.colorIdx, p.name);
        const mesh = meshes.get(id);
        if (!mesh) continue;
        let px = p.x;
        let py = p.y;
        // VIZUÁLIS meglökés: ha egy PEER közelebb kerül a saját autómnál a
        // szeparációs küszöbnél (nekimentem), a RENDERJÉT kitoljuk a küszöbre —
        // így a te képernyődön azonnal látszik, hogy odébb csúszik, nem "szikla".
        // Csak megjelenítés: a valós (bejelentett) pozícióját nem írja felül, és
        // amint az ő gépe úgyis kitolta magát, a kettő egybeesik (nincs ugrás).
        if (id !== myId) {
          const dx = px - myPos.x;
          const dy = py - myPos.y;
          const d = Math.hypot(dx, dy);
          const md = RACE.carSeparation.minDist;
          if (d > 1e-4 && d < md) {
            const k = md / d;
            px = myPos.x + dx * k;
            py = myPos.y + dy * k;
          }
        }
        mesh.position.set(px, 0.12, py);
        mesh.rotation.y = -p.angle;
        // Távoli autók kerekei a snapshotból: gördülés az előre-sebességből,
        // kormányszög becslése a bicikli-modell inverzéből (δ ≈ atan(ω·L / v)).
        if (id !== myId) {
          const anim = wheelAnims.get(id);
          if (anim) {
            const fwd = p.vx * Math.cos(p.angle) + p.vy * Math.sin(p.angle);
            const spd = Math.hypot(p.vx, p.vy);
            let steer = spd > 1 ? Math.atan((p.w * CAR.wheelbase) / spd) : 0;
            steer = Math.max(-CAR.maxSteerAngle, Math.min(CAR.maxSteerAngle, steer));
            anim.update(fwd, steer, dt);
          }
        }
      }

      // --- SAJÁT autó: HELYI sim (kliens-autoritatív) ---
      const serverPhase = sampled.phase;
      const me = sampled.players[myId]; // csak a helyezéshez kell (a szerver osztja)

      // A többi kocsi középpontjai a puha szétnyomáshoz.
      mpPeerPoints = [];
      for (const [id, p] of Object.entries(sampled.players)) {
        if (id !== myId) mpPeerPoints.push({ x: p.x, y: p.y });
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
          },
          () => {
            mpPrev.x = mpCurr.x;
            mpPrev.y = mpCurr.y;
            mpPrev.angle = mpCurr.angle;
            const pp = mpCar.getPosition();
            mpCurr.x = pp.x;
            mpCurr.y = pp.y;
            mpCurr.angle = mpCar.getAngle();
            if (mpRace.phase === 'racing') {
              const offTrack =
                isFullyOffRoad(mpCar, offRoadExcess) ||
                hitsCone(mpCar, mpConePoints, RACE.coneHitRadius);
              raceStep(mpRace, mpPrev, mpCurr, SIM.fixedDt, checkpoints, offTrack, trackHeadingAt);
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

      // Kamera a saját autón.
      if (window.__TOP) {
        camera.position.set(ownX, window.__TOP, ownY + 0.001);
        camera.lookAt(ownX, 0, ownY);
      } else {
        updateCamera(ownX, ownY, ownA, dt);
      }

      // HUD a HELYI verseny-állapotból; a countdown-t a szerver fázisa/ideje adja.
      const hudRace = {
        phase: myFinished ? 'finished' : serverPhase === 'racing' ? 'racing' : 'countdown',
        countdownLeft: sampled.countdownLeft,
        lap: mpRace.lap,
        time: mpRace.time,
        totalLaps: mpTotalLaps,
        lapStartTime: mpRace.lapStartTime,
        lastLapTime: mpRace.lastLapTime,
        bestLapTime: mpRace.bestLapTime,
        wrongWay: mpRace.wrongWay,
        lapValid: mpRace.lapValid,
        place: me ? me.place || null : null, // hányadikként értünk célba (szervertől)
        hideRestart: true, // MP-ben az újraindítás a végeredmény-panelen van
      };
      updateHud(hudRace);

      // A saját állapot bejelentése a szervernek (relay).
      mpSendState(now);

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
      });

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
    const list = Object.values(players).sort((a, b) => {
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
        return `<div>${i + 1}. ${icon} ${p.name} — ${info}${lapLine}</div>`;
      })
      .join('');
  }

  if (import.meta.env.DEV) {
    window.__GAME = { camera, scene, audio, renderer, room, buffer, mpCar, mpRace };
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

// --- Indulás: rejoin / pending pálya-akció (reload után), vagy főmenü ---
document.getElementById('btnSingle').onclick = () => playWithSelectedTrack('single');
document.getElementById('btnCreate').onclick = () => playWithSelectedTrack('create');
document.getElementById('btnJoin').onclick = () =>
  doJoin(document.getElementById('joinCode').value);

const rejoinRaw = sessionStorage.getItem('autos-jatek:mp-rejoin');
const pendingRaw = sessionStorage.getItem('autos-jatek:pending');
if (rejoinRaw) {
  // Multiplayer visszalépés a szoba pályájára váltó reload után.
  sessionStorage.removeItem('autos-jatek:mp-rejoin');
  const { code, name } = JSON.parse(rejoinRaw);
  nameInput.value = name;
  doJoin(code);
} else if (pendingRaw) {
  // A menüben választott pálya alkalmazása utáni reload — a config.js már az új
  // pályával épült, most lefuttatjuk a halasztott akciót.
  sessionStorage.removeItem('autos-jatek:pending');
  const { action, name } = JSON.parse(pendingRaw);
  nameInput.value = name;
  if (action === 'single') startSingleplayer();
  else doCreate();
} else {
  menuEl.style.display = 'flex';
  populateTrackSelect();
}
requestAnimationFrame(idleFrame);
