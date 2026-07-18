// =============================================================================
//  KERÉK-ANIMÁCIÓ — a Kenney autó-GLB-k kerekei KÜLÖN node-ok (wheel-front-left
//  stb.), így forgathatók (gördülés a sebességgel) és az elsők elfordíthatók
//  (kormányzás). Ez tisztán VIZUÁLIS — a fizika a sim/car.js-ben zajlik.
//
//  A tengelyeket (gördülési + kormányzási) a kerék-POZÍCIÓKBÓL vezetjük le, nem a
//  szerző konkrét tájolásából — így minden Kenney-autónál helyesen működik.
// =============================================================================
import * as THREE from 'three';

// Kulcs-egyszerűsítés a név-egyezéshez (kötőjel/kis-nagybetű független).
function norm(name) {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

// A modell-holderben megkeresi a 4 kereket, és visszaad egy animátort:
//   update(forwardSpeedMs, steerAngleRad, dt)
// Ha nincs meg mind a 4 kerék (más modell), egy no-op animátort ad.
export function setupWheels(modelHolder) {
  const w = { fl: null, fr: null, bl: null, br: null };
  modelHolder.traverse((o) => {
    const n = norm(o.name);
    // FONTOS: a kerék-CSOPORT node-ot vesszük (neve "wheel…"), NEM a GLTFLoader által
    // létrehozott gyerek-mesh-eket ("Mesh_wheel…" → "meshwheel…"). A versenyautóknál
    // a kerék több primitívre bomlik, a gyerek-mesh-ek az origón ülnek — ha azokat
    // fognánk, a tengely-számítás (kerék-pozíciók különbsége) elfajulna, és a kerék
    // nem forogna. A `startsWith('wheel')` kizárja a "mesh…"-előtagú gyerekeket.
    if (!n.startsWith('wheel')) return;
    const f = n.includes('front');
    const b = n.includes('back') || n.includes('rear');
    const l = n.includes('left');
    const r = n.includes('right');
    if (f && l) w.fl = o;
    else if (f && r) w.fr = o;
    else if (b && l) w.bl = o;
    else if (b && r) w.br = o;
  });
  const all = [w.fl, w.fr, w.bl, w.br].filter(Boolean);
  if (all.length < 4) return { update() {} };

  // Az alap-orientáció (erre tesszük rá a gördülést/kormányzást).
  const base = new Map(all.map((o) => [o, o.quaternion.clone()]));

  // Tengelyek a KERÉK-POZÍCIÓKBÓL (a kerekek közös szülő-frame-jében):
  //   axle = bal→jobb (gördülési tengely), fwd = hátsó→első (haladási irány),
  //   up   = a kettő keresztszorzata (kormányzási tengely = az autó függőlegese).
  const axle = new THREE.Vector3().subVectors(w.fr.position, w.fl.position).normalize();
  const midFront = new THREE.Vector3().addVectors(w.fl.position, w.fr.position).multiplyScalar(0.5);
  const midBack = new THREE.Vector3().addVectors(w.bl.position, w.br.position).multiplyScalar(0.5);
  const fwd = new THREE.Vector3().subVectors(midFront, midBack).normalize();
  const up = new THREE.Vector3().crossVectors(axle, fwd).normalize();
  if (up.y < 0) up.negate(); // mutasson felfelé

  // Előjelek: pozitív sebességnél a kerék TETEJE előre gördüljön; jobbkormánynál
  // (steer>0) az első kerék orra jobbra (=+axle felé) forduljon.
  const rollSign = Math.sign(new THREE.Vector3().crossVectors(axle, up).dot(fwd)) || 1;
  const steerSign = Math.sign(new THREE.Vector3().crossVectors(up, fwd).dot(axle)) || 1;

  let rollAngle = 0;
  let radius = 0; // lusta init (világ-méret kell hozzá)
  const rollQ = new THREE.Quaternion();
  const steerQ = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const size = new THREE.Vector3();

  return {
    update(speed, steer, dt) {
      if (radius === 0) {
        w.fl.updateWorldMatrix(true, false);
        new THREE.Box3().setFromObject(w.fl).getSize(size);
        radius = Math.max(size.x, size.y, size.z) / 2 || 0.3;
      }
      rollAngle += rollSign * (speed / radius) * dt;
      rollQ.setFromAxisAngle(axle, rollAngle);
      steerQ.setFromAxisAngle(up, steerSign * steer);
      for (const o of all) {
        q.copy(base.get(o)).premultiply(rollQ); // gördülés (mind a 4)
        if (o === w.fl || o === w.fr) q.premultiply(steerQ); // kormányzás (első 2)
        o.quaternion.copy(q);
      }
    },
  };
}
