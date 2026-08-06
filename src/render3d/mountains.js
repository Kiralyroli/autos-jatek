// Procedurális "hegygyűrű" a láthatáron — a lapos, egysíkú horizont (és a
// mögötte lévő, ténylegesen véges háttér-síklap, lásd grassField.js)
// eltakarására. Alacsony-poligonszámú, ködbe hajló kúp-sziluettek egy
// gyűrűben a pálya köré, kb. a köd `far` sugarán belül (lásd scene.js
// Fog(220,520)) — így félig-meddig ködösen látszanak, ami éppen a kívánt
// "távoli hegyvonulat" hatást adja, valódi terep-modell nélkül.
//
// SZÁNDÉKOSAN KICSIK (lásd MIN/MAX_HEIGHT/RADIUS) — élő visszajelzés
// alapján a nagy méret közelinek/dombnak hatott, a kis méret viszont
// (ugyanabban a távolságban) a szemnek "távolabbinak" olvasódik — ugyanaz a
// perspektíva-trükk, mint amit a valódi hegyláncok is használnak a
// horizonton. Ugyanazt a fű-textúrát kapják, mint a talaj (grassField.js) —
// ne látszódjon egy külön "hegy-anyag", hanem folytassa a talaj hangulatát.
import * as THREE from 'three';
import { track } from '../sim/track.js';
import { loadTexture } from './assets.js';
import { ASSETS } from '../config.js';

// Minél messzebb, annál jobb — de a kamera vágósíkján (scene.js
// PerspectiveCamera far=700) TÚL már nem renderelődne, a köd (Fog(220,520))
// pedig előtte teljesen elhalványítja. 480 a "térkép szélén" hatást adja
// (majdnem a látótávolság határán, alig kivehetően a ködben), anélkül,
// hogy a kamera vágósíkja levágná.
const RING_OFFSET = 480; // m — ennyivel nyúlik túl a gyűrű a pálya befoglaló sugarán
// SZOROS sáv (nem 120 m, mint korábban) — élő visszajelzés alapján a hegyek
// FOLYTONOSAN, rés nélkül érjenek össze; egy széles sávban szétszórva ez
// nem garantálható, egy keskeny gyűrűben viszont a szomszédos talpkörök
// (lásd HILL_SPACING/MIN_RADIUS aránya lent) mindig átfednek.
const RING_BAND = 25; // m
// A térköz KISEBB, mint a legkisebb hegy átmérője (2×MIN_RADIUS) — ez
// GARANTÁLJA, hogy a szomszédos hegyek talpköre mindig átfedjen, tehát a
// gyűrű folytonos "hegyvonulatnak" hasson, sose látszódjon rajta rés.
const HILL_SPACING = 10; // m
const MIN_HEIGHT = 6;
const MAX_HEIGHT = 18;
const MIN_RADIUS = 12;
const MAX_RADIUS = 26;
const TEXTURE_REPEAT = 4; // a fű-textúra ismétlése egy átlagos hegyen

export async function addMountains(scene) {
  const grassTex = await loadTexture(ASSETS.textures.grass, TEXTURE_REPEAT);

  const xs = track.center.map((p) => p.x);
  const zs = track.center.map((p) => p.z);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  let boundingRadius = 0;
  for (const p of track.center) {
    const d = Math.hypot(p.x - centerX, p.z - centerZ);
    if (d > boundingRadius) boundingRadius = d;
  }

  const ringRadius = boundingRadius + RING_OFFSET;
  const circumference = 2 * Math.PI * ringRadius;
  const count = Math.max(24, Math.round(circumference / HILL_SPACING));

  const group = new THREE.Group();
  for (let i = 0; i < count; i++) {
    // Enyhe véletlen eltolás a szöghöz KÉPEST, hogy a hegyek ne üljenek
    // tökéletesen egyenletes rácson — természetesebb, "szabálytalan" gyűrű.
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * ((Math.PI * 2) / count) * 0.6;
    const r = ringRadius + (Math.random() - 0.5) * RING_BAND;
    const height = MIN_HEIGHT + Math.random() * (MAX_HEIGHT - MIN_HEIGHT);
    const radius = MIN_RADIUS + Math.random() * (MAX_RADIUS - MIN_RADIUS);
    // Alacsony (6-9) oldalszám: szándékosan szabálytalan, "low-poly" hegy-
    // sziluett, ne egy tökéletesen sima kúp.
    const segments = 6 + Math.floor(Math.random() * 4);
    const geo = new THREE.ConeGeometry(radius, height, segments);

    // A csúcspontokat kicsit véletlenszerűen eltoljuk (a talp-kör pontjait
    // NEM, azok maradjanak zártak) — így minden hegy kicsit más alakú, nem
    // egyetlen geometria klónja néz ki ugyanúgy.
    const pos = geo.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      if (Math.abs(pos.getY(v) - height / 2) < 1e-3) {
        pos.setX(v, pos.getX(v) + (Math.random() - 0.5) * radius * 0.4);
        pos.setZ(v, pos.getZ(v) + (Math.random() - 0.5) * radius * 0.4);
      }
    }
    geo.computeVertexNormals();

    const shade = 0.7 + Math.random() * 0.3; // enyhe világosság-változatosság hegyenként
    const mat = new THREE.MeshLambertMaterial({
      map: grassTex || null,
      color: new THREE.Color(0xffffff).multiplyScalar(shade),
      fog: true, // a jelenet ködje halványítsa a távolival egyezően
    });
    const mesh = new THREE.Mesh(geo, mat);
    // A talpat kicsit a talaj alá süllyesztjük, hogy sose látszódjon rés a
    // hegy alja és a fű-síklap közt (lásd grassField.js) — a méret arányában
    // (ne a most már kis hegyeknél is a régi, fix 4 m-es érték süllyessze el
    // szinte a teljes magasságot).
    mesh.position.set(
      centerX + Math.cos(angle) * r,
      height / 2 - height * 0.15,
      centerZ + Math.sin(angle) * r
    );
    mesh.rotation.y = Math.random() * Math.PI * 2;
    group.add(mesh);
  }
  scene.add(group);
}
