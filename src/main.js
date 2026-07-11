// Belépési pont: saját game loop (requestAnimationFrame) — fizika a sim/ rétegben,
// megjelenítés a render3d/ rétegben. Framework-es scene-kezelés nincs, nem is kell.
import { SIM, ASSETS } from './config.js';
import { createWorld, createStepper } from './sim/world.js';
import { spawn } from './sim/track.js';
import {
  createCarBody,
  updateCar,
  coastToStop,
  resetCar,
  speedKmh,
  corneringLoad,
  createDriveState,
} from './sim/car.js';
import { createRaceState, raceStep } from './sim/race.js';
import { createKeyboard, NEUTRAL_INPUT } from './input.js';
import { createScene3D, setCarModel, applyTexture, loadTrackTiles } from './render3d/scene.js';
import { loadDecorations } from './render3d/decorations.js';
import { addGrassField } from './render3d/grassField.js';
import { loadModel, loadTexture, loadModelTexture, fitCarModel } from './render3d/assets.js';
import { createChaseCamera } from './render3d/camera.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { lerp, lerpAngle } from './utils.js';

// --- Szimuláció ---
const world = createWorld();
const carBody = createCarBody(world, spawn.x, spawn.y, spawn.angle);
const stepper = createStepper();
const readInput = createKeyboard();
const race = createRaceState();
const drive = createDriveState(); // fű-büntetés (gáz-szorzó) állapota

// Interpolációhoz: a fizika legutóbbi két állapota (előző és jelenlegi lépés).
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

  // Verseny-frissítés minden fizika-lépés után, az adott lépés mozgás-szakaszával.
  // (Determinisztikus: fix dt, csak pozíciókból dolgozik — szerver-kész.)
  raceStep(race, prev, curr, SIM.fixedDt);
}

// --- Megjelenítés ---
const { renderer, scene, camera, carMesh, asphaltMesh } = createScene3D(
  document.getElementById('game')
);

// Külső assetek betöltése a háttérben (nem blokkol). Ha egy fájl hiányzik,
// a beépített procedurális megjelenés marad — a betöltöttek "beúsznak".
(async () => {
  const [carModel, carColormap, asphaltTex] = await Promise.all([
    loadModel(ASSETS.car.url),
    loadModelTexture(ASSETS.car.colormap),
    loadTexture(ASSETS.textures.asphalt, 1),
  ]);
  if (carModel) setCarModel(carMesh, fitCarModel(carModel, carColormap));
  applyTexture(asphaltMesh, asphaltTex);
})();

// Kenney road-csempék lerakása a pálya mentén (nem blokkol).
loadTrackTiles(scene);
// A teljes talaj Kenney grass.glb csempékből, a pálya köré (nem blokkol).
addGrassField(scene);
// A szerkesztőben elhelyezett dekorációk (fal, fa, fű, rázókő, épület...) betöltése.
loadDecorations(scene);
const updateCamera = createChaseCamera(camera);

// Új verseny: autó vissza a rajthoz, verseny-állapot és interpoláció nulláról.
function resetGame() {
  resetCar(carBody, spawn.x, spawn.y, spawn.angle);
  Object.assign(race, createRaceState());
  Object.assign(drive, createDriveState());
  prev.x = curr.x = spawn.x;
  prev.y = curr.y = spawn.y;
  prev.angle = curr.angle = spawn.angle;
}

const updateHud = createHud(resetGame);
const audio = createAudio();
const speedEl = document.getElementById('speed');

// Hang-eseményekhez: figyeljük a visszaszámláló egész-váltását és a rajtot.
let lastCountInt = null;
let lastPhase = race.phase;

// --- Game loop ---
let lastTime = performance.now();

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1); // védőkorlát nagy ugrás ellen
  lastTime = now;

  // Csak versenyzés közben van vezérlés; countdown alatt áll, cél után legördül.
  const input = race.phase === 'racing' ? readInput() : NEUTRAL_INPUT;
  const alpha = stepper(
    world,
    dt,
    (fixedDt) => {
      if (race.phase === 'finished') coastToStop(carBody);
      else updateCar(carBody, input, fixedDt, drive);
    },
    recordState
  );

  // Sim → render, a két utolsó fizikai állapot közt interpolálva (sima mozgás).
  const x = lerp(prev.x, curr.x, alpha);
  const z = lerp(prev.y, curr.y, alpha); // fizikai y → 3D z (talajsík)
  const angle = lerpAngle(prev.angle, curr.angle, alpha);

  carMesh.position.set(x, 0.12, z); // kissé a Kenney út-csempe fölé, hogy ne süppedjen be
  carMesh.rotation.y = -angle; // 2D szög → függőleges tengely körüli forgatás

  // Fejlesztői felülnézet (window.__TOP = magasság) vagy normál chase kamera.
  if (window.__TOP) {
    camera.position.set(x, window.__TOP, z + 0.001);
    camera.lookAt(x, 0, z);
  } else {
    updateCamera(x, z, angle, dt);
  }
  renderer.render(scene, camera);

  // --- Hang ---
  // Visszaszámláló bip a szám váltásakor (3, 2, 1), magasabb GO! a rajtnál.
  if (race.phase === 'countdown') {
    const c = Math.ceil(race.countdownLeft);
    if (c !== lastCountInt && c > 0) audio.beep(520, 0.16);
    lastCountInt = c;
  }
  if (lastPhase === 'countdown' && race.phase === 'racing') audio.beep(880, 0.35);
  lastPhase = race.phase;

  // Motor és gumicsikorgás folyamatos frissítése.
  audio.update({
    speedKmh: speedKmh(carBody),
    throttle: race.phase === 'racing' && input.up,
    corneringLoad: race.phase === 'finished' ? 0 : corneringLoad(carBody),
  });

  if (speedEl) {
    speedEl.textContent = `Sebesség: ${Math.round(speedKmh(carBody))} km/h`;
  }
  updateHud(race);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Fejlesztői debug-hozzáférés a böngésző-konzolból.
if (import.meta.env.DEV) {
  window.__GAME = { world, carBody, camera, scene, race, audio, renderer, drive };
}
