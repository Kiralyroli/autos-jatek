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

// Lokális tengelyek világkoordinátában:
//   előre = +x, jobbra (oldalra) = +y
function forwardNormal(body) {
  return body.getWorldVector(Vec2(1, 0));
}
function rightNormal(body) {
  return body.getWorldVector(Vec2(0, 1));
}

// Az aktuális sebesség előre irányú komponense (skalár, m/s — előjeles).
// Exportált: a kerék-gördülés (render3d/wheels.js) is ezt használja.
export function forwardSpeed(body) {
  return Vec2.dot(forwardNormal(body), body.getLinearVelocity());
}

// Létrehoz egy autó-testet a világban. Visszaadja a Planck body-t.
// `car`: opcionális paraméter-objektum (alapból a globális CAR) — lásd updateCar.
export function createCarBody(world, x, y, angle = 0, car = CAR) {
  const body = world.createBody({
    type: 'dynamic',
    position: Vec2(x, y),
    angle,
    // A csillapítást kézzel kezeljük az updateCar-ban, hogy teljes kontrollunk legyen.
    linearDamping: 0,
    angularDamping: 0,
  });
  body.createFixture({
    shape: new Box(car.length / 2, car.width / 2),
    density: car.density,
    friction: 0.3,
  });
  return body;
}

// Az autó perzisztens vezetési állapota (kocsinként egy):
//   throttleMul / wasOnGrass — a fű-büntetés (lásd updateOffRoadPenalty),
//   steer — az AKTUÁLIS kormányszög (rad), ami fokozatosan fordul a cél felé
//           (a kormány nem ugrik, mint a valóságban sem — lásd applySteering).
export function createDriveState() {
  return { throttleMul: 1, wasOnGrass: false, steer: 0 };
}

// Egy fizika-lépés input-feldolgozása. A world.step() ELŐTT hívandó.
//   input: { up, down, left, right, drift } — boolean-ök (lásd input.js)
//   drive: createDriveState() eredménye — a fű-büntetés perzisztens állapota
//   offRoad: (x, y) => méter az útszélen KÍVÜL (0 = úton) — a hívó pályájából
//            (kliensen track.js offRoadExcess, szerveren a szoba trackState-je),
//            így ez a modul környezet- és pálya-független marad.
//   car: opcionális fizika-paraméter objektum (alapból a globális CAR — a
//        SP/predikció ezt használja). A SZERVER szobánként KÜLÖN objektumot ad át
//        (lásd config.js applyPhysicsPreset megjegyzése), mert egy Node-folyamat
//        több szobát is kiszolgálhat egyszerre eltérő választott fizikával — a
//        globális CAR mutálása ilyenkor összeakadna a szobák közt.
export function updateCar(body, input, dt, drive, offRoad, car = CAR) {
  updateSteerAngle(input, dt, drive, car); // előbb a kormányszög, mert a gumik használják
  applyTireFriction(body, input, dt, drive, car);
  updateOffRoadPenalty(body, drive, offRoad);
  applyDrive(body, input, drive, car);
}

// Azonnali váltás: a füvön grassThrottle, az úton mindig teljes (1). Az útról a
// fűre ÁTLÉPÉS pillanatában (nem folyamatosan!) a sebesség is egyszer megvágva
// entrySpeedFactor-ra — ezért kell a wasOnGrass, hogy csak az átlépéskor süljön el.
function updateOffRoadPenalty(body, drive, offRoad) {
  const p = body.getPosition();
  const onGrass = offRoad(p.x, p.y) > 0;
  if (onGrass && !drive.wasOnGrass) {
    body.setLinearVelocity(Vec2.mul(body.getLinearVelocity(), OFFROAD.entrySpeedFactor));
  }
  drive.wasOnGrass = onGrass;
  drive.throttleMul = onGrass ? OFFROAD.grassThrottle : 1;
}

// FONTOS Planck-csapda: a Vec2.prototype.mul() IN-PLACE mutálja a vektort és azt
// adja vissza. Ezért soha nem hívunk .mul()-t megosztott/újrahasznált vektoron —
// helyette a statikus Vec2.mul(v, skalár) új vektort ad, az eredetit nem bántja.

// 1) KERÉK-TAPADÁS, tengelyenként (iforce2d top-down car modell). A kormányzást
//    NEM egy beállított forgási ráta adja, hanem az ELFORDÍTOTT ELSŐ KEREKEK
//    oldalirányú tapadási impulzusa — az autó ezért a valósághoz hűen "az orránál
//    fogva" fordul be (a hátsó tengely körül kanyarodik), nem a közepe körül pörög.
//
//    Tengelyenként: a tengelypontban kioltjuk a KERÉK IRÁNYÁRA merőleges
//    sebesség-komponenst egy ott ható impulzussal (a hátsó kerék a karosszéria
//    irányában áll, az első a kormányszöggel elfordítva). Az impulzus felülről
//    korlátos (tapadási határ) — e fölött a gumi MEGCSÚSZIK: elöl túllépve
//    alulkormányzottság (az orr kifelé tol), hátul túllépve túlkormányzottság/
//    drift (a far kitör) — mind magától adódik, nincs külön szkriptelve.
function applyTireFriction(body, input, dt, drive, car) {
  const m = body.getMass();
  const I = body.getInertia();
  const fwd = forwardNormal(body);
  const com = body.getWorldCenter();
  const half = car.wheelbase / 2;

  // Egy tengelyponton (p) a `n` irányú sebesség-komponens kioltása impulzussal.
  // A pontbeli effektív tömeg: 1/(1/m + c²/I), ahol c = r×n (az impulzus forgató
  // hatása miatt kisebb, mint m) — így PONTOSAN nullázódik a pont sebessége.
  // A |j| ≤ cap a tapadási határ: felette csak a határimpulzus megy át (csúszás).
  function tireImpulse(p, n, cap) {
    const vp = body.getLinearVelocityFromWorldPoint(p);
    const u = Vec2.dot(vp, n);
    const rx = p.x - com.x;
    const ry = p.y - com.y;
    const c = rx * n.y - ry * n.x;
    const meff = 1 / (1 / m + (c * c) / I);
    let j = -u * meff;
    if (j > cap) j = cap;
    if (j < -cap) j = -cap;
    body.applyLinearImpulse(Vec2(n.x * j, n.y * j), p, true);
  }

  // Tapadási határ tengelyenként: a teljes autóra vetített maxLateralAccel fele-fele.
  const axleCap = car.maxLateralAccel * m * 0.5 * dt;

  // HÁTSÓ tengely — a kerék a karosszériával áll egy vonalban; driftnél (Space)
  // a hátsó tapadást csökkentjük (kézifék-effekt: a far kitörhet).
  const rearP = Vec2(com.x - fwd.x * half, com.y - fwd.y * half);
  const rearN = rightNormal(body);
  tireImpulse(rearP, rearN, axleCap * (input.drift ? car.lateralGripDrift : 1));

  // ELSŐ tengely — a kerék a kormányszöggel (drive.steer) elfordítva; a "merőleges"
  // irány is vele fordul. EZ az impulzus fordítja be az autót.
  const frontP = Vec2(com.x + fwd.x * half, com.y + fwd.y * half);
  const cos = Math.cos(drive.steer);
  const sin = Math.sin(drive.steer);
  const rearRight = rightNormal(body);
  const frontN = Vec2(rearRight.x * cos - rearRight.y * sin, rearRight.x * sin + rearRight.y * cos);
  tireImpulse(frontP, frontN, axleCap);
}

// 2) Hajtás — gáz / fék / tolatás + gördülési ellenállás.
function applyDrive(body, input, drive, car) {
  const forward = forwardNormal(body);
  const speed = forwardSpeed(body);

  let force = 0;
  if (input.up) {
    // Csak a GÁZT csökkenti a fű-büntetés — fék és tolatás mindig teljes erővel.
    force = car.engineForce * drive.throttleMul;
  } else if (input.down) {
    // Ha még előre gurul → fék. Ha áll vagy hátrafelé megy → tolatás.
    force = speed > 0.5 ? -car.brakeForce : -car.reverseForce;
  }

  // Sebességhatárok: a határ felett nem adunk több hajtóerőt az adott irányba.
  if (force > 0 && speed > car.maxForwardSpeed) force = 0;
  if (force < 0 && speed < -car.maxReverseSpeed) force = 0;

  // Hajtóerő és gördülési ellenállás egyetlen, forward irányú eredő erőként.
  // (A drag a sebességgel arányos, azzal ellentétes irányú fékerő.)
  const netForce = force - speed * car.forwardDrag * body.getMass();
  body.applyForceToCenter(Vec2.mul(forward, netForce), true);
}

// 3) Kormányszög-rámpa: a kormány fokozatosan fordul a cél felé (bekormányzás
//    steerSpeed, elengedés/ellenkormányzás steerReturnSpeed sebességgel) — nem
//    ugrik ±maxSteerAngle-re egy frame alatt. A tényleges FORDULÁST nem itt,
//    hanem az első kerekek tapadási impulzusa végzi (applyTireFriction).
function updateSteerAngle(input, dt, drive, car) {
  let steerInput = 0;
  if (input.left) steerInput -= 1;
  if (input.right) steerInput += 1;

  const target = steerInput * car.maxSteerAngle;
  const returning = steerInput === 0 || target * drive.steer < 0;
  const rate = returning ? car.steerReturnSpeed : car.steerSpeed;
  const maxDelta = rate * dt;
  drive.steer += Math.max(-maxDelta, Math.min(maxDelta, target - drive.steer));
}

// Cél után: lágy fékezés teljes megállásig, vezérlés nélkül. A world.step() ELŐTT
// hívandó (updateCar helyett). Az oldalcsúszást a tömegközéppontban oltjuk ki
// (itt már nem számít a kanyar-geometria, csak hogy szépen kiguruljon).
export function coastToStop(body, car = CAR) {
  const right = rightNormal(body);
  const lateralSpeed = Vec2.dot(right, body.getLinearVelocity());
  body.applyLinearImpulse(
    Vec2.mul(right, -lateralSpeed * body.getMass()),
    body.getWorldCenter(),
    true
  );
  body.setAngularVelocity(body.getAngularVelocity() * car.steerReleaseDamping);

  const speed = forwardSpeed(body);
  if (Math.abs(speed) < 0.5) {
    // Majdnem áll → teljesen megállítjuk, hogy ne kússzon a végtelenségig.
    body.setLinearVelocity(Vec2(0, 0));
    body.setAngularVelocity(0);
    return;
  }

  // Enyhe fék a haladással szemben + a szokásos gördülési ellenállás.
  const forward = forwardNormal(body);
  const brake = -Math.sign(speed) * car.coastBrakeForce;
  const drag = -speed * car.forwardDrag * body.getMass();
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

// TELJESEN a pályán kívül van-e az autó? Az autó-doboz mind a 4 SARKÁT vizsgáljuk:
// ha MINDEGYIK a burkolaton kívülre esik (offRoad(x,y) > 0), akkor a teljes autó
// elhagyta a pályát (a kör-érvényességhez, race.js). Amíg akár egy sarok az úton
// van, még nem számít. Az offRoad a hívó pályájából jön (kliens track.js / szerver
// trackState) — így ez a modul pálya-független marad.
export function isFullyOffRoad(body, offRoad, car = CAR) {
  const p = body.getPosition();
  const cos = Math.cos(body.getAngle());
  const sin = Math.sin(body.getAngle());
  const hl = car.length / 2;
  const hw = car.width / 2;
  const corners = [
    [hl, hw],
    [hl, -hw],
    [-hl, hw],
    [-hl, -hw],
  ];
  for (const [lx, ly] of corners) {
    const wx = p.x + lx * cos - ly * sin;
    const wy = p.y + lx * sin + ly * cos;
    if (offRoad(wx, wy) <= 0) return false; // ez a sarok még a burkolaton van
  }
  return true;
}
