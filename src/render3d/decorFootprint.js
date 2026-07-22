// A dekoráció-típusok VALÓS (méterben vett) alapterülete — a modell tényleges
// Box3-ából számolva, UGYANAZZAL a horgony/skálázás-konvencióval, mint amit a
// render3d/decorations.js a játékban ténylegesen alkalmaz (scaler.scale =
// TRACK.tile * def.scale). Így a szerkesztőben mutatott/illesztett méret
// garantáltan megegyezik a játékban látott mérettel (WYSIWYG) — nem hardkódolt
// becslés, hiszen a Kenney GLB-k node-szintű eltolása/mérete modellenként eltér
// (lásd CLAUDE.md / autos-jatek-kenney-track-geometria memória).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TRACK, DECORATION_TYPES } from '../config.js';

function withBase(url) {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + url;
}

const loader = new GLTFLoader();
const cache = new Map(); // type -> Promise<{width, depth} | null>

// { width, depth } méterben (world-X, world-Z méret, forgatás ELŐTT) — vagy
// null, ha a modell nem tölthető be (hiányzó/hibás fájl).
export function getFootprint(type) {
  if (cache.has(type)) return cache.get(type);
  const def = DECORATION_TYPES[type];
  const promise = new Promise((resolve) => {
    if (!def) return resolve(null);
    loader.load(
      withBase(def.model),
      (gltf) => {
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const scale = TRACK.tile * (def.scale || 1);
        resolve({ width: size.x * scale, depth: size.z * scale });
      },
      undefined,
      () => resolve(null)
    );
  });
  cache.set(type, promise);
  return promise;
}
