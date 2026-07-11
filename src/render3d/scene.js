// =============================================================================
//  3D JELENET (Three.js) — csak MEGJELENÍTÉS. A játék igazsága a sim/ rétegben fut.
//
//  Koordináta-leképezés (lásd CLAUDE.md, 2.5D döntés): fizika (x, y) → 3D (x, 0, z=y).
//
//  A pálya rétegei a középvonaltól kifelé, mind a track-builder mintavételéből:
//    sóder (a falig) → aszfalt (úton) → rázókő (csak kanyarban) → fal (sóder szélén).
// =============================================================================
import * as THREE from 'three';
import { CAMERA } from '../config.js';
import { track } from '../sim/track.js';
import { loadModel } from './assets.js';

const COLORS = {
  sky: 0x87b5d9,
  carBody: 0x3a80ff,
  carCabin: 0xd8e6ff,
  wheel: 0x1a1a1a,
};

export function createScene3D(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  _scene = scene;
  scene.background = new THREE.Color(COLORS.sky);
  scene.fog = new THREE.Fog(COLORS.sky, 220, 520);

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    700
  );
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  addLights(scene);
  // A rajt/cél elem (Kenney roadStart.glb) a loadTrackTiles-ben kerül le, a
  // rendes út-csempékkel együtt (a modell betöltése async). A talaj, a
  // pálya-felület és a fal MIND Kenney-csempékből (loadTrackTiles, addGrassField,
  // main.js) — nincs procedurális/textúrázott sík.

  const carMesh = new THREE.Group();
  carMesh.add(createCarMesh());
  scene.add(carMesh);

  return { renderer, scene, camera, carMesh, asphaltMesh: null };
}

export function setCarModel(carMesh, modelHolder) {
  carMesh.clear();
  carMesh.add(modelHolder);
}

// Fejlesztői segéd: gömb-jelölő a világ (x,z) pontra (illesztés-ellenőrzéshez).
let _scene = null;
export function debugDot(x, z, color = 0xff00ff, y = 4, r = 3) {
  if (!_scene) return;
  const m = new THREE.Mesh(new THREE.SphereGeometry(r), new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, y, z);
  _scene.add(m);
}

// A Kenney road-csempéket rakja le a builder placements szerint. Async (a modellek
// betöltése). Egy csempét a saját befoglaló-közepére centrálunk, tile-ra skálázunk,
// és a `dir` szerint forgatunk. Az egyenes csempe a szegmens középpontjába kerül.
const TILE = track.tile;

export async function loadTrackTiles(scene) {
  const straight = await loadModel('/assets/track/roadStraight.glb');
  const cornerModels = {
    1: await loadModel('/assets/track/roadCornerSmall.glb'), // sima kanyar (sugár = tile/2)
    2: await loadModel('/assets/track/roadCornerLarge.glb'), // nagyobb sugarú kanyar (1.5×tile)
    3: await loadModel('/assets/track/roadCornerLarger.glb'), // legnagyobb sugarú kanyar (2.5×tile)
  };
  const startGate = await loadModel('/assets/track/roadStart.glb'); // konkrét Kenney rajt/cél elem (kapu)

  const half = TILE / 2;

  // A roadStart.glb 2 csempényi hosszú (a belépő éle ugyanott van, mint egy sima
  // egyenesé — lásd tileHolder 'entry' mód), ezért 2 egymást követő, azonos irányú
  // egyenes csempe helyén fér el. Ha a pálya eleje ennél rövidebb/más (pl. egy
  // egyedi szerkesztett pálya), egyszerűen kimarad — a checkpoint-logikát nem érinti.
  const startTiles = track.tiles;
  const canPlaceStartGate =
    startGate &&
    startTiles.length >= 2 &&
    startTiles[0].type === 'straight' &&
    startTiles[1].type === 'straight' &&
    startTiles[0].dir === startTiles[1].dir;

  if (canPlaceStartGate) {
    const t0 = startTiles[0];
    const inx = t0.cx - Math.cos(t0.dir) * half;
    const inz = t0.cz - Math.sin(t0.dir) * half;
    const holder = tileHolder(startGate, t0.dir, false, 'entry', true);
    holder.position.set(inx, 0.06, inz);
    scene.add(holder);
  }

  for (let i = 0; i < track.tiles.length; i++) {
    if (canPlaceStartGate && (i === 0 || i === 1)) continue; // helyettük a rajt-kapu
    const t = track.tiles[i];
    if (t.type === 'straight') {
      if (!straight) continue;
      // Egyenes: a bbox-közép a cella közepére.
      const holder = tileHolder(straight, t.dir, false, 'center');
      holder.position.set(t.cx, 0.06, t.cz);
      scene.add(holder);
    } else {
      // Kanyar: a mérete (size: 1/2/3) választja ki a Kenney modellt (Small/Large/
      // Larger), a BEMENETI élét (ex,ez — lásd trackbuilder.js) a belépési pontjára.
      const model = cornerModels[t.size] || cornerModels[1];
      if (!model) continue;
      const mirror = t.turn < 0;
      const holder = tileHolder(model, t.dir, mirror, 'entry');
      holder.position.set(t.ex, 0.06, t.ez);
      scene.add(holder);
    }
  }
  // A fal most a szerkesztőben kézzel lerakott "wall" dekoráció (decorations.js).
}

// Egy Kenney csempét igazít: az anchor pontja (lásd lent) az origóba kerül.
//
// FONTOS: a Kenney GLB fájlok node-szinten tartalmaznak egy beépített eltolást
// (pl. translation:[-0.35,-0.01,-0.65]) — emiatt a "raw" accessor-koordináták
// (0.5, 0 stb.) NEM használhatók hardkódolt konstansként az igazításhoz; mindig
// a TÉNYLEGESEN kiszámított `box` (ami már tartalmazza ezt az eltolást) min/max
// értékéből kell levezetni az anchor-pontot.
//
// FONTOS #2: az X-anchor NEM a bbox-közép, hanem `box.min.x + 0.5` — a Kenney-kit
// MINDEN darabja (egyenes, bármilyen méretű kanyar, rajt-kapu) ugyanazt a fix
// "bal szélt" (box.min.x, mindig -0.35) használja az 1 csempényi széles út bal
// pereméhez. A nagyobb kanyaroknál (roadCornerLarge/Larger) a bbox ENNÉL
// SZÉLESEBB (a kifelé táguló ívtől: 2, ill. 3 csempe), ezért a bbox-KÖZÉP hibás
// horgonyt adna — csak size=1-nél (sima kanyar/egyenes) esik egybe a kettő,
// ezért "működött" korábban a bbox-közép képlet is (véletlenül).
//
//   anchorMode 'center': z-ben is a fix "min-szél + 0.5" → cella-közép (egyenes csempe).
//   anchorMode 'entry':  z-ben a bbox MAX-Z éle → a belépési él közepe (kanyar/kapu
//                        csempe; a belépő él a "raw z=0", ami az accessor-tartomány
//                        MAX-vége, tehát box.max.z — ez FÜGGETLEN a méretmegtől, mert
//                        mindig a BELÉPŐ oldalon van, nem a kifelé táguló távolabbi élen).
//
// `xCentered` (opcionális, alapból false): a rajt-kapu (roadStart.glb) NEM
// szimmetrikus — a bbox-a (1.26 csempe) a normál 1-csempés úthoz képest CSAK az
// egyik oldalon (max.x) szélesebb (a kapu-lábak/tartószerkezet miatt), ezért a
// `box.min.x + 0.5` horgony (ami az út-csempéknél helyes) a kapunál FÉLRECSÚSZTATTA
// a modellt az útról. A kapunál ehelyett a teljes bbox KÖZEPét kell horgonyozni
// (xCentered=true), hogy a kapu-szerkezet vizuálisan középre kerüljön az útra —
// ez a régi (a nagy-kanyar-javítás előtti) képlet, csak erre az egy esetre visszaállítva.
function tileHolder(model, dir, mirror, anchorMode, xCentered = false) {
  const inner = model.clone(true);
  inner.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const box = new THREE.Box3().setFromObject(inner);
  const anchorX = xCentered ? (box.min.x + box.max.x) / 2 : box.min.x + 0.5;
  const anchorZ = anchorMode === 'center' ? box.min.z + 0.5 : box.max.z;
  inner.position.x -= anchorX;
  inner.position.z -= anchorZ;
  inner.position.y -= box.min.y; // alja a talajra

  const scaler = new THREE.Group();
  scaler.add(inner);
  scaler.scale.setScalar(TILE);
  if (mirror) {
    scaler.scale.x *= -1;
    // FONTOS: negatív skála megfordítja a háromszögek "winding"-jét, ami a
    // back-face culling miatt LÁTHATATLANNÁ teszi a felületet (a fű "átlátszik"
    // rajta). Kétoldalas renderelés kell — anyagot klónozva, hogy a megosztott
    // (nem tükrözött) csempéket ne érintse.
    //
    // A DoubleSide viszont alapból a shadow-map-et IS mindkét oldalról rajzolja,
    // ami önárnyékolást (csíkos "shadow acne" mintát) okoz a görbült kanyar-
    // felületen — csak a tükrözött (mirror) csempéken volt látható emiatt.
    // Fix: a shadowSide-ot explicit BackSide-ra rögzítjük (ugyanaz, amit a
    // sima FrontSide anyagoknál a Three.js automatikusan használna).
    inner.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.side = THREE.DoubleSide;
        o.material.shadowSide = THREE.BackSide;
      }
    });
  }

  const holder = new THREE.Group();
  holder.add(scaler);
  holder.rotation.y = -dir - Math.PI / 2;
  return holder;
}

export function applyTexture(mesh, texture) {
  if (!mesh || !texture) return;
  mesh.material.map = texture;
  mesh.material.color.set(0xffffff);
  mesh.material.needsUpdate = true;
}

function trackCenter() {
  const xs = track.center.map((p) => p.x);
  const zs = track.center.map((p) => p.z);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
}

function trackSpan() {
  const xs = track.center.map((p) => p.x);
  const zs = track.center.map((p) => p.z);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 80;
}

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x3b5230, 0.9));
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
  const c = trackCenter();
  const span = trackSpan();
  sun.position.set(c.x + 80, 140, c.z + 40);
  sun.castShadow = true;
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.camera.far = 500;
  sun.shadow.mapSize.set(2048, 2048);
  sun.target.position.set(c.x, 0, c.z);
  scene.add(sun, sun.target);
}

function createCarMesh() {
  const car = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 0.7, 2.0),
    new THREE.MeshLambertMaterial({ color: COLORS.carBody })
  );
  body.position.y = 0.65;
  body.castShadow = true;
  car.add(body);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.55, 1.6),
    new THREE.MeshLambertMaterial({ color: COLORS.carCabin })
  );
  cabin.position.set(-0.3, 1.25, 0);
  cabin.castShadow = true;
  car.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 16);
  wheelGeo.rotateX(Math.PI / 2);
  const wheelMat = new THREE.MeshLambertMaterial({ color: COLORS.wheel });
  for (const [wx, wz] of [[1.35, 1.0], [1.35, -1.0], [-1.35, 1.0], [-1.35, -1.0]]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(wx, 0.38, wz);
    wheel.castShadow = true;
    car.add(wheel);
  }
  return car;
}
