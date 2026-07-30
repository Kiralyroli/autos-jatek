// =============================================================================
//  AUTÓ-EFFEKTEK — guminyom (drift) + porfelhő (letérés) — tisztán VIZUÁLIS
//  réteg, semmilyen fizikát/verseny-logikát nem befolyásol.
//
//  BEMENET: sima számok (x, z, angle, lateralSpeed, forwardSpeed, corneringLoad)
//  + az offRoadExcess FÜGGVÉNY (sim/track.js, ill. szerveroldalon a szoba
//  trackState-je) — nem Planck body. A hívó (main.js) a sajátjából és a távoli
//  autókéból (net/remoteCars.js renderState().body) is ugyanígy elő tudja
//  állítani, mindhárom a sim/car.js-ből jön (lateralSpeed/forwardSpeed/
//  corneringLoad).
//
//  PORFELHŐ KIVÁLTÁS: NEM az autó KÖZÉPPONTJA alapján (az csak akkor lépne
//  túl a rázókövön, ha az autó FÉLIG már a fűben van), hanem a doboz mind a 4
//  SARKÁT megnézzük — amint BÁRMELYIK sarok érinti a füvet, indul a por. Ez a
//  sim/car.js isFullyOffRoad "MIND a 4 sarok kint" ellenőrzésének a fordítottja
//  (itt elég, ha EGY sarok van kint).
//
//  KOORDINÁTA-KONVENCIÓ (lásd main.js): a fizika (x,y) síkja a render (x,0,z=y)
//  talajsíkra képződik — a `z` paraméter itt a fizikai y. Az itt használt szög-
//  transzformáció PONTOSAN a main.js `carMesh.rotation.y = -angle` mintáját
//  követi (lásd lent az orientMarkY megjegyzését).
//
//  MEGOSZTOTT (nem autónkénti) pool mindkét effekthez: 2-4 játékosnál egyetlen,
//  fix méretű InstancedMesh/Sprite-készlet bőven elég, és körbeforgó
//  újrahasznosítással (a legrégebbi elem íródik felül) sosem nő korlátlanra,
//  függetlenül a verseny hosszától.
// =============================================================================
import * as THREE from 'three';
import { CAR, EFFECTS } from '../config.js';

// A világ-Y forgatás, ami a helyi +X tengelyt a (dx, 0, dz) irányba forgatja —
// UGYANAZ a képlet, mint amit a main.js `carMesh.rotation.y = -angle` implicit
// használ (world forward = (cos(angle), 0, sin(angle)) ⇔ rotation.y = -angle).
// Levezetés: Three rotation.y(θ) a helyi (1,0,0)-t (cosθ, 0, -sinθ)-be viszi,
// tehát cosθ=dx/len, -sinθ=dz/len → θ = atan2(-dz, dx).
function yawTowards(dx, dz) {
  return Math.atan2(-dz, dx);
}

// Egyszeri, procedurálisan generált lágy körfolt textúra a porfelhőhöz — nincs
// külön asset-fájl (a hangokhoz/modellekhez hasonlóan itt sincs rá szükség,
// ez az effekt teljesen szintetizált, mint pl. az audio.js motorhangja).
function makeDustTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(214,196,168,0.9)');
  grad.addColorStop(0.5, 'rgba(214,196,168,0.45)');
  grad.addColorStop(1, 'rgba(214,196,168,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function createCarEffects(scene) {
  // --- GUMINYOM: egyetlen InstancedMesh, körbeforgó felhasználással ---
  const skidGeo = new THREE.PlaneGeometry(1, 1);
  skidGeo.rotateX(-Math.PI / 2); // vízszintesre fektetve (local +X marad a hossz-tengely)
  const skidMat = new THREE.MeshBasicMaterial({
    color: 0x111111,
    transparent: true,
    opacity: EFFECTS.skid.maxOpacity,
    depthWrite: false, // egymást átfedő nyom-szegmensek ne "villogjanak" a depth-teszttől
    polygonOffset: true,
    polygonOffsetFactor: -1, // az aszfalt/szegély fölé, z-fighting nélkül
  });
  const skidMesh = new THREE.InstancedMesh(skidGeo, skidMat, EFFECTS.skid.poolSize);
  skidMesh.frustumCulled = false; // a pool a teljes pályán szétszóródhat
  const hideMatrix = new THREE.Matrix4().makeScale(0, 0, 0); // 0-skála = láthatatlan
  for (let i = 0; i < EFFECTS.skid.poolSize; i++) skidMesh.setMatrixAt(i, hideMatrix);
  skidMesh.instanceMatrix.needsUpdate = true;
  scene.add(skidMesh);

  let nextSkidIdx = 0;
  const skidTmpMatrix = new THREE.Matrix4();
  const skidTmpQuat = new THREE.Quaternion();
  const skidTmpEuler = new THREE.Euler();

  function dropSkidSegment(x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    skidTmpEuler.set(0, yawTowards(dx, dz), 0);
    skidTmpQuat.setFromEuler(skidTmpEuler);
    skidTmpMatrix.compose(
      new THREE.Vector3((x1 + x2) / 2, 0.064, (z1 + z2) / 2),
      skidTmpQuat,
      new THREE.Vector3(len + EFFECTS.skid.markWidth, 1, EFFECTS.skid.markWidth)
    );
    skidMesh.setMatrixAt(nextSkidIdx, skidTmpMatrix);
    skidMesh.instanceMatrix.needsUpdate = true;
    nextSkidIdx = (nextSkidIdx + 1) % EFFECTS.skid.poolSize;
  }

  // A hátsó kerekek VILÁG-pozíciója (lásd sim/car.js isFullyOffRoad — pontosan
  // ugyanaz a helyi→világ transzformáció, a fizikai `angle`-lel, negálás nélkül,
  // mert a hívó (main.js) is ezt az egyenest alkalmazza a carMesh pozíciójára).
  function rearWheelPos(x, z, angle, side) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const lx = -EFFECTS.skid.rearOffset;
    const ly = side * EFFECTS.skid.wheelOffset;
    return { x: x + lx * cos - ly * sin, z: z + lx * sin + ly * cos };
  }

  // Autónkénti csúszás-állapot (id → { L: {hasLast,x,z}, R: {...} }).
  const skidState = new Map();

  function updateSkid(id, x, z, angle, lateralSpeed, forwardSpeed, corneringLoad) {
    const fastEnough = Math.abs(forwardSpeed) > EFFECTS.skid.minForwardSpeed;
    // KÉT FÜGGETLEN kiváltó ok (lásd config.js EFFECTS megjegyzése): VAGY tényleges
    // csúszás (drift), VAGY elég erőteljes (de még tapadó) kanyarodás — bármelyik
    // elég a nyomhoz.
    const active =
      fastEnough &&
      (Math.abs(lateralSpeed) > EFFECTS.skid.minLateralSpeed ||
        corneringLoad > EFFECTS.skid.minCorneringLoad);
    let st = skidState.get(id);
    if (!st) {
      st = { L: { hasLast: false, x: 0, z: 0 }, R: { hasLast: false, x: 0, z: 0 } };
      skidState.set(id, st);
    }
    if (!active) {
      st.L.hasLast = false;
      st.R.hasLast = false;
      return;
    }
    for (const [side, key] of [[-1, 'L'], [1, 'R']]) {
      const track = st[key];
      const p = rearWheelPos(x, z, angle, side);
      if (!track.hasLast) {
        track.hasLast = true;
        track.x = p.x;
        track.z = p.z;
        continue;
      }
      const d = Math.hypot(p.x - track.x, p.z - track.z);
      if (d < EFFECTS.skid.markSpacing) continue;
      dropSkidSegment(track.x, track.z, p.x, p.z);
      track.x = p.x;
      track.z = p.z;
    }
  }

  // --- PORFELHŐ: pool of THREE.Sprite (auto-billboard), saját anyaggal (per-
  // szemcse eltérő opacitás/méret kell, ezért nem InstancedMesh) ---
  const dustTexture = makeDustTexture();
  const dustSprites = [];
  const dustParticles = []; // párhuzamos tömb: { active, age, x,y,z, vx,vy,vz }
  for (let i = 0; i < EFFECTS.dust.poolSize; i++) {
    const mat = new THREE.SpriteMaterial({
      map: dustTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    scene.add(sprite);
    dustSprites.push(sprite);
    dustParticles.push({ active: false, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
  }
  let nextDustIdx = 0;

  function spawnDustParticle(x, z, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // A porfelhő a hátsó lökhárító mögül indul (helyi -X), enyhe véletlen
    // oldal-szórással — nem egyetlen pontból, hogy ne hasson mesterkéltnek.
    const lx = -EFFECTS.skid.rearOffset - 0.3;
    const ly = (Math.random() - 0.5) * 1.4;
    const wx = x + lx * cos - ly * sin;
    const wz = z + lx * sin + ly * cos;

    const idx = nextDustIdx;
    nextDustIdx = (nextDustIdx + 1) % EFFECTS.dust.poolSize;
    const p = dustParticles[idx];
    p.active = true;
    p.age = 0;
    p.x = wx;
    p.y = 0.15;
    p.z = wz;
    // Hátrafelé (a haladási iránnyal ellentétesen) és oldalra sodródik, plusz
    // emelkedik — a "kerék mögül felkavart por" hatásért.
    const back = EFFECTS.dust.spread * (0.3 + Math.random() * 0.7);
    p.vx = -cos * back + (Math.random() - 0.5) * EFFECTS.dust.spread;
    p.vz = -sin * back + (Math.random() - 0.5) * EFFECTS.dust.spread;
    p.vy = EFFECTS.dust.riseSpeed * (0.6 + Math.random() * 0.8);
    dustSprites[idx].visible = true;
    dustSprites[idx].position.set(p.x, p.y, p.z);
  }

  // Az autó-doboz mind a 4 sarka VILÁG-koordinátában — ugyanaz a helyi→világ
  // transzformáció (és sarok-sorrend), mint a sim/car.js isFullyOffRoad-ban,
  // csak itt ELÉG, ha EGY sarok van kint (lásd fájl-fejléc).
  const CORNER_HL = CAR.length / 2;
  const CORNER_HW = CAR.width / 2;
  function anyCornerOffRoad(x, z, angle, offRoadFn) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const [lx, ly] of [[CORNER_HL, CORNER_HW], [CORNER_HL, -CORNER_HW], [-CORNER_HL, CORNER_HW], [-CORNER_HL, -CORNER_HW]]) {
      const wx = x + lx * cos - ly * sin;
      const wz = z + lx * sin + ly * cos;
      if (offRoadFn(wx, wz) > 0) return true;
    }
    return false;
  }

  const dustState = new Map(); // id → { accum }

  function updateDust(id, x, z, angle, forwardSpeed, offRoadFn, dt) {
    let st = dustState.get(id);
    if (!st) {
      st = { accum: 0 };
      dustState.set(id, st);
    }
    const active =
      Math.abs(forwardSpeed) > EFFECTS.dust.minSpeed && anyCornerOffRoad(x, z, angle, offRoadFn);
    if (!active) {
      st.accum = 0;
      return;
    }
    st.accum += dt;
    // Sebesség-arányos ütem: gyorsabban haladva sűrűbben porzik (természetesebb,
    // mint egy fix időköz), de a spawnInterval szab egy alsó korlátot.
    const interval = EFFECTS.dust.spawnInterval;
    while (st.accum >= interval) {
      st.accum -= interval;
      spawnDustParticle(x, z, angle);
    }
  }

  function stepDustParticles(dt) {
    for (let i = 0; i < dustParticles.length; i++) {
      const p = dustParticles[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= EFFECTS.dust.lifetime) {
        p.active = false;
        dustSprites[i].visible = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const t = p.age / EFFECTS.dust.lifetime;
      const sprite = dustSprites[i];
      sprite.position.set(p.x, p.y, p.z);
      const scale = THREE.MathUtils.lerp(EFFECTS.dust.startScale, EFFECTS.dust.endScale, t);
      sprite.scale.setScalar(scale);
      sprite.material.opacity = EFFECTS.dust.startOpacity * (1 - t);
    }
  }

  // `cars`: [{ id, x, z, angle, lateralSpeed, forwardSpeed, corneringLoad }]
  // `offRoadFn`: (x,z) => méter az útszélen kívül (0 = úton) — sim/track.js
  // offRoadExcess-e (SP-ben és MP-ben is ugyanaz a szoba pályája mindenkinek).
  function update(cars, dt, offRoadFn) {
    for (const c of cars) {
      updateSkid(c.id, c.x, c.z, c.angle, c.lateralSpeed, c.forwardSpeed, c.corneringLoad);
      updateDust(c.id, c.x, c.z, c.angle, c.forwardSpeed, offRoadFn, dt);
    }
    stepDustParticles(dt);
  }

  // Egy játékos eltávozott (MP) — a nyom-állapotát eldobjuk, hogy a maradék
  // csúszás-history ne hagyjon "fantom" szegmenst, ha valaha ugyanaz az id
  // (sessionId) újra előkerülne (nem valószínű, de olcsó tisztán tartani).
  function remove(id) {
    skidState.delete(id);
    dustState.delete(id);
  }

  // ÚJ VERSENY: a nyomoknak/pornak az ELŐZŐ futamból NEM szabad átlógnia az
  // újba — a hívó (main.js) minden versenykezdéskor (SP újraindítás/Hot Lap
  // reset, MP raceStart) meghívja. Az ÖSSZES pool-elemet láthatatlanra
  // állítjuk, a körbeforgó indexet nullázzuk, és minden autó csúszás-/por-
  // állapotát töröljük.
  function reset() {
    for (let i = 0; i < EFFECTS.skid.poolSize; i++) skidMesh.setMatrixAt(i, hideMatrix);
    skidMesh.instanceMatrix.needsUpdate = true;
    nextSkidIdx = 0;
    skidState.clear();

    for (let i = 0; i < dustParticles.length; i++) {
      dustParticles[i].active = false;
      dustSprites[i].visible = false;
    }
    nextDustIdx = 0;
    dustState.clear();
  }

  return { update, remove, reset };
}
