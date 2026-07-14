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
//  3) MÁSIK JÁTÉKOSOKKAL ÜTKÖZÉS: a saját autó privát fizika-világában eddig a
//     TÖBBI kocsi egyáltalán nem létezett (csak a renderelt "szellem"-mesh a
//     snapshot-interpolációból) — így a lokális ütközés hatása csak a szerver
//     visszajelzése (hálózati kör + reconcile-simítás) UTÁN látszott, érezhető
//     késéssel. Ezért a többi kocsit is felvesszük ebbe a világba (syncOpponents),
//     a saját kocsival AZONOS tömegű DINAMIKUS testként — FONTOS: nem kinematikus,
//     mert a kinematikus test végtelen tömegű/mozdíthatatlan a Box2D-ben, ütközéskor
//     falba szaladásnak érződött (azonnal megállás, majd a reconcile nagy korrekciója
//     miatt "szétrepülés"). Dinamikus testként a lökés arányosan (kb. fele-fele)
//     oszlik meg — valódi autó-autó ütközés érzete. A pozícióját nem teleportáljuk
//     (az kioltaná a fizikai lökést), hanem sebességgel HÚZZUK a hálózati célra —
//     ütközés közben is önkorrigál, de nem "fal".
// =============================================================================
import { Vec2, Box } from 'planck';
import { SIM, CAR } from '../config.js';
import { createWorld } from '../sim/world.js';
import { createCarBody, updateCar, createDriveState } from '../sim/car.js';
import { offRoadExcess, spawn } from '../sim/track.js';
import { lerp, lerpAngle } from '../utils.js';

const CORRECT_RATE = 9; // 1/s — nagy korrekció után a vizuális eltolás lecsengése
const TELEPORT_DIST = 12; // m — CSAK valódi desync/teleport: teljes hitelesre állás
const POS_BLEND = 0.15; // snapshot-onkénti lágy pozíció-konvergencia a hitelesre

// A többi játékos ütköző-testének hálózati-pozíció-követése. FONTOS: a korrekciót
// KLAMPOLNI kell — a régi (pozíció-hiba / dt) sebesség ütközéskor felrobbant (a
// kontakt eltolta a testet, a következő frame a hibát ×60-nal visszahajtotta a
// kocsiba → mély átfedés → "szétrepülés"). Helyette a hálózati SEBESSÉG a bázis,
// arra jön egy lágy, felülről korlátozott pozíció-korrekció.
const OPP_CORRECT_GAIN = 8; // 1/s — pozíció-hiba → korrekciós sebesség
const OPP_MAX_CORRECT = 6; // m/s — a korrekciós sebesség FELSŐ korlátja (nincs berántás)
const OPP_TELEPORT = 4; // m — e fölötti desync/penetráció után egyszeri áthelyezés

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

  // A többi játékos DINAMIKUS (azonos tömegű) ütköző-teste — lásd fenti 3. pont.
  const opponents = new Map(); // id -> { body }

  function ensureOpponent(id, x, y, angle) {
    let o = opponents.get(id);
    if (!o) {
      const oBody = world.createBody({
        type: 'dynamic',
        position: Vec2(x, y),
        angle,
        linearDamping: 0,
        angularDamping: 0,
      });
      oBody.createFixture({
        shape: new Box(CAR.length / 2, CAR.width / 2),
        density: CAR.density,
        friction: 0.3,
        restitution: 0, // NINCS pattanás — a "szétrepülés" egyik forrása kizárva
      });
      o = { body: oBody };
      opponents.set(id, o);
    }
    return o;
  }

  function removeOpponent(id) {
    const o = opponents.get(id);
    if (o) {
      world.destroyBody(o.body);
      opponents.delete(id);
    }
  }

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

    // A többi játékos ütköző-testének követése a hálózati állapothoz. A bázis a
    // hálózati SEBESSÉG (vx,vy) — így fizikailag valós mozgásuk van —, arra jön egy
    // LÁGY, KLAMPOLT pozíció-korrekció (nem a régi hiba/dt, ami ütközéskor robbant).
    // Csak tényleg nagy desync/penetráció esetén teleportálunk egyszer. A testek
    // láthatatlanok (a renderelt mesh a snapshot-interpolációból jön), így a kis
    // pozíció-lemaradás nem látszik — csak a saját kocsi ütközés-válasza számít.
    syncOpponents(players, myId, dt) {
      const seen = new Set();
      for (const [id, p] of Object.entries(players)) {
        if (id === myId) continue;
        seen.add(id);
        const o = ensureOpponent(id, p.x, p.y, p.angle);
        const cp = o.body.getPosition();
        const ex = p.x - cp.x;
        const ey = p.y - cp.y;
        if (Math.hypot(ex, ey) > OPP_TELEPORT) {
          // Nagy eltérés (spawn / teleport / mély átfedés utáni helyreállás).
          o.body.setPosition(Vec2(p.x, p.y));
          o.body.setLinearVelocity(Vec2(p.vx || 0, p.vy || 0));
        } else {
          // Hálózati sebesség + klampolt pozíció-korrekció.
          let cx = ex * OPP_CORRECT_GAIN;
          let cy = ey * OPP_CORRECT_GAIN;
          const cs = Math.hypot(cx, cy);
          if (cs > OPP_MAX_CORRECT) {
            cx = (cx / cs) * OPP_MAX_CORRECT;
            cy = (cy / cs) * OPP_MAX_CORRECT;
          }
          o.body.setLinearVelocity(Vec2((p.vx || 0) + cx, (p.vy || 0) + cy));
        }
        o.body.setAngle(p.angle);
        o.body.setAngularVelocity(0);
      }
      for (const id of [...opponents.keys()]) {
        if (!seen.has(id)) removeOpponent(id);
      }
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
