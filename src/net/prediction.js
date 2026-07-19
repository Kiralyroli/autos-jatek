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
//
//  3) MÁSIK JÁTÉKOSOKKAL ÜTKÖZÉS — PUHA SZÉTNYOMÁS: a merev Box2D-ütközés
//     hálózaton "kései szerver-lökést" adott (a szerver ~1 RTT-vel később, másképp
//     oldotta fel, mint a helyi predikció; a különbség utólag "húzódott rá" a
//     kocsira — a felhasználó ezt érezte). Helyette a kocsik NEM ütköznek mereven
//     (car.js filterGroupIndex −1), és minden fizika-lépésben a saját kocsit
//     gyengéden ELTOLJUK a többi kocsi középpontjától (separateBodyFromPoints,
//     config.RACE.carSeparation). Mivel ez tisztán a pozíciókból számol, a szerver
//     és a kliens UGYANAZT kapja → alig van eltérés → nincs kései rántás. A többi
//     kocsi pozícióját a snapshotból kapjuk (setOpponents), nem kell külön báb-test.
// =============================================================================
import { Vec2 } from 'planck';
import { SIM, RACE } from '../config.js';
import { createWorld } from '../sim/world.js';
import { createCarBody, updateCar, createDriveState, separateBodyFromPoints } from '../sim/car.js';
import { offRoadExcess, spawn } from '../sim/track.js';
import { lerp, lerpAngle } from '../utils.js';

const CORRECT_RATE = 7; // 1/s — nagy korrekció után a vizuális eltolás lecsengése
const TELEPORT_DIST = 12; // m — CSAK valódi desync/teleport: teljes hitelesre állás
const POS_BLEND = 0.1; // snapshot-onkénti lágy pozíció-konvergencia a hitelesre
//   (0.15→0.10: ütközésnél jobban bízunk a helyi fizikában, kisebb korrekciós rántás)

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

  // A többi kocsi AKTUÁLIS középpontjai (a hálózati snapshotból, main.js tölti fel
  // setOpponents-szel) — a PUHA SZÉTNYOMÁSHOZ (separateBodyFromPoints). Nincs többé
  // külön ellenfél-fizikatest/báb: a merev ütközést kivettük (config.RACE.carSeparation),
  // helyette minden fizika-lépésben a saját kocsit gyengéden eltoljuk ezektől a
  // pontoktól — a SZERVER UGYANEZT a determinisztikus számítást végzi, így alig van
  // eltérés → nincs kései "szerver-lökés" (ez volt a korábbi báb-alapú megoldás
  // gyengéje: a merev ütközést a szerver ~1 RTT-vel később másképp oldotta fel).
  let opponentPoints = [];

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
    get steerAngle() {
      return drive.steer; // a kerék-animációhoz (render3d/wheels.js)
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
      drive.steer = 0;
      setBodyState(me);
      const s = snap();
      prev.x = curr.x = s.x;
      prev.y = curr.y = s.y;
      prev.a = curr.a = s.a;
    },

    stop() {
      active = false;
    },

    // A többi kocsi AKTUÁLIS középpontjai a snapshotból — a puha szétnyomáshoz.
    // Csak eltároljuk (a saját id-t a hívó már kiszűri); a tényleges eltolás a
    // frame() fix lépéseiben történik, hogy a szerverrel azonos ütemű legyen.
    setOpponents(points) {
      opponentPoints = points || [];
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
        // Puha szétnyomás a többi kocsitól — a merev ütközés helyett (lásd fenti 3.
        // pont). A szerver a beforeStep-ben UGYANEZT végzi, azonos paraméterekkel.
        separateBodyFromPoints(body, opponentPoints, RACE.carSeparation);
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

    // Szerver-snapshot a saját autónkról. A cél: az ütközés-ÉRZET a helyi predikcióé
    // maradjon, de ~1 RTT-vel később NE legyen egy második, "kései eldobás".
    //   - Rutin eltérés (ide tartozik az ütközés utáni különbség is): a PREDIKÁLT
    //     SEBESSÉGET MEGTARTJUK (a helyi sim már jól kezelte az ütközést; ha itt a
    //     késői szerver-sebességre váltanánk, EZ adná a kései lökést). Csak a POZÍCIÓT
    //     húzzuk lágyan a hiteles felé, a lépést prev/curr+corr-ral maszkolva, hogy a
    //     kép ne ugorjon — a maradék eltolás simán lecseng.
    //   - Csak valódi, teleport-méretű desyncnél állunk teljesen a hitelesre.
    reconcile(me) {
      if (!active) return;

      // A szabadon futó (predikált) TELJES állapot mentése.
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
      const fSteer = drive.steer;

      // "Hiteles most": szerver-állapot + a még nyugtázatlan inputok újrajátszása.
      while (pending.length && pending[0].seq <= (me.seq || 0)) pending.shift();
      setBodyState(me);
      for (const p of pending) simStep(p.input);
      const ax = body.getPosition().x;
      const ay = body.getPosition().y;
      const aa = body.getAngle();

      const dist = Math.hypot(F.x - ax, F.y - ay);
      if (dist > TELEPORT_DIST) {
        // Valódi desync/teleport (ritka): a hitelesre állunk (a body már ott van a
        // replay után), a régi renderelt pozíció eltérését corr-ba tesszük (lecseng).
        corr.x += curr.x - ax;
        corr.y += curr.y - ay;
        corr.a += normAngle(curr.a - aa);
        prev.x = curr.x = ax;
        prev.y = curr.y = ay;
        prev.a = curr.a = aa;
        return;
      }

      // Rutin eltérés: a pozíciót a hiteles felé LÁGYAN közelítjük, a predikált
      // sebességet megtartva. A body elmozdulását prev/curr-ra átvezetjük, és corr-ral
      // ellentételezzük — a render pillanatnyilag változatlan, majd lecsengve rásimul.
      const nx = F.x + (ax - F.x) * POS_BLEND;
      const ny = F.y + (ay - F.y) * POS_BLEND;
      const na = F.angle + normAngle(aa - F.angle) * POS_BLEND;
      const dx = nx - F.x;
      const dy = ny - F.y;
      const da = normAngle(na - F.angle);

      body.setPosition(Vec2(nx, ny));
      body.setAngle(na);
      body.setLinearVelocity(Vec2(F.vx, F.vy)); // predikált sebesség MARAD
      body.setAngularVelocity(F.w);
      drive.throttleMul = fThrottle;
      drive.wasOnGrass = fGrass;
      drive.steer = fSteer;

      prev.x += dx;
      prev.y += dy;
      prev.a += da;
      curr.x += dx;
      curr.y += dy;
      curr.a += da;
      corr.x -= dx;
      corr.y -= dy;
      corr.a -= da;
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
