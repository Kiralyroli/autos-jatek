// =============================================================================
//  AUTÓ — top-down vezetési modell Planck.js-szel. Phaser-mentes, determinisztikus.
//  (Keresőszó a témához: "top-down car physics Box2D".)
//
//  A kulcs az OLDALIRÁNYÚ TAPADÁS: minden lépésben kiszámoljuk az autó test
//  oldalirányú (a haladási irányra merőleges) sebességét, és egy ellentétes
//  impulzussal kioltjuk. Teljes kioltás → nem csúszik kanyarban; részleges → drift.
// =============================================================================
import { Vec2, Box } from 'planck';
import { CAR, OFFROAD } from '../config.js';
import { offRoadExcess } from './track.js';

// Lokális tengelyek világkoordinátában:
//   előre = +x, jobbra (oldalra) = +y
function forwardNormal(body) {
  return body.getWorldVector(Vec2(1, 0));
}
function rightNormal(body) {
  return body.getWorldVector(Vec2(0, 1));
}

// Az aktuális sebesség előre irányú komponense (skalár, m/s — előjeles).
function forwardSpeed(body) {
  return Vec2.dot(forwardNormal(body), body.getLinearVelocity());
}

// Létrehoz egy autó-testet a világban. Visszaadja a Planck body-t.
export function createCarBody(world, x, y, angle = 0) {
  const body = world.createBody({
    type: 'dynamic',
    position: Vec2(x, y),
    angle,
    // A csillapítást kézzel kezeljük az updateCar-ban, hogy teljes kontrollunk legyen.
    linearDamping: 0,
    angularDamping: 0,
  });
  body.createFixture({
    shape: new Box(CAR.length / 2, CAR.width / 2),
    density: CAR.density,
    friction: 0.3,
  });
  return body;
}

// Az útról letérés miatti gáz-büntetés állapota (a throttleMul a motorerő
// szorzója — lásd applyDrive). Kocsinként egy ilyen objektum él a main.js-ben,
// a versenyt indító resetGame() nullázza vissza 1-re.
export function createDriveState() {
  return { throttleMul: 1, wasOnGrass: false };
}

// Egy fizika-lépés input-feldolgozása. A world.step() ELŐTT hívandó.
//   input: { up, down, left, right, drift } — boolean-ök (lásd input.js)
//   drive: createDriveState() eredménye — a fű-büntetés perzisztens állapota
export function updateCar(body, input, dt, drive) {
  applyLateralTraction(body, input.drift);
  updateOffRoadPenalty(body, drive);
  applyDrive(body, input, drive);
  applySteering(body, input);
}

// Azonnali váltás: a füvön grassThrottle, az úton mindig teljes (1). Az útról a
// fűre ÁTLÉPÉS pillanatában (nem folyamatosan!) a sebesség is egyszer megvágva
// entrySpeedFactor-ra — ezért kell a wasOnGrass, hogy csak az átlépéskor süljön el.
function updateOffRoadPenalty(body, drive) {
  const p = body.getPosition();
  const onGrass = offRoadExcess(p.x, p.y) > 0;
  if (onGrass && !drive.wasOnGrass) {
    body.setLinearVelocity(Vec2.mul(body.getLinearVelocity(), OFFROAD.entrySpeedFactor));
  }
  drive.wasOnGrass = onGrass;
  drive.throttleMul = onGrass ? OFFROAD.grassThrottle : 1;
}

// FONTOS Planck-csapda: a Vec2.prototype.mul() IN-PLACE mutálja a vektort és azt
// adja vissza. Ezért soha nem hívunk .mul()-t megosztott/újrahasznált vektoron —
// helyette a statikus Vec2.mul(v, skalár) új vektort ad, az eredetit nem bántja.

// 1) Oldalirányú tapadás — a csúszó (oldal-) sebesség kioltása impulzussal.
function applyLateralTraction(body, drifting) {
  const grip = drifting ? CAR.lateralGripDrift : CAR.lateralGripNormal;
  const right = rightNormal(body);
  const lateralSpeed = Vec2.dot(right, body.getLinearVelocity());
  // impulzus = tömeg * kívánt sebességváltozás; a grip aránya szabja meg, mennyit oltunk ki.
  const impulse = Vec2.mul(right, -lateralSpeed * body.getMass() * grip);
  body.applyLinearImpulse(impulse, body.getWorldCenter(), true);
}

// 2) Hajtás — gáz / fék / tolatás + gördülési ellenállás.
function applyDrive(body, input, drive) {
  const forward = forwardNormal(body);
  const speed = forwardSpeed(body);

  let force = 0;
  if (input.up) {
    // Csak a GÁZT csökkenti a fű-büntetés — fék és tolatás mindig teljes erővel.
    force = CAR.engineForce * drive.throttleMul;
  } else if (input.down) {
    // Ha még előre gurul → fék. Ha áll vagy hátrafelé megy → tolatás.
    force = speed > 0.5 ? -CAR.brakeForce : -CAR.reverseForce;
  }

  // Sebességhatárok: a határ felett nem adunk több hajtóerőt az adott irányba.
  if (force > 0 && speed > CAR.maxForwardSpeed) force = 0;
  if (force < 0 && speed < -CAR.maxReverseSpeed) force = 0;

  // Hajtóerő és gördülési ellenállás egyetlen, forward irányú eredő erőként.
  // (A drag a sebességgel arányos, azzal ellentétes irányú fékerő.)
  const netForce = force - speed * CAR.forwardDrag * body.getMass();
  body.applyForceToCenter(Vec2.mul(forward, netForce), true);
}

// 3) Kormányzás — sebességfüggő. Álló autó nem fordul helyben.
function applySteering(body, input) {
  let steer = 0;
  if (input.left) steer -= 1;
  if (input.right) steer += 1;

  if (steer === 0) {
    // Nincs kormány-input → a maradék pörgést csillapítjuk (stabilizálódik).
    body.setAngularVelocity(body.getAngularVelocity() * CAR.steerReleaseDamping);
    return;
  }

  const speed = forwardSpeed(body);
  // 0 sebességnél 0 kormányzás, steerSpeedRef felett teljes.
  const speedFactor = Math.min(Math.abs(speed) / CAR.steerSpeedRef, 1);
  // Tolatáskor a kormány "megfordul" (mint egy valódi autónál hátramenetben).
  const dir = speed >= 0 ? 1 : -1;
  body.setAngularVelocity(steer * CAR.maxSteerAngularVel * speedFactor * dir);
}

// Cél után: lágy fékezés teljes megállásig, vezérlés nélkül. A world.step() ELŐTT
// hívandó (updateCar helyett). Az oldaltapadás megmarad (nem sodródik megállás közben).
export function coastToStop(body) {
  applyLateralTraction(body, false);
  body.setAngularVelocity(body.getAngularVelocity() * CAR.steerReleaseDamping);

  const speed = forwardSpeed(body);
  if (Math.abs(speed) < 0.5) {
    // Majdnem áll → teljesen megállítjuk, hogy ne kússzon a végtelenségig.
    body.setLinearVelocity(Vec2(0, 0));
    body.setAngularVelocity(0);
    return;
  }

  // Enyhe fék a haladással szemben + a szokásos gördülési ellenállás.
  const forward = forwardNormal(body);
  const brake = -Math.sign(speed) * CAR.coastBrakeForce;
  const drag = -speed * CAR.forwardDrag * body.getMass();
  body.applyForceToCenter(Vec2.mul(forward, brake + drag), true);
}

// Az autót visszahelyezi a megadott állapotba (új verseny indításához).
export function resetCar(body, x, y, angle) {
  body.setPosition(Vec2(x, y));
  body.setAngle(angle);
  body.setLinearVelocity(Vec2(0, 0));
  body.setAngularVelocity(0);
}

// Segéd a HUD-hoz: aktuális sebesség km/h-ban.
export function speedKmh(body) {
  return body.getLinearVelocity().length() * 3.6;
}

// "Kanyar-terhelés" a gumicsikorgás-hanghoz: |előre-sebesség × kanyarodási ráta|.
// Nagy, ha gyorsan és élesen kanyarodunk (vagy driftelünk); ~0 egyenesben és állva.
export function corneringLoad(body) {
  return Math.abs(forwardSpeed(body) * body.getAngularVelocity());
}
