// A pálya-szerkesztőben (editor.html) elhelyezett dekorációk (fal, fa, épület...)
// betöltése és elhelyezése a 3D jelenetben. Csak MEGJELENÍTÉS — nincs fizikai
// ütközés ezekkel az elemekkel (Fázis 1-ben nem cél).
//
// FONTOS (lásd CLAUDE.md / autos-jatek-kenney-track-geometria memória): a Kenney
// GLB-k node-szinten tartalmazhatnak beépített eltolást, ezért az anchor-pontot
// MINDIG a ténylegesen kiszámított Box3-ból vezetjük le, sosem hardkódolt
// konstansból (ez okozta a pálya-csempék korábbi elcsúszását).
import * as THREE from 'three';
import { TRACK, DECORATION_TYPES } from '../config.js';
import { loadCustomDecorations } from '../trackStorage.js';
import { loadModel } from './assets.js';

export async function loadDecorations(scene) {
  const decorations = loadCustomDecorations();
  if (!decorations.length) return;

  // Típusonként egyszer töltjük be a modellt, utána példányonként klónozzuk.
  const modelCache = new Map();
  async function getModel(type) {
    if (!modelCache.has(type)) {
      const def = DECORATION_TYPES[type];
      modelCache.set(type, def ? await loadModel(def.model) : null);
    }
    return modelCache.get(type);
  }

  for (const d of decorations) {
    const def = DECORATION_TYPES[d.type];
    if (!def) continue;
    const model = await getModel(d.type);
    if (!model) continue;

    const inner = model.clone(true);
    inner.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    // Anchor: a bbox X/Z-közepe az origóba, alja a talajra — a TÉNYLEGES
    // (node-transzformációt is tartalmazó) box-ból, nem hardkódolt számból.
    const box = new THREE.Box3().setFromObject(inner);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    inner.position.x -= cx;
    inner.position.z -= cz;
    inner.position.y -= box.min.y;

    const scaler = new THREE.Group();
    scaler.add(inner);
    scaler.scale.setScalar(TRACK.tile * (def.scale || 1));

    const holder = new THREE.Group();
    holder.add(scaler);
    holder.rotation.y = (d.rot || 0) * (Math.PI / 2);
    // world = dgx/dgy * TRACK.tile (lásd trackStorage.js megjegyzése).
    holder.position.set(d.dgx * TRACK.tile, 0.05, d.dgy * TRACK.tile);
    scene.add(holder);
  }
}
