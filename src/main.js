// =============================================================================
//  BELÉPÉSI PONT — közös 3D jelenet + mód-választó főmenü.
//
//  Két játékmód, ugyanarra a jelenetre építve:
//   - EGYJÁTÉKOS: minden lokális (fizika + verseny-logika a böngészőben) —
//     ez a korábbi 1-2. fázis változatlan viselkedése.
//   - MULTIPLAYER (3. fázis): a Colyseus szerver futtatja a fizikát/versenyt,
//     mi inputot küldünk és a snapshot-okból renderelünk minden autót.
// =============================================================================
import { SIM, ASSETS, RACE } from './config.js';
import { createWorld, createStepper } from './sim/world.js';
import { spawn, checkpoints, offRoadExcess } from './sim/track.js';
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
} from './sim/car.js';
import { createRaceState, raceStep } from './sim/race.js';
import { createKeyboard, NEUTRAL_INPUT } from './input.js';
import { createScene3D, setCarModel, applyTexture, loadTrackTiles } from './render3d/scene.js';
import { loadDecorations } from './render3d/decorations.js';
import { addGrassField } from './render3d/grassField.js';
import { loadModel, loadTexture, loadModelTexture, fitCarModel } from './render3d/assets.js';
import { setupWheels } from './render3d/wheels.js';
import { createNameplate } from './render3d/nameplate.js';
import { createChaseCamera } from './render3d/camera.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { lerp, lerpAngle } from './utils.js';
import * as THREE from 'three';
import { createRoom, joinRoom, createSnapshotBuffer } from './net/mpClient.js';
import { createPredictor } from './net/prediction.js';
import {
  loadCustomLayout,
  loadCustomDecorations,
  saveCustomTrack,
  setActiveTrack,
  clearCustomLayout,
  getActiveTrackName,
} from './trackStorage.js';
import { apiListTracks, apiGetTrack } from './net/trackApi.js';
import { TRACK, CAR, CARS, applyPhysicsPreset, DEFAULT_PHYSICS, PHYSICS_PRESETS } from './config.js';
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

loadTrackTiles(scene);
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

// Autó-választó: a CARS listából kattintható kártyák. A választás perzisztál, a
// 3D-előnézet (carMesh) azonnal a választott autóra vált (setPlayerCar).
function renderCarSelect() {
  carSelectEl.innerHTML = '';
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
    };
    carSelectEl.appendChild(btn);
  });
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

// A főmenü pálya-választójának feltöltése a globális katalógusból.
async function populateTrackSelect() {
  let tracks = [];
  try {
    tracks = await apiListTracks();
  } catch {
    return; // szerver nem elérhető — marad csak az "Alap pálya" opció
  }
  const activeName = getActiveTrackName();
  for (const t of tracks) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    if (t.name === activeName) opt.selected = true;
    trackSelect.appendChild(opt);
  }
}

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
let lastTime = performance.now();

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

  // A menüben választott autó-fizika (realistic/light) a globális CAR-ra — SP-ben
  // csak egy versenyt futtatunk ebben a lapban, ezt biztonságosan mutálhatjuk.
  applyPhysicsPreset(chosenPhysics());

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
    // A TELJES autó elhagyta a pályát? (mind a 4 sarok a burkolaton kívül) → a kör érvénytelen.
    const offTrack = isFullyOffRoad(carBody, offRoadExcess);
    raceStep(race, prev, curr, SIM.fixedDt, checkpoints, offTrack);
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
  menuEl.style.display = 'none';

  // Multiplayerben a helyi CAR-hangolás predikció-hibát okozna (a szerver az
  // ALAP értékekkel szimulál) — visszaállunk az alapra, a hangoló panel eltűnik.
  resetCarToDefaults();
  if (tuningPanel) tuningPanel.hide();

  const buffer = createSnapshotBuffer();
  const myId = room.sessionId;
  let mpTotalLaps = RACE.laps; // a szoba körszáma (az init üzenetből)
  // Saját autó: client-side prediction — azonnal reagál a gombokra, a szerver
  // hivatalos állapota a snapshotokon keresztül korrigálja (reconcile).
  const predictor = createPredictor(room);

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
      // DNF-ek egymás közt: aki messzebb jutott, előrébb.
      if (a.lap !== b.lap) return b.lap - a.lap;
      return b.ncp - a.ncp;
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

  room.onMessage('lobby', (m) => {
    isHost = m.hostId === myId;
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

  room.onMessage('snapshot', (s) => {
    buffer.push(s);
    // A saját autónk hivatalos szerver-állapota → predikció indítás/korrekció.
    const meNow = s.players[myId];
    if (meNow) {
      if (s.phase === 'racing' && !meNow.finished) {
        if (!predictor.active) predictor.start(meNow);
        else predictor.reconcile(meNow);
      } else if (predictor.active) {
        predictor.stop(); // cél után/újraindításkor vissza a snapshot-renderre
      }
    }
  });

  // Az init (pálya-adatok) a 'ready' üzenetünkre érkezik — ha a szoba pályája
  // eltér a lokálisan felépítettől, ensureTrackMatches ment + újratölt (rejoin).
  room.onMessage('init', (init) => {
    if (Number.isFinite(init.laps)) mpTotalLaps = init.laps;
    // A szoba TÉNYLEGESEN használt fizikáját alkalmazzuk (nem a saját menü-
    // választásunkat) — a host dönt, a szerver validál/visszaküld; enélkül a
    // helyi predikció eltérne a szerver-autoritatív szimulációtól.
    if (init.physics) applyPhysicsPreset(init.physics);
    ensureTrackMatches(init, room.roomId);
  });

  btnStart.onclick = () => room.send('start');
  btnLeave.onclick = () => {
    room.leave();
    window.location.reload();
  };
  room.onLeave(() => {
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
      for (const [id, p] of Object.entries(sampled.players)) {
        ensureMesh(id, p.colorIdx, p.name);
        const mesh = meshes.get(id);
        if (!mesh) continue;
        mesh.position.set(p.x, 0.12, p.y);
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

      const me = sampled.players[myId];
      if (me) {
        // Saját input + helyi predikció-lépések (az inputot a predictor küldi a
        // szervernek, sorszámozva, fix lépésenként).
        const racingMe = sampled.phase === 'racing' && !me.finished;
        const input = racingMe ? readInput() : NEUTRAL_INPUT;
        predictor.syncOpponents(sampled.players, myId, dt);
        predictor.frame(dt, input);

        // A saját autó a PREDIKÁLT állapotból renderelődik (azonnali reakció);
        // ha a predikció nem aktív (countdown/cél után), marad a snapshot-interp.
        const own = predictor.active ? predictor.renderState(dt) : { x: me.x, y: me.y, angle: me.angle };
        const myMesh = meshes.get(myId);
        if (myMesh) {
          myMesh.position.set(own.x, 0.12, own.y);
          myMesh.rotation.y = -own.angle;
        }
        // Saját kerekek: a predikált (helyi) állapotból — azonnali, pontos.
        if (predictor.active) {
          carWheels.update(forwardSpeed(predictor.body), predictor.steerAngle, dt);
        }

        // Kamera a saját (predikált) autón.
        if (window.__TOP) {
          camera.position.set(own.x, window.__TOP, own.y + 0.001);
          camera.lookAt(own.x, 0, own.y);
        } else {
          updateCamera(own.x, own.y, own.angle, dt);
        }

        // HUD: a sim-beli race-objektum "makettje" a saját snapshot-adatainkból.
        // FONTOS: a `time` a TELJES versenyidő legyen (nem a köridő!) — a HUD a
        // time<1-ből ismeri fel a rajt utáni "GO!" pillanatot, köridővel minden
        // körváltásnál újra GO!-t villantana. A futó köridőt a lapStartTime adja
        // ki (HUD: time - lapStartTime = curLap).
        const totalTime = me.finished ? me.totalTime : sampled.raceTime ?? 0;
        const fakeRace = {
          phase: me.finished ? 'finished' : sampled.phase === 'lobby' ? 'countdown' : sampled.phase,
          countdownLeft: sampled.countdownLeft,
          lap: me.lap,
          time: totalTime,
          totalLaps: mpTotalLaps,
          lapStartTime: me.finished ? 0 : totalTime - (me.curLap ?? 0),
          lastLapTime: me.lastLap,
          bestLapTime: me.bestLap,
          wrongWay: !!me.wrongWay,
          lapValid: me.lapValid !== false, // az aktuális kör érvényes-e (HUD-jelzés)
          place: me.place || null, // hányadikként értünk célba (a szervertől)
          hideRestart: true, // MP-ben az újraindítás a végeredmény-panelen van
        };
        updateHud(fakeRace);

        // Sebesség/hang a HELYI predikcióból, ha aktív (azonnali reakció) —
        // különben a snapshotból (countdown/cél utáni kigurulás).
        const ownSpeed = predictor.active ? speedKmh(predictor.body) : me.speed || 0;
        const ownCornering = predictor.active
          ? corneringLoad(predictor.body)
          : me.finished
            ? 0
            : me.cornering || 0;

        if (speedEl) speedEl.textContent = `Sebesség: ${Math.round(ownSpeed)} km/h`;

        // Countdown-bipek a fázisból.
        if (sampled.phase === 'countdown') {
          const c = Math.ceil(sampled.countdownLeft);
          if (c !== lastCountInt && c > 0) audio.beep(520, 0.16);
          lastCountInt = c;
        }
        if (lastPhase === 'countdown' && sampled.phase === 'racing') audio.beep(880, 0.35);
        lastPhase = sampled.phase;

        audio.update({
          speedKmh: ownSpeed,
          throttle: racingMe && input.up,
          corneringLoad: ownCornering,
        });
      }

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
      if (a.lap !== b.lap) return b.lap - a.lap;
      return b.ncp - a.ncp;
    });
    standingsEl.style.display = roomPhase === 'lobby' ? 'none' : 'flex';
    standingsEl.innerHTML = list
      .map((p, i) => {
        const icon = carIcon(p.colorIdx);
        const info = p.finished
          ? `🏁 ${p.totalTime.toFixed(2)} s`
          : `${p.lap}/${mpTotalLaps}. kör`;
        return `<div>${i + 1}. ${icon} ${p.name} — ${info}</div>`;
      })
      .join('');
  }

  if (import.meta.env.DEV) {
    window.__GAME = { camera, scene, audio, renderer, room, buffer, predictor };
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
