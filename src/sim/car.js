// =============================================================================
//  AUTÓ — top-down vezetési modell Planck.js-szel. Phaser-mentes, determinisztikus.
//  (Keresőszó a témához: "top-down car physics Box2D".)
//
//  A kulcs az OLDALIRÁNYÚ TAPADÁS: minden lépésben kiszámoljuk az autó test
//  oldalirányú (a haladási irányra merőleges) sebességét, és egy ellentétes
//  impulzussal kioltjuk. Teljes kioltás → nem csúszik kanyarban; részleges → drift.
// =============================================================================
import { Vec2, Box } from 'planck';
import { CAR, OFFROAD, BOOST } from '../config.js';

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

// Az aktuális sebesség OLDALIRÁNYÚ (haladási irányra merőleges) komponense,
// előjeles m/s. Ez a tényleges CSÚSZÁS/DRIFT mértéke — teljes tapadású
// kanyarban közel nulla (a tireImpulse ezt a komponenst oltja ki minden
// lépésben), driftnél viszont nagy, mert a hátsó tengely tapadása szándékosan
// csökkentett (lásd applyTireFriction lateralGripDrift). Exportált: a
// guminyom-effekt (render3d/carEffects.js) ezzel dönti el, mikor "csúszik" az
// autó — MÉRVE: teljes tapadású éles kanyarban ~0.15-0.2 m/s, driftnél 15+ m/s.
export function lateralSpeed(body) {
  return Vec2.dot(rightNormal(body), body.getLinearVelocity());
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
    // filterGroupIndex < 0: az azonos (negatív) csoportba tett testek SOHA nem
    // ütköznek mereven egymással. Az autó-autó ütközést ezért NEM a Box2D merev
    // solvere adja (az hálózaton "kései szerver-lökést" okozott), hanem a puha,
    // determinisztikus szétnyomás (separateBodyFromPoints, RACE.carSeparation).
    // Más fizikai test amúgy sincs a világban (a pálya falait az offRoad-modell
    // helyettesíti), így ettől a kocsik semmivel sem ütköznek mereven.
    filterGroupIndex: -1,
  });
  return body;
}

// AUTÓ-AUTÓ PUHA SZÉTNYOMÁS: a `body`-t gyengéden ELTOLJA a közeli `points`
// (a többi kocsi középpontjai) irányából — a merev ütközés helyett (lásd
// config.RACE.carSeparation). Csak POZÍCIÓT módosít (a sebességet nem), ezért nincs
// pattanás/lendület-átvitel, és mivel tisztán a pozíciókból számol, a szerver és a
// kliens-predikció is UGYANAZT az eredményt adja → nincs kései hálózati rántás.
export function separateBodyFromPoints(body, points, sep) {
  if (!points || points.length === 0) return;
  const p = body.getPosition();
  let cx = 0;
  let cy = 0;
  let any = false;
  for (const pt of points) {
    const dx = p.x - pt.x;
    const dy = p.y - pt.y;
    const d = Math.hypot(dx, dy);
    if (d >= sep.minDist) continue;
    // Egészen egybeeső középpontnál (d≈0) egy tetszőleges, de STABIL irány.
    const nx = d < 1e-4 ? 1 : dx / d;
    const ny = d < 1e-4 ? 0 : dy / d;
    const overlap = sep.minDist - Math.max(d, 0);
    const step = Math.min(overlap * sep.blend, sep.maxStep);
    cx += nx * step;
    cy += ny * step;
    any = true;
  }
  if (!any) return;
  body.setPosition(Vec2(p.x + cx, p.y + cy));
}

// Az autó perzisztens vezetési állapota (kocsinként egy):
//   throttleMul / wasOnGrass — a fű-büntetés (lásd updateOffRoadPenalty),
//   steer — az AKTUÁLIS kormányszög (rad), ami fokozatosan fordul a cél felé
//           (a kormány nem ugrik, mint a valóságban sem — lásd applySteering).
//   boostRemaining — a hátralévő boost-üzemanyag (s), körönként újratöltve
//           (lásd refillBoost — a hívó a raceStep 'lap'/'finish' eseményénél
//           hívja). boosting — a TÉNYLEGESEN alkalmazott boost e lépésben
//           (gomb nyomva ÉS van még üzemanyag) — ezt küldi a hálón a kliens
//           (nem a nyers gombállapotot), hogy a távoli megfigyelők a
//           tényleges (üzemanyag-korlátos) állapotot lássák/szimulálják.
export function createDriveState() {
  return {
    throttleMul: 1,
    wasOnGrass: false,
    steer: 0,
    boostRemaining: BOOST.maxPerLap,
    boosting: false,
    // Tolatás-zár (lásd applyDrive): amíg a fék/tolatás gomb FOLYAMATOSAN nyomva
    // marad egy fékezésből, tolatás nem indulhat — csak ha a gombot elengedtük,
    // majd ÚJRA megnyomtuk, miután az autó már majdnem áll. `prevDown` az előző
    // fizika-lépés gombállapota (az él-észleléshez), `reverseArmed` a döntés maga.
    prevDown: false,
    reverseArmed: false,
  };
}

// A boost-üzemanyag mai állapotának frissítése — a world.step() ELŐTT hívandó
// (updateCar hívja). CSAK akkor fogy (és csak akkor van "boosting" hatás), ha
// a gomb nyomva van, VAN GÁZ IS (input.up), ÉS van hátralévő üzemanyag — a
// boost önmagában (gáz nélkül) UGYANIS semmit nem csinál (lásd applyDrive),
// ezért ne is fogyasszon: különben valaki csak úgy nyomva tartva a gombot
// (fékezés/vitorlázás közben, véletlenül) feleslegesen elfecsérelné.
function updateBoost(input, dt, drive) {
  drive.boosting = !!input.boost && !!input.up && drive.boostRemaining > 0;
  if (drive.boosting) drive.boostRemaining = Math.max(0, drive.boostRemaining - dt);
}

// A boost-üzemanyag teljes újratöltése — körváltáskor/versenykezdéskor hívandó
// (lásd main.js: a raceStep visszaadott eseményei közt 'lap' vagy 'finish').
export function refillBoost(drive) {
  drive.boostRemaining = BOOST.maxPerLap;
}

// Egy fizika-lépés input-feldolgozása. A world.step() ELŐTT hívandó.
//   input: { up, down, left, right, drift, boost } — boolean-ök (lásd input.js)
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
  updateOffRoadPenalty(body, drive, offRoad, car);
  updateBoost(input, dt, drive);
  applyDrive(body, input, drive, car);
}

// Azonnali váltás: a füvön grassThrottle, az úton mindig teljes (1). Az útról a
// fűre ÁTLÉPÉS pillanatában (nem folyamatosan!) a sebesség is egyszer megvágva
// entrySpeedFactor-ra — ezért kell a wasOnGrass, hogy csak az átlépéskor süljön el.
//
// A büntetés csak akkor lép életbe, ha az autó TELJESEN (mind a 4 kerékkel/
// sarokkal) lehagyta az utat — ugyanazt az `isFullyOffRoad` ellenőrzést
// használja, mint a kör-érvényesség (race.js). Amíg akár egy sarok még az
// úton van, nincs lassítás — enélkül már egy kicsit kívülre csúszva is
// visszavágná a sebességet, ami a felhasználó szerint túl szigorú volt.
function updateOffRoadPenalty(body, drive, offRoad, car) {
  const onGrass = isFullyOffRoad(body, offRoad, car);
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

  // BOOST: csak a GÁZ erejét és a csúcssebesség-határt emeli meg (lásd
  // drive.boosting — updateBoost már eldöntötte, van-e még üzemanyag) — a
  // fék/tolatás/gördülési-ellenállás érintetlen. Gáz NÉLKÜL (force==0 marad)
  // a boost semmit nem csinál, tehát önmagában, gomb nyomva tartva sem mozgat.
  const engineForce = drive.boosting ? car.engineForce * car.boostForceMultiplier : car.engineForce;
  const maxForwardSpeed = drive.boosting
    ? car.maxForwardSpeed * car.boostMaxSpeedMultiplier
    : car.maxForwardSpeed;

  let force = 0;
  if (input.up) {
    // Csak a GÁZT csökkenti a fű-büntetés — fék és tolatás mindig teljes erővel.
    force = engineForce * drive.throttleMul;
  } else if (input.down) {
    if (speed > 0.5) {
      // Még előre gurul → fék. Nem tolatás-kész: a gombot előbb el kell engedni.
      force = -car.brakeForce;
    } else {
      // Megállt (vagy majdnem) — a tolatás csak ÚJ gombnyomásra indul (a gomb az
      // ELŐZŐ fizika-lépésen még nem volt nyomva). Élő hibajelentés: enélkül egy
      // FOLYAMATOSAN tartott fékezés magától átcsúszott tolatásba, amint a
      // sebesség 0 alá esett — emiatt gyakorlatilag lehetetlen volt az autót
      // pontosan megállítani (pl. a boxutca-zónában).
      if (!drive.prevDown) drive.reverseArmed = true;
      force = drive.reverseArmed ? -car.reverseForce : 0;
    }
  } else {
    drive.reverseArmed = false; // elengedve → a KÖVETKEZŐ nyomás új ciklus
  }
  drive.prevDown = !!input.down;

  // Sebességhatárok: a határ felett nem adunk több hajtóerőt az adott irányba.
  if (force > 0 && speed > maxForwardSpeed) force = 0;
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

// STATIKUS DEKORÁCIÓ-ÜTKÖZÉS (fal, kerítés, fa, lelátó, garázs stb. — MINDEN
// dekoráció, KIVÉVE a terelőkúpot és a fénykaput, lásd render3d/decorFootprint.js
// buildDecorationColliders). Szándékosan NEM Planck-fixture (lásd
// separateBodyFromPoints megjegyzését — a merev Box2D-solver hálózaton "kései
// szerver-lökést" okozott, és egy category/mask-rendszert kellene bevezetni a
// semmiből, potenciálisan száz+ statikus testhez) — ehelyett ugyanaz a kézzel
// írt, pozíció/sebesség-korrekciós stílus, mint a fenti autó-autó szétnyomás.
//
// Az autót egy KÖRREL közelítjük (sugár = a doboz körülírt köre — kicsit
// nagyvonalú a sarkoknál, de robusztus, és illeszkedik a projekt már meglévő
// kör/pont-alapú egyszerűsítéseihez), a dekorációt egy VILÁG-térben
// elforgatott téglalapként (`colliders[i] = {x,y,rot,halfW,halfD}`, SIM-
// koordinátában — lásd CLAUDE.md 2.5D leképezés, sim.y = render.z).
//
// A `body.getPosition()`-t ELŐBB a dekoráció LOKÁLIS keretébe forgatjuk
// (ugyanaz a technika, mint hitsCone/isFullyOffRoad), a lokális pontot a
// téglalap fél-méreteire vágjuk (clamp) — ez a téglalap LEGKÖZELEBBI pontja
// —, és a távolság ebből dönti el az ütközést. Ha a kör-középpont MÉLYEN a
// dobozon belül van (nagy sebességnél egy lépés alatt "belealudt" — ritka
// védőháló), a legkisebb behatolású tengely mentén tolunk ki.
//
// Ütközésnél KÉT korrekció: (1) POZÍCIÓ, hogy a kör pontosan a doboz szélén
// üljön (nincs átfedés), (2) a doboz felé mutató SEBESSÉG-komponens
// nullázása — ez adja a "nekiütközik és megáll" érzetet, tisztán pozíció/
// sebesség-állítással, impulzus/erő nélkül. Több egyidejűleg átfedő
// dekorációnál a korrekciók EGYMÁS UTÁN, halmozva alkalmazódnak (helyi
// px,py,vx,vy-ban gyűjtve, egyetlen setPosition/setLinearVelocity hívással a
// végén — mint separateBodyFromPoints).
//
// A world.step() UTÁN hívandó (nem az updateCar része, ami ELŐTTE fut) — így
// a frissen integrált pozíciót azonnal korrigálja, nem egy lépés csúszással.
// PONTOS elforgatott-téglalap vs. elforgatott-téglalap ütközés (SAT —
// Separating Axis Theorem), NEM kör-közelítés. Élő hibajelentés: a korábbi
// verzió az autót egy KÖRREL közelítette (sugár = a doboz átlójának fele),
// hogy elkerülje a bonyolultabb matekot — ez viszont szemből/oldalról
// nekihajtva egy jól látható, "levegős" rést hagyott az autó és a modell
// között (a kör sugara minden irányban a LEGNAGYOBB, átlós méretet
// használta, holott szemből csak a fél-hosszúság/fél-szélesség számít).
//
// A SAT módszer: két konvex sokszög (itt: két téglalap) PONTOSAN akkor NEM
// ütközik, ha van legalább EGY tengely, amire vetítve a két alakzat vetülete
// nem fedi egymást — egy téglalapnál elég a 4 saját élirányt (ill. az
// egymással párhuzamos élek miatt csak 2+2 EGYEDI irányt) tesztelni. Ha
// egyik tengelyen SEM található szétválasztás, a legkisebb átfedésű tengely
// adja a kitolás irányát/mértékét (Minimum Translation Vector) — ez PONTOSAN
// annyival tolja ki az autót, hogy a két téglalap éppen csak érintse
// egymást, nincs mesterséges "levegő".
export function resolveDecorationCollisions(body, colliders, car = CAR) {
  if (!colliders || colliders.length === 0) return;
  const pos = body.getPosition();
  let px = pos.x;
  let py = pos.y;
  const angle = body.getAngle();
  let moved = false;

  const carHalfL = car.length / 2;
  const carHalfW = car.width / 2;

  for (const c of colliders) {
    const carFx = Math.cos(angle), carFy = Math.sin(angle); // autó "előre" tengelye (világ)
    const carRx = -Math.sin(angle), carRy = Math.cos(angle); // autó "jobbra" tengelye (világ)
    const decoXx = Math.cos(c.rot), decoXy = Math.sin(c.rot); // dekoráció helyi-X (width) tengelye (világ)
    const decoZx = -Math.sin(c.rot), decoZy = Math.cos(c.rot); // dekoráció helyi-Z (depth) tengelye (világ)

    const dx = c.x - px;
    const dy = c.y - py; // dekoráció-közép − autó-közép

    // A 4 jelölt szétválasztó tengely: az autó és a dekoráció SAJÁT
    // (egymással páronként párhuzamos élű) irányai.
    const axes = [
      [carFx, carFy],
      [carRx, carRy],
      [decoXx, decoXy],
      [decoZx, decoZy],
    ];

    let minOverlap = Infinity;
    let mtvX = 0;
    let mtvY = 0;
    let carProjMTV = 0;
    let separated = false;

    for (const [ax, ay] of axes) {
      const distAlong = dx * ax + dy * ay; // középpontok távolsága a tengely mentén (előjeles)
      const carProj = Math.abs(carHalfL * (carFx * ax + carFy * ay)) + Math.abs(carHalfW * (carRx * ax + carRy * ay));
      const decoProj = Math.abs(c.halfW * (decoXx * ax + decoXy * ay)) + Math.abs(c.halfD * (decoZx * ax + decoZy * ay));
      const overlap = carProj + decoProj - Math.abs(distAlong);
      if (overlap <= 0) {
        separated = true; // találtunk szétválasztó tengelyt — nincs ütközés
        break;
      }
      if (overlap < minOverlap) {
        minOverlap = overlap;
        // A kitolás iránya az autó FELÉ mutasson (a dekorációtól elfelé) —
        // ha a dekoráció a tengely POZITÍV irányában van, az autót a
        // NEGATÍV irányba toljuk.
        const sign = distAlong >= 0 ? -1 : 1;
        mtvX = ax * sign;
        mtvY = ay * sign;
        carProjMTV = carProj;
      }
    }
    if (separated) continue;

    px += mtvX * minOverlap;
    py += mtvY * minOverlap;
    moved = true;

    // A sebesség-korrekciót NEM a tömegközépponton, hanem az ÜTKÖZÉSI PONTON
    // (a kocsi dekoráció felőli szélén) végezzük, ugyanazzal az effektív-tömeg
    // technikával, mint a kerék-tapadás (tireImpulse fent) — ez a forgást IS
    // korrekt módon figyelembe veszi. Élő hibajelentés: a korábbi verzió a
    // tömegközépponti sebességet nullázta, a szögsebességet érintetlenül
    // hagyva — oldalról/ferdén becsapódva ez ellentmondást hagyott a haladási
    // irány és a karosszéria-forgás közt, amit a KÖVETKEZŐ lépés
    // kerék-tapadása (applyTireFriction) extrém, driftszerű pörgésként
    // próbált "kikorrigálni". A ponton vett impulzus ehelyett rögtön
    // konzisztens lendületet ad — nincs mit kikorrigálni.
    const cpx = px - mtvX * carProjMTV;
    const cpy = py - mtvY * carProjMTV;
    const vp = body.getLinearVelocityFromWorldPoint(Vec2(cpx, cpy));
    const vn = vp.x * mtvX + vp.y * mtvY; // az ütközési pont sebessége befelé (a dekorációba) mutató komponense
    if (vn < 0) {
      const com = body.getWorldCenter();
      const rx = cpx - com.x;
      const ry = cpy - com.y;
      const crossN = rx * mtvY - ry * mtvX;
      const invMass = 1 / body.getMass();
      const invI = 1 / body.getInertia();
      const meff = 1 / (invMass + crossN * crossN * invI);
      const j = -vn * meff;
      body.applyLinearImpulse(Vec2(mtvX * j, mtvY * j), Vec2(cpx, cpy), true);
    }
  }

  if (moved) {
    body.setPosition(Vec2(px, py));
  }
}

// Hozzáért-e az autó valamelyik terelőkúphoz? A `points` a kúpok VILÁG-koordinátái
// ({x,y}[], a hívó számolja a dekorációkból — lásd main.js/RaceRoom.js). A kúpot
// pontnak vesszük, az autó dobozát `hitRadius`-szal megnöveljük, majd a pontot az
// autó HELYI keretébe forgatjuk (az isFullyOffRoad-hoz hasonlóan) — ha a megnövelt
// dobozon belülre esik, ütközés történt.
export function hitsCone(body, points, hitRadius, car = CAR) {
  if (!points || points.length === 0) return false;
  const p = body.getPosition();
  const cos = Math.cos(body.getAngle());
  const sin = Math.sin(body.getAngle());
  const hl = car.length / 2 + hitRadius;
  const hw = car.width / 2 + hitRadius;
  for (const pt of points) {
    const dx = pt.x - p.x;
    const dy = pt.y - p.y;
    const lx = dx * cos + dy * sin; // világ → autó helyi kerete (inverz forgatás)
    const ly = -dx * sin + dy * cos;
    if (Math.abs(lx) <= hl && Math.abs(ly) <= hw) return true;
  }
  return false;
}
