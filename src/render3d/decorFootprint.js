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

// RÉGI mentések d.rot mezője negyedfordulat-INDEX volt (0–3, ×90°) — az
// editor.js szabad (R lenyomva tartva + görgő) forgatása óta d.rot RADIÁN.
// UGYANAZ a heurisztika, mint editor.js/decorations.js normalizeRotToRadians-e
// (lásd ott a részletes indoklást) — ide is duplikálva kell, ugyanazért, amiért
// decorations.js-be is: ez a modul is önállóan, a saját adatfolyamán fut.
function normalizeRotToRadians(rot) {
  const r = rot || 0;
  return Number.isInteger(r) && r >= 0 && r <= 3 ? r * (Math.PI / 2) : r;
}

// A fizikai ütközéshez szükséges dekoráció-dobozok (lásd sim/car.js
// resolveDecorationCollisions) — MINDEN dekorációra, KIVÉVE a terelőkúpot
// (pylon — az ma is csak egy kör-érvényességi jelzés, nem akadály) és a
// fénykaput (lightGate — a pálya FÖLÉ, magasra tervezett elem; a 2D-fizika
// nem tud Y-magasságot kezelni, ezért fizikailag "át lehet menni alatta"
// marad, mint eddig). `decorations`: a mentett/betöltött alak
// (`{type,dgx,dgy,rot,scale}[]`, lásd trackStorage.js/editor.js
// decorationsForSave). A visszaadott dobozok SIM-koordinátában vannak
// (`{x,y,rot,halfW,halfD}` — sim.y = render.z, lásd CLAUDE.md 2.5D
// leképezés), közvetlenül átadhatók `resolveDecorationCollisions`-nak.
export async function buildDecorationColliders(decorations) {
  const results = await Promise.all(
    decorations
      .filter((d) => d.type !== 'pylon' && d.type !== 'lightGate')
      .map(async (d) => {
        const fp = await getFootprint(d.type);
        if (!fp) return null;
        const scale = d.scale || 1;
        return {
          x: d.dgx * TRACK.tile,
          y: d.dgy * TRACK.tile,
          rot: normalizeRotToRadians(d.rot),
          halfW: (fp.width * scale) / 2,
          halfD: (fp.depth * scale) / 2,
        };
      })
  );
  return results.filter(Boolean);
}
