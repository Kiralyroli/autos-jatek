// =============================================================================
//  TÁVOLI AUTÓK — a többi játékos autójának HELYI, FIZIKAI szimulációja.
//
//  Ez az, amitől a mozgás "rendes autós játék" érzetű lesz. A korábbi modell a
//  snapshotok közt LINEÁRISAN interpolált, és a többieket ~60 ms-mal a MÚLTBAN
//  rendereltük — emiatt (a) a távoli autó egyenes vonalban "csúszott" kanyarban,
//  (b) 140 km/h-nál 4-6 méterrel odébb látszott, mint ahol tényleg volt (ez a
//  "mindketten magunkat látjuk előrébb" érzet fő oka).
//
//  Helyette: minden kliens elküldi a saját VEZÉRLÉSÉT is (src/input.js
//  encodeInput), és mindenki más gépe ezt az autót UGYANAZON a determinisztikus
//  fizikán (sim/car.js updateCar) futtatja tovább, valós időben. Mivel az autónak
//  lendülete van és nem tud pillanatszerűen irányt váltani, ez rendkívül pontos:
//  1,8g oldalgyorsulásnál 100 ms alatt a becslés a valódi ívtől kb. 9 cm-t tér el
//  (szemben a korábbi több méterrel).
//
//  A beérkező hiteles állapothoz SOSEM ugrunk — a különbséget egy exponenciálisan
//  lecsengő korrekcióval simítjuk rá (ugyanaz az elv, ami a saját autó korábbi
//  predikciójánál mérhetően sima volt), így nincs rángatás.
// =============================================================================
import { Vec2 } from 'planck';
import { createCarBody, updateCar, coastToStop, createDriveState, resetCar } from '../sim/car.js';
import { decodeInput } from '../input.js';
import { lerp, lerpAngle } from '../utils.js';

// A hiteles állapottól való eltérés lecsengésének sebessége (1/s). Nagyobb =
// gyorsabban ráigazodik (pontosabb, de rántósabb); kisebb = simább, de lomhább.
const CORRECT_RATE = 9;
// A hiteles SEBESSÉG átvételének mértéke snapshotonként (0..1) — a sebesség
// láthatatlan, ezért bátrabban vehető át, és segíti a pozíció konvergenciáját.
const VEL_BLEND = 0.35;
// Ekkora eltérés fölött már nem simítunk, hanem ugrunk (valódi desync/teleport,
// pl. új verseny, rajtrácsra helyezés) — a simítás itt csak "úszást" okozna.
const TELEPORT_DIST = 12;

export function createRemoteCars(world, offRoad) {
  const cars = new Map(); // id → { body, drive, input, finished, prev, curr, corr }

  function ensure(id, spawn) {
    let c = cars.get(id);
    if (c) return c;
    const s = spawn || { x: 0, y: 0, angle: 0 };
    c = {
      body: createCarBody(world, s.x, s.y, s.angle),
      drive: createDriveState(),
      input: { up: false, down: false, left: false, right: false, drift: false, boost: false },
      finished: false,
      prev: { x: s.x, y: s.y, angle: s.angle },
      curr: { x: s.x, y: s.y, angle: s.angle },
      corr: { x: 0, y: 0, a: 0 }, // lecsengő vizuális korrekció (lásd fent)
    };
    // A TÁVOLI másolatnak NINCS saját kör-követése, tehát a boost-üzemanyagot
    // sosem tudnánk helyesen újratölteni (lásd sim/car.js refillBoost — a
    // SAJÁT raceStep 'lap' eseménye hívja, amit csak a kocsi TULAJDONOSA lát).
    // Ehelyett végtelenre állítjuk: a kapott `inp` bit már ÚGYIS a küldő
    // FÉL saját üzemanyag-korlátos döntését hordozza (lásd main.js mpSendState
    // — a nyers gomb helyett a tényleges mpDrive.boosting megy át a hálón),
    // tehát a másolatnak csak ENGEDELMESKEDNIE kell a kapott bitnek, nem
    // saját maga újra-korlátoznia.
    c.drive.boostRemaining = Infinity;
    cars.set(id, c);
    return c;
  }

  function remove(id) {
    const c = cars.get(id);
    if (!c) return;
    world.destroyBody(c.body);
    cars.delete(id);
  }

  // A pályán maradt, de már nem létező játékosok takarítása.
  function pruneExcept(ids) {
    for (const id of [...cars.keys()]) if (!ids.has(id)) remove(id);
  }

  // Rajtrácsra állítás (új verseny / countdown) — itt SZÁNDÉKOSAN ugrunk.
  function placeAt(id, spawn) {
    const c = ensure(id, spawn);
    resetCar(c.body, spawn.x, spawn.y, spawn.angle);
    Object.assign(c.drive, createDriveState());
    c.drive.boostRemaining = Infinity; // lásd ensure() megjegyzése
    c.prev.x = c.curr.x = spawn.x;
    c.prev.y = c.curr.y = spawn.y;
    c.prev.angle = c.curr.angle = spawn.angle;
    c.corr.x = c.corr.y = c.corr.a = 0;
  }

  // Egy fizika-lépés MINDEN távoli autóra — a saját autóval AZONOS fix dt-vel,
  // ugyanabban a világban (a világ léptetését a hívó végzi, lásd main.js).
  function step(fixedDt, peerPointsFor) {
    for (const [id, c] of cars) {
      c.prev.x = c.curr.x;
      c.prev.y = c.curr.y;
      c.prev.angle = c.curr.angle;
      if (c.finished) coastToStop(c.body);
      else updateCar(c.body, c.input, fixedDt, c.drive, offRoad);
      if (peerPointsFor) peerPointsFor(id, c.body);
    }
  }

  // A lépés UTÁN: az új fizikai állapot rögzítése (al-lépés-interpolációhoz) +
  // a korrekció exponenciális lecsengetése.
  function afterStep(fixedDt) {
    const k = Math.exp(-CORRECT_RATE * fixedDt);
    for (const c of cars.values()) {
      const p = c.body.getPosition();
      c.curr.x = p.x;
      c.curr.y = p.y;
      c.curr.angle = c.body.getAngle();
      c.corr.x *= k;
      c.corr.y *= k;
      c.corr.a *= k;
    }
  }

  function normAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  // Hiteles állapot a szervertől. `ageSec`: mennyi idős az adat (a hálózati út),
  // ennyivel előre becsüljük, hogy a JELENRE igazítsunk — ez szünteti meg a
  // "többiek a múltban vannak" eltolódást.
  function applyAuthoritative(id, p, ageSec) {
    const c = ensure(id, { x: p.x, y: p.y, angle: p.angle });
    c.input = decodeInput(p.inp);
    c.finished = !!p.finished;

    // A hiteles állapot előrevetítése a jelenre (a sebességből — az `age` kicsi,
    // jellemzően egy fél hálózati út, így ez pontos).
    const age = Math.max(0, Math.min(ageSec, 0.5));
    const tx = p.x + (p.vx || 0) * age;
    const ty = p.y + (p.vy || 0) * age;
    const ta = p.angle + (p.w || 0) * age;

    const pos = c.body.getPosition();
    const dx = tx - pos.x;
    const dy = ty - pos.y;
    const da = normAngle(ta - c.body.getAngle());

    if (Math.hypot(dx, dy) > TELEPORT_DIST) {
      // Valódi desync — ugrunk, és a renderelt eltérést sem simítjuk tovább.
      resetCar(c.body, tx, ty, ta);
      c.body.setLinearVelocity(Vec2(p.vx || 0, p.vy || 0));
      c.body.setAngularVelocity(p.w || 0);
      c.prev.x = c.curr.x = tx;
      c.prev.y = c.curr.y = ty;
      c.prev.angle = c.curr.angle = ta;
      c.corr.x = c.corr.y = c.corr.a = 0;
      return;
    }

    // Rutin eltérés: a testet RÁTESSZÜK a hiteles pontra, de a renderelés
    // ugyanott marad (a különbséget a corr-ba tesszük, ami lecseng) — így a
    // fizika pontos, a KÉP viszont nem ugrik.
    c.body.setPosition(Vec2(tx, ty));
    c.body.setAngle(ta);
    const v = c.body.getLinearVelocity();
    c.body.setLinearVelocity(
      Vec2(lerp(v.x, p.vx || 0, VEL_BLEND), lerp(v.y, p.vy || 0, VEL_BLEND))
    );
    c.body.setAngularVelocity(lerp(c.body.getAngularVelocity(), p.w || 0, VEL_BLEND));

    c.prev.x += dx;
    c.prev.y += dy;
    c.prev.angle += da;
    c.curr.x += dx;
    c.curr.y += dy;
    c.curr.angle += da;
    c.corr.x -= dx;
    c.corr.y -= dy;
    c.corr.a -= da;
  }

  // A renderelendő állapot: a két utolsó fizikai lépés közt al-lépés-interpolálva
  // (sima 60 Hz+), plusz a lecsengő korrekció.
  function renderState(id, alpha) {
    const c = cars.get(id);
    if (!c) return null;
    return {
      x: lerp(c.prev.x, c.curr.x, alpha) + c.corr.x,
      y: lerp(c.prev.y, c.curr.y, alpha) + c.corr.y,
      angle: lerpAngle(c.prev.angle, c.curr.angle, alpha) + c.corr.a,
      steer: c.drive.steer, // a kerék-animációhoz (valódi kormányszög!)
      boosting: c.drive.boosting, // a boost-láng effekthez (render3d/carEffects.js)
      body: c.body,
    };
  }

  function has(id) {
    return cars.has(id);
  }

  return { ensure, remove, pruneExcept, placeAt, step, afterStep, applyAuthoritative, renderState, has };
}
