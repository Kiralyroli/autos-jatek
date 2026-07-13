// =============================================================================
//  CLIENT-SIDE PREDICTION + SERVER RECONCILIATION (4. fázis — Gambetta-modell).
//
//  A saját autót HELYBEN, azonnal szimuláljuk (ugyanaz a determinisztikus sim,
//  mint a szerveren), az inputokat sorszámozva küldjük. Két külön simasági gond
//  van, MINDKETTŐT kezelni kell:
//
//  1) AL-LÉPÉS-INTERPOLÁCIÓ (ez okozta a "lüktetést"): a fizika fix 1/60 s
//     lépésekben halad, a render viszont változó rAF-ütemben — ha egy frame 0
//     fizika-lépést kap, más 2-t, a NYERS test-pozíció ugrál. Ezért a két utolsó
//     fizikai állapot (prev/curr) közt a maradék akkumulátorral (alpha) LERP-elünk,
//     pontosan úgy, ahogy az egyjátékos renderelő is (main.js). Ettől sima 60Hz+.
//
//  2) RECONCILE: a szerver hivatalos állapota (20Hz, kvantált) alapján KIS eltérésnél
//     NEM bántjuk a simán futó predikciót (a kliens jogosan "előrébb" jár), csak a
//     ténylegesen NAGY divergenciát (ütközés/nemdeterminizmus) korrigáljuk — akkor is
//     egy rövid, lecsengő vizuális eltolással (corr), hogy ne ugorjon a kép.
// =============================================================================
import { Vec2 } from 'planck';
import { SIM } from '../config.js';
import { createWorld } from '../sim/world.js';
import { createCarBody, updateCar, createDriveState } from '../sim/car.js';
import { offRoadExcess, spawn } from '../sim/track.js';
import { lerp, lerpAngle } from '../utils.js';

const CORRECT_RATE = 9; // 1/s — nagy korrekció után a vizuális eltolás lecsengése
const SNAP_DIST = 2.5; // m — e fölött (ütközés/teleport) igazítunk a hitelesre

export function createPredictor(room) {
  const world = createWorld();
  const body = createCarBody(world, spawn.x, spawn.y, spawn.angle);
  const drive = createDriveState();
  const pending = []; // úton lévő inputok: { seq, input }
  let seq = 0;
  let acc = 0;
  let active = false;
  // A két utolsó FIZIKAI állapot (al-lépés-interpolációhoz) és a vizuális eltolás.
  const prev = { x: spawn.x, y: spawn.y, a: 0 };
  const curr = { x: spawn.x, y: spawn.y, a: 0 };
  const corr = { x: 0, y: 0, a: 0 };

  const snap = () => ({ x: body.getPosition().x, y: body.getPosition().y, a: body.getAngle() });

  function setBodyState(s) {
    body.setPosition(Vec2(s.x, s.y));
    body.setAngle(s.angle);
    body.setLinearVelocity(Vec2(s.vx || 0, s.vy || 0));
    body.setAngularVelocity(s.w || 0);
  }

  function simStep(input) {
    updateCar(body, input, SIM.fixedDt, drive, offRoadExcess);
    world.step(SIM.fixedDt, SIM.velocityIterations, SIM.positionIterations);
  }

  function normAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  return {
    get active() {
      return active;
    },
    body, // a hangokhoz (speedKmh/corneringLoad) — azonnali, helyi állapot

    start(me) {
      active = true;
      acc = 0;
      seq = me.seq || 0;
      pending.length = 0;
      corr.x = corr.y = corr.a = 0;
      drive.throttleMul = 1;
      drive.wasOnGrass = false;
      setBodyState(me);
      const s = snap();
      prev.x = curr.x = s.x;
      prev.y = curr.y = s.y;
      prev.a = curr.a = s.a;
    },

    stop() {
      active = false;
    },

    // Minden render-frame: annyi fix lépés, amennyi valós idő eltelt; a két utolsó
    // állapotot prev/curr-ban tartjuk az interpolációhoz. A vizuális eltolás lecseng.
    frame(dt, input) {
      if (!active) return;
      acc += Math.min(dt, SIM.fixedDt * SIM.maxSubSteps);
      while (acc >= SIM.fixedDt) {
        acc -= SIM.fixedDt;
        prev.x = curr.x;
        prev.y = curr.y;
        prev.a = curr.a;
        seq++;
        pending.push({ seq, input: { ...input } });
        if (pending.length > 120) pending.shift();
        room.send('input', { seq, ...input });
        simStep(input);
        const s = snap();
        curr.x = s.x;
        curr.y = s.y;
        curr.a = s.a;
      }
      const k = Math.exp(-CORRECT_RATE * dt);
      corr.x *= k;
      corr.y *= k;
      corr.a *= k;
    },

    // Szerver-snapshot a saját autónkról. KIS eltérésnél a predikció "jár", nem
    // nyúlunk hozzá (csak a testet állítjuk vissza a szabadon futó állapotra).
    // NAGY eltérésnél a hitelesre igazítunk, a vizuális ugrást corr-ral simítva.
    reconcile(me) {
      if (!active) return;

      // A szabadon futó (predikált) TELJES állapot mentése — visszaállításhoz.
      const fvel = body.getLinearVelocity();
      const F = {
        x: body.getPosition().x,
        y: body.getPosition().y,
        angle: body.getAngle(),
        vx: fvel.x,
        vy: fvel.y,
        w: body.getAngularVelocity(),
      };
      const fThrottle = drive.throttleMul;
      const fGrass = drive.wasOnGrass;

      // "Hiteles most": szerver-állapot + a még nyugtázatlan inputok újrajátszása.
      while (pending.length && pending[0].seq <= (me.seq || 0)) pending.shift();
      setBodyState(me);
      for (const p of pending) simStep(p.input);
      const ax = body.getPosition().x;
      const ay = body.getPosition().y;
      const aa = body.getAngle();

      const dist = Math.hypot(F.x - ax, F.y - ay);
      if (dist > SNAP_DIST) {
        // Nagy divergencia (ütközés/teleport): a hitelesre állunk (a body már ott
        // van a replay után), és a régi renderelt pozíció eltérését corr-ba tesszük,
        // hogy ne ugorjon — majd lecseng. prev/curr a hiteles állapotra reccsen.
        corr.x += curr.x - ax;
        corr.y += curr.y - ay;
        corr.a += normAngle(curr.a - aa);
        prev.x = curr.x = ax;
        prev.y = curr.y = ay;
        prev.a = curr.a = aa;
      } else {
        // Kis eltérés: a predikció rendben — visszaállítjuk a testet a szabadon
        // futó állapotra, így semmi nem zavarja meg a sima mozgást.
        setBodyState(F);
        drive.throttleMul = fThrottle;
        drive.wasOnGrass = fGrass;
      }
    },

    // A renderelendő állapot: a két utolsó fizikai lépés közt al-lépés-interpolálva
    // (sima 60Hz+), plusz a (lecsengő) korrekciós eltolás.
    renderState() {
      const alpha = Math.min(1, acc / SIM.fixedDt);
      return {
        x: lerp(prev.x, curr.x, alpha) + corr.x,
        y: lerp(prev.y, curr.y, alpha) + corr.y,
        angle: lerpAngle(prev.a, curr.a, alpha) + corr.a,
      };
    },
  };
}
