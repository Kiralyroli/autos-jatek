// =============================================================================
//  PROCEDURÁLIS PÁLYA-HÁLÓ (szabadvonalas pályákhoz) — a diszkrét Kenney
//  csempék (lásd loadTrackTiles) helyett EGY textúrázott "szalag" háló, ami a
//  `center[]` középvonalból (trackFactory.js / trackSpline.js) épül.
//
//  KÉT RÉTEG:
//    - buildRibbonVertexData: az ASZFALT szalag nyers vertex/UV/index tömbjei
//      (roadHalf szélesség, hosszban ismétlődő UV — az aszfalt-textúrához).
//    - buildCurbVertexData: egy vékonyabb SZEGÉLY-szalag mindkét oldalon
//      (roadHalf..roadHalf+curbWidth), egyszínű anyaggal.
//
//  A nyers geometria-generálás (ez a rész) TISZTA — nincs Three.js import, hogy
//  Node-szkripttel is tesztelhető legyen (lásd a projekt sim/ modul-konvencióját).
//  A tényleges THREE.BufferGeometry/Mesh építése (loadTrackRibbon) külön, alul van.
// =============================================================================

// Kumulatív ívhossz a középvonalon (zárt hurok).
function cumulativeArcLength(center) {
  const n = center.length;
  const cum = [0];
  for (let i = 1; i < n; i++) {
    const a = center[i - 1];
    const b = center[i];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return cum;
}

// Az aszfalt-szalag nyers geometriája: 2 vertex/pont (bal/jobb él), 2 háromszög/
// szegmens. Visszatérés: { positions, normals, uvs, indices } (sima számtömbök —
// a hívó alakítja Float32Array/Uint32Array-ré, ha THREE-nek adja át).
// `fallbackRoadHalf`: azokra a pontokra, amelyeknek NINCS `.width` mezője
// (régebbi, e funkció előtt mentett pályák) — lásd trackFactory.js.
export function buildRibbonVertexData(center, fallbackRoadHalf) {
  const n = center.length;
  if (n < 3) throw new Error('buildRibbonVertexData: legalább 3 középvonal-pont kell');
  const cum = cumulativeArcLength(center);
  const vRepeat = 2 * fallbackRoadHalf; // a textúra kb. négyzetesen ismétlődjön

  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0; i < n; i++) {
    const p = center[i];
    const half = Number.isFinite(p.width) ? p.width / 2 : fallbackRoadHalf;
    const lx = p.x + p.nx * half;
    const lz = p.z + p.nz * half;
    const rx = p.x - p.nx * half;
    const rz = p.z - p.nz * half;
    const v = cum[i] / vRepeat;
    positions.push(lx, 0, lz, rx, 0, rz);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, v, 1, v);
  }

  const indices = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const L = 2 * i, R = 2 * i + 1, Ln = 2 * next, Rn = 2 * next + 1;
    // ÉLES SAROK (lásd sim/trackSpline.js — a törésponton két/három bejegyzés
    // kerül UGYANARRA a pozícióra, eltérő haladási iránnyal). A SZOKÁSOS
    // szalag-quad (L,R,Rn,Ln) ilyenkor ÖNMAGÁT METSZŐ ("bowtie") alakot adna —
    // mivel L/R a középponthoz képest átellenes pontok, elforgatva összekötve
    // MATEMATIKAILAG mindig keresztezik egymást, függetlenül a forgás
    // mértékétől (élő hibajelentés — screenshoton látszó, fűbe "beharapó" rés
    // a szegélyen). Helyette a KÖZÖS KÖZÉPPONTBÓL fanolunk — külön háromszög a
    // bal és külön a jobb oldalra —, ami garantáltan nem metszi önmagát.
    const sameCenter = Math.hypot(center[next].x - center[i].x, center[next].z - center[i].z) < 1e-6;
    if (sameCenter) {
      const c = positions.length / 3;
      positions.push(center[i].x, 0, center[i].z);
      normals.push(0, 1, 0);
      uvs.push(0.5, cum[i] / vRepeat);
      indices.push(L, c, Ln);
      indices.push(c, R, Rn);
      continue;
    }
    // Két háromszög/szegmens, CCW winding felülnézetből (kamera mindig +Y fölött
    // van) — ez a sorrend FÜGGETLEN a felhasználó rajzolási irányától (CW/CCW),
    // mert a bal/jobb (L/R) mindig a HALADÁSI IRÁNYHOZ (nx,nz) képest relatív,
    // nem a hurok globális irányához. FONTOS: DoubleSide-dal a rossz sorrend
    // "látszólag" is működne, de a Three.js DOUBLE_SIDED shader-ága a normált
    // gl_FrontFacing szerint MEGFORDÍTJA a hátsó oldalon — ha itt a sorrend
    // fordított volna, a felület "hátulról látszana", a normál lefelé fordulna,
    // és a fény (Hemisphere ground-szín + nulla directional) szinte feketén
    // jelenne meg (élő hibajelentés — pontosan ez történt, míg a sorrend javítva
    // nem lett). Emiatt a hívó FrontSide-ot állít, NEM DoubleSide-ot.
    indices.push(L, Rn, R, L, Ln, Rn);
  }

  return { positions, normals, uvs, indices };
}

// A szegélyszalag (curb) nyers geometriája: 4 vertex/pont (bal-külső, bal-belső,
// jobb-belső, jobb-külső) + UV (a hívó egy fehér/világos textúrát tehet rá).
// `fallbackRoadHalf`: lásd buildRibbonVertexData megjegyzése.
export function buildCurbVertexData(center, fallbackRoadHalf, curbWidth) {
  const n = center.length;
  if (n < 3) throw new Error('buildCurbVertexData: legalább 3 középvonal-pont kell');
  const cum = cumulativeArcLength(center);
  const vRepeat = curbWidth * 2; // kb. négyzetes ismétlődés a keskeny szegélyen

  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0; i < n; i++) {
    const p = center[i];
    const half = Number.isFinite(p.width) ? p.width / 2 : fallbackRoadHalf;
    const outer = half + curbWidth;
    const lOuter = { x: p.x + p.nx * outer, z: p.z + p.nz * outer };
    const lInner = { x: p.x + p.nx * half, z: p.z + p.nz * half };
    const rInner = { x: p.x - p.nx * half, z: p.z - p.nz * half };
    const rOuter = { x: p.x - p.nx * outer, z: p.z - p.nz * outer };
    positions.push(lOuter.x, 0, lOuter.z, lInner.x, 0, lInner.z, rInner.x, 0, rInner.z, rOuter.x, 0, rOuter.z);
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    const v = cum[i] / vRepeat;
    // Bal sáv (LOuter→LInner): u 0→1. Jobb sáv (RInner→ROuter): u 0→1.
    uvs.push(0, v, 1, v, 0, v, 1, v);
  }

  const indices = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const LO = 4 * i, LI = 4 * i + 1, RI = 4 * i + 2, RO = 4 * i + 3;
    const LOn = 4 * next, LIn = 4 * next + 1, RIn = 4 * next + 2, ROn = 4 * next + 3;
    // ÉLES SAROK — lásd buildRibbonVertexData megjegyzése: a szokásos szalag-
    // quad ilyenkor önmagát metsző alakot adna. Egyetlen HÁROMSZÖG sosem lehet
    // önmetsző, ezért a belső (LI/RI, az útszélen lévő) pontot használjuk
    // fanolási csuklópontnak — nincs szükség új vertexre, mint a ribbonnál
    // (ott a csukló a valódi középvonal-pont volt).
    const sameCenter = Math.hypot(center[next].x - center[i].x, center[next].z - center[i].z) < 1e-6;
    if (sameCenter) {
      indices.push(LI, LO, LOn);
      indices.push(LI, LOn, LIn);
      indices.push(RI, ROn, RO);
      indices.push(RI, RIn, ROn);
      continue;
    }
    // Bal szegély-sáv (LOuter..LInner) + jobb szegély-sáv (RInner..ROuter) — CCW
    // winding felülnézetből, lásd buildRibbonVertexData megjegyzése (ugyanaz a
    // winding-irányítási hiba/javítás vonatkozik ide is).
    indices.push(LO, LIn, LI, LO, LOn, LIn);
    indices.push(RI, ROn, RO, RI, RIn, ROn);
  }

  return { positions, normals, uvs, indices };
}

// =============================================================================
//  THREE.js-wrapper — a fenti tiszta vertex-tömbökből épít valódi
//  BufferGeometry/Mesh-t, és hozzáadja a scene-hez. Ez a `loadTrackTiles`
//  (render3d/scene.js) szabadvonalas megfelelője: spline-pályánál EZT hívja a
//  hívó (a régi, csempés utat érintetlenül hagyva a rács-alapú pályáknak).
// =============================================================================
import * as THREE from 'three';
import { ASSETS } from '../config.js';
import { loadTexture } from './assets.js';

function toGeometry(positions, normals, indices, uvs) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  if (uvs) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  // Explicit bounding sphere/box — enélkül a frustum-culling néhány kis
  // méretű meshnél (pl. a rajt/cél csík) tévesen kihagyhatja a renderelésből
  // (élő hibajelentés — a fehér mezők a fű színét mutatták a helyes geometria
  // ellenére, mert a mesh maga egyáltalán nem rajzolódott ki).
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// A rajt/cél kockás csík — csak a FEHÉR mezőknek van GEOMETRIÁJA (nincs
// átlátszó/textúrázott négyzet a "fekete" mezők helyén) — így ott egyszerűen
// nincs semmi lerakva, az alatta lévő aszfalt natívan látszik, nem kell
// átlátszóságra/alpha-tesztre hagyatkozni (ami a WebGL mélység-pufferrel
// kombinálva megbízhatatlannak bizonyult — élő hibajelentés: a "fekete"
// mezőkön a fű színe szivárgott át az aszfalt helyett). `texture`: UGYANAZ a
// fehér vakolat-textúra, mint az oldalsó szegélyen (ASSETS.textures.curb),
// hogy a rajt/cél mezők vizuálisan illeszkedjenek a szegélyhez.
function addStartStripe(scene, p0, roadHalf, texture) {
  const stripeHalfLen = 1; // m — a csík ~2m mély a haladás irányában
  const fx = Math.cos(p0.dir);
  const fz = Math.sin(p0.dir);
  const nx = p0.nx;
  const nz = p0.nz;

  const cols = 8;
  const rows = 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  // Négy sarok egy (i,j) mezőhöz: az (nx,nz) tengely mentén a szélesség (uA..uB
  // oszlop szerint), a haladási irány mentén a mélység (vA..vB sor szerint,
  // -stripeHalfLen..+stripeHalfLen tartományban).
  const cornerAt = (u, v) => {
    const lat = roadHalf - u * 2 * roadHalf; // u=0 → +roadHalf, u=1 → -roadHalf
    const depth = -stripeHalfLen + v * 2 * stripeHalfLen; // v=0 → -mélység, v=1 → +mélység
    return {
      x: p0.x + nx * lat + fx * depth,
      z: p0.z + nz * lat + fz * depth,
    };
  };
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if ((i + j) % 2 !== 0) continue; // sakktábla-minta: csak minden második mező (fehér)
      const uA = i / cols, uB = (i + 1) / cols;
      const vA = j / rows, vB = (j + 1) / rows;
      const a = cornerAt(uA, vA);
      const b = cornerAt(uB, vA);
      const c = cornerAt(uB, vB);
      const d = cornerAt(uA, vB);
      const base = positions.length / 3;
      positions.push(a.x, 0, a.z, b.x, 0, b.z, c.x, 0, c.z, d.x, 0, d.z);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      // Mezőnkénti (nem globális) 0..1 UV — a textúra minden fehér négyzeten
      // teljes egészében megjelenik, nem nyúlik/ismétlődik furcsán.
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  const geo = toGeometry(positions, normals, indices, uvs);
  // FrontSide — lásd roadMat megjegyzését: DoubleSide-dal a Three.js a hátsó
  // oldalon megfordítaná a normált, ami (élő hibajelentés szerint) a
  // Hemisphere-fény "föld" (zöld) színét adta a fehér mezőknek a helyes
  // geometria ellenére is.
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: texture || null,
    emissive: texture ? 0x999999 : 0x000000, // ugyanaz a fényesítés, mint a szegélynél
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.062; // az aszfalt (0.06) fölé, hogy ne z-fighteljen
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Két pont közé illesztett henger — a forgatás-számolgatás helyett quaternion
// segítségével (a henger alap-tengelye +Y, ezt forgatjuk a és b közti irányba).
function cylinderBetween(a, b, radius, material) {
  const start = new THREE.Vector3(a.x, a.y, a.z);
  const end = new THREE.Vector3(b.x, b.y, b.z);
  const diff = new THREE.Vector3().subVectors(end, start);
  const length = diff.length();
  const geo = new THREE.CylinderGeometry(radius, radius, length, 8);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(start).addScaledVector(diff, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), diff.clone().normalize());
  return mesh;
}

// "Fénykapu" a rajt/cél vonal fölött: két oszlop + egy világító gerenda —
// NEM Kenney-modell, egyszerű procedurális geometria, hogy a vonal fölött
// lebegjen, a szalag-pálya folytonos felületét nem érintve.
// JELENLEG NEM HASZNÁLT (élő visszajelzés alapján vizuálisan nem volt jó) —
// a hívása ki van kommentezve loadTrackRibbon végén, a függvény csak
// megmaradt egy esetleges későbbi újrabekötéshez.
function addLightGate(scene, p0, roadHalf) {
  const poleHeight = 5;
  const outer = roadHalf + 0.4; // az útszélen kívül álljanak az oszlopok
  const leftX = p0.x + p0.nx * outer;
  const leftZ = p0.z + p0.nz * outer;
  const rightX = p0.x - p0.nx * outer;
  const rightZ = p0.z - p0.nz * outer;

  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e });
  const leftPole = cylinderBetween({ x: leftX, y: 0, z: leftZ }, { x: leftX, y: poleHeight, z: leftZ }, 0.12, poleMat);
  const rightPole = cylinderBetween({ x: rightX, y: 0, z: rightZ }, { x: rightX, y: poleHeight, z: rightZ }, 0.12, poleMat);
  leftPole.castShadow = true;
  rightPole.castShadow = true;
  scene.add(leftPole);
  scene.add(rightPole);

  const beamMat = new THREE.MeshStandardMaterial({
    color: 0xfff4c2,
    emissive: 0xffe36b,
    emissiveIntensity: 1.8,
  });
  const beam = cylinderBetween(
    { x: leftX, y: poleHeight, z: leftZ },
    { x: rightX, y: poleHeight, z: rightZ },
    0.15,
    beamMat
  );
  scene.add(beam);

  const midX = (leftX + rightX) / 2;
  const midZ = (leftZ + rightZ) / 2;
  const glow = new THREE.PointLight(0xffe36b, 1.5, 25, 2);
  glow.position.set(midX, poleHeight, midZ);
  scene.add(glow);
}

// `track`: a trackFactory.js/trackSpline.js `center[]`-jét tartalmazó objektum
// (ugyanaz az alak, mint amit sim/track.js exportál) — a `center[i].width`
// (ha van) SZAKASZONKÉNT felülírja ezt. `roadHalf`: méterben (lásd config.js
// TRACK) — csak FALLBACK azokra a pontokra, amelyeknek nincs saját width-je
// (régebbi, e funkció előtt mentett pályák). A szegély szélessége (curb) NEM
// paraméter — lásd VISUAL_CURB_WIDTH lent.
export async function loadTrackRibbon(scene, track, roadHalf) {
  const { center } = track;

  // Aszfalt-szalag — FrontSide (NEM DoubleSide!): a winding (lásd
  // buildRibbonVertexData) garantáltan CCW felülnézetből, FÜGGETLENÜL attól,
  // hogy a felhasználó CW vagy CCW irányban rajzolta a hurkot (a bal/jobb
  // mindig a haladási irányhoz relatív). DoubleSide-dal a Three.js a hátsó
  // oldalon MEGFORDÍTANÁ a normált (gl_FrontFacing alapján), ami majdnem
  // fekete, hibás megvilágítást adna — élő hibajelentés alapján javítva.
  const ribbon = buildRibbonVertexData(center, roadHalf);
  const roadGeo = toGeometry(ribbon.positions, ribbon.normals, ribbon.indices, ribbon.uvs);
  // emissive: a PBR aszfalt-textúra elég sötét (nyers albedo, ~12% fényvisszaverés)
  // ahhoz, hogy a jelenet fényei mellett túl sötétnek hasson — a fényforrás-
  // független emissive csak MAGÁT a pályát világosítja fel, a jelenet többi
  // része (fű, autó, ég) érintetlen marad (élő teszttel egyeztetve).
  const roadMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x3a3a3a,
    side: THREE.FrontSide,
  });
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.position.y = 0.06; // ugyanaz a magasság, mint a Kenney út-csempéké
  roadMesh.receiveShadow = true;
  scene.add(roadMesh);

  // Az aszfalt-textúra betöltése + rátétele (a repeat=1: a wrapS/wrapT már
  // RepeatWrapping — lásd loadTexture —, a mi UV-nk maga adja a hosszirányú
  // ismétlést, nem kell külön szorzó).
  const asphaltTex = await loadTexture(ASSETS.textures.asphalt, 1);
  if (asphaltTex) {
    roadMat.map = asphaltTex;
    roadMat.needsUpdate = true;
  }

  // Szegély — keskeny, FEHÉR sáv mindkét oldalon (textúrázott vakolat-minta a
  // Kenney-csempés pályák vékony fehér szegély-festéséhez hasonló hatásért).
  // A VISUAL_CURB_WIDTH szándékosan KESKENYEBB, mint a `curbWidth` paraméter
  // (ami a checkpoint-vonalak félszélességét is szabja máshol — lásd
  // trackFactory.js —, azt nem érinti ez a tisztán vizuális állandó).
  // FrontSide — lásd a roadMat megjegyzését (ugyanaz a winding-javítás vonatkozik ide is).
  const VISUAL_CURB_WIDTH = 0.5;
  const curb = buildCurbVertexData(center, roadHalf, VISUAL_CURB_WIDTH);
  const curbGeo = toGeometry(curb.positions, curb.normals, curb.indices, curb.uvs);
  const curbMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    // Mérsékelt emissive: a vakolat-textúra részletei (repedések, durvaság)
    // látszódjanak, de a sáv összhatásban MÉG mindig egyértelműen fehérnek
    // hasson (lásd roadMat megjegyzése — a nyers PBR-albedo önmagában sötétebb
    // lenne, mint amit "fehér szegély"-ként várunk).
    emissive: 0x999999,
    side: THREE.FrontSide,
  });
  const curbMesh = new THREE.Mesh(curbGeo, curbMat);
  curbMesh.position.y = 0.06;
  curbMesh.receiveShadow = true;
  scene.add(curbMesh);

  const curbTex = await loadTexture(ASSETS.textures.curb, 1);
  if (curbTex) {
    curbMat.map = curbTex;
    curbMat.needsUpdate = true;
  }

  // Rajt/cél kockás csík az úton — a rajt-pont SAJÁT szélessége szerint (ha
  // van neki), különben a fallback roadHalf. Ugyanazt a már betöltött
  // szegély-textúrát (curbTex) használja a fehér mezőkhöz.
  // A fénykapu (addLightGate) SZÁNDÉKOSAN ki van kapcsolva — a felhasználó
  // szerint túl rossz volt vizuálisan, egyelőre elhagyjuk.
  const startHalf = Number.isFinite(center[0].width) ? center[0].width / 2 : roadHalf;
  addStartStripe(scene, center[0], startHalf, curbTex);

  return { roadMesh, curbMesh };
}
