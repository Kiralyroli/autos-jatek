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

// RÉGI mentések d.rot mezője negyedfordulat-INDEX volt (0–3, ×90°) — az
// editor.js szabad (R lenyomva tartva + görgő) forgatása óta d.rot RADIÁN.
// UGYANAZ a heurisztika, mint editor.js normalizeRotToRadians-e (lásd ott a
// részletes indoklást) — itt KELL duplikálni, mert ez a függvény a JÁTÉK
// tényleges renderelő útvonala (nem csak a szerkesztő-előnézet), tehát a
// régi mentések helyes forgatásának ITT, futásidőben kell megtörténnie,
// függetlenül attól, hogy a szerkesztőn át vagy közvetlenül (localStorage/
// szerver) érkezett-e az adat.
function normalizeRotToRadians(rot) {
  const r = rot || 0;
  return Number.isInteger(r) && r >= 0 && r <= 3 ? r * (Math.PI / 2) : r;
}

// `decorations` opcionális — alapból a mentett (localStorage) készletet tölti
// be (a játékban ez fut). A pálya-szerkesztő 3D-előnézete (editorPreview.js)
// egy ÉLŐ, még el nem mentett tömböt ad át ugyanebben az alakban, hogy a
// képernyőn éppen lerakott elemek azonnal megjelenjenek.
export async function loadDecorations(scene, decorations = loadCustomDecorations()) {
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

    // `def.scale`: a TÍPUS alap-normalizálása (config.js). `d.scale`: az EGYES
    // példány felhasználó által állított méret-szorzója (editor.js, egérgörgő
    // egy meglévő elem fölött, alapból 1) — a kettő szorzata adja a végleges
    // méretet, hogy egy adott fa/kerítés-példány a többitől függetlenül
    // nagyítható/kicsinyíthető legyen.
    const scaler = new THREE.Group();
    scaler.add(inner);
    scaler.scale.setScalar(TRACK.tile * (def.scale || 1) * (d.scale || 1));

    const holder = new THREE.Group();
    holder.add(scaler);
    // NEGÁLVA: a `d.rot` az editor.js 2D-vásznának SAJÁT konvenciójában van
    // (localToWorld: x'=lx·cosθ−lz·sinθ), ami MATEMATIKAILAG az ELLENKEZŐ
    // előjelű a Three.js rotation.y valódi konvenciójához képest
    // (x'=lx·cosθ+lz·sinθ — élő teszttel, Object3D.localToWorld()-tel
    // ellenőrizve). Enélkül a 3D-ben renderelt forgás a 2D-előnézet/illesztés/
    // ütközés-doboz (sim/car.js resolveDecorationCollisions — UGYANEZT az
    // editor-konvenciót használja) TÜKÖRKÉPE volt — negyedfordulatoknál
    // (a régi, csak 90°-os rendszernél) ez egy szimmetrikus téglalapnál
    // észrevehetetlen, de a szabad (tetszőleges szögű) forgatásnál már valódi,
    // látható eltérés (élő hibajelentés: "az ütközőzónája nem forog vele").
    holder.rotation.y = -normalizeRotToRadians(d.rot);
    // world = dgx/dgy * TRACK.tile (lásd trackStorage.js megjegyzése).
    holder.position.set(d.dgx * TRACK.tile, 0.05, d.dgy * TRACK.tile);
    scene.add(holder);
  }
}
