// =============================================================================
//  BOXUTCA-JELZÉS — a boxhelyek FEHÉR, mindig látható "felfestését" a pálya
//  saját burkolat-generátora adja hozzá (lásd render3d/trackRibbon.js
//  buildPitBoxMarkers, ugyanazzal a szegély-textúrával, mint a rajt/cél
//  csík). EZ a modul csak a JÁTÉKOS SAJÁT boxhelyét emeli ki: egy arany,
//  fénylő felület a fehér téglalap fölött + egy lebegő "BOX" felirat.
//  Multiplayerben minden játékosnak MÁSIK boxhelye van (lásd sim/race.js
//  pitBoxForSlot) — nem kell osztozniuk.
// =============================================================================
import * as THREE from 'three';
import { RACE } from '../config.js';
import { splitPitLane } from '../sim/race.js';

const LABEL_HEIGHT = 5; // m

function createLabelSprite() {
  const canvas = document.createElement('canvas');
  const W = 384;
  const H = 128;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const text = '🔧 BOX';
  ctx.font = '700 56px system-ui, sans-serif';
  const textW = ctx.measureText(text).width;
  const bubbleW = Math.min(W - 8, textW + 60);
  const bubbleH = 84;
  const bx = (W - bubbleW) / 2;
  const by = (H - bubbleH) / 2;
  const r = 24;
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + bubbleW, by, bx + bubbleW, by + bubbleH, r);
  ctx.arcTo(bx + bubbleW, by + bubbleH, bx, by + bubbleH, r);
  ctx.arcTo(bx, by + bubbleH, bx, by, r);
  ctx.arcTo(bx, by, bx + bubbleW, by, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(212, 169, 78, 0.92)'; // arany — ua. mint a HUD-jelzés (#pitStopHud)
  ctx.fill();

  ctx.font = '700 56px system-ui, sans-serif';
  ctx.fillStyle = '#241a05';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(7, (7 * H) / W, 1);
  sprite.position.y = LABEL_HEIGHT;
  sprite.renderOrder = 998;
  return sprite;
}

// A boxhelyhez legközelebbi útvonal-SZAKASZ iránya (radián) — UGYANAZ a
// logika, mint trackRibbon.js buildPitBoxMarkers-jében, hogy az arany
// kiemelés pontosan a fehér téglalapra illeszkedjen.
function laneDirectionNear(pos, path) {
  if (path.length < 2) return 0;
  let bestDist = Infinity;
  let bestDir = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.z - a.z) * dz) / lenSq));
    const cx = a.x + t * dx;
    const cz = a.z + t * dz;
    const d = Math.hypot(pos.x - cx, pos.z - cz);
    if (d < bestDist) {
      bestDist = d;
      bestDir = Math.atan2(dz, dx);
    }
  }
  return bestDir;
}

// Az arany kiemelő felület — a fehér boxhely-keret fölé, kicsivel nagyobb
// Y-on (hogy ne z-fighteljen), félig átlátszó, emissive arany. UGYANAZ a
// hosszában/keresztben elrendezés, mint trackRibbon.js buildPitBoxMarkers-jében.
function createHighlightMesh(pos, dir) {
  const forwardLen = RACE.pitStop.boxDepth; // hosszában
  const lateralLen = RACE.pitStop.boxWidth; // keresztben
  const geo = new THREE.PlaneGeometry(forwardLen, lateralLen);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xd4a94e,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.y = -dir;
  // A trackRibbon.js rétegmagasság-összefoglalója szerinti szint FÖLÖTT (a
  // boxhely-keret 0.09-en van) — átlátszó + depthWrite:false + renderOrder
  // miatt ez amúgy sem versenyezne a mélység-pufferért, de a konzisztencia
  // kedvéért ez is a rétegrend fölött ül.
  mesh.position.set(pos.x, 0.1, pos.z);
  mesh.renderOrder = 1;
  return mesh;
}

// `pitLanePoints`: trackStorage.js loadPitLane() eredménye — a hívó (main.js)
// csak akkor hozza létre, ha van kijelölt boxhely IS (lásd sim/race.js
// pitLaneReady). `myIndex`: a SAJÁT slotIndex-hez tartozó boxhely (lásd
// sim/race.js pitBoxForSlot) — multiplayerben ez a csatlakozás után
// (raceStart) derül ki, addig 0 az alapérték (lásd setMyBoxIndex).
export function createPitMarker(pitLanePoints, myIndex = 0) {
  const group = new THREE.Group();
  const { path, boxes } = splitPitLane(pitLanePoints);
  const worldBoxes = boxes.map((b) => ({ x: b.x, z: b.z, dir: laneDirectionNear(b, path) }));
  const highlight = worldBoxes.length > 0 ? createHighlightMesh(worldBoxes[0], worldBoxes[0].dir) : null;
  if (highlight) group.add(highlight);
  const label = createLabelSprite();
  group.add(label);
  const marker = { group, label, highlight, boxes: worldBoxes };
  setMyBoxIndex(marker, myIndex);
  return marker;
}

// A SAJÁT (arany kiemelésű + lebegő feliratos) boxhely átállítása —
// multiplayerben a slotIndex csak a 'raceStart' üzenetnél derül ki (lásd
// main.js), ezért ezt onnantól hívjuk, nem a létrehozáskor.
export function setMyBoxIndex(marker, index) {
  if (marker.boxes.length === 0) {
    marker.label.visible = false;
    if (marker.highlight) marker.highlight.visible = false;
    return;
  }
  const i = ((index % marker.boxes.length) + marker.boxes.length) % marker.boxes.length;
  const b = marker.boxes[i];
  marker.label.visible = true;
  marker.label.position.set(b.x, LABEL_HEIGHT, b.z);
  if (marker.highlight) {
    marker.highlight.visible = true;
    marker.highlight.position.set(b.x, 0.1, b.z);
    marker.highlight.rotation.y = -b.dir;
  }
}

// Lágy "lebegés" a SAJÁT feliratnak, hogy szembetűnőbb legyen — a hívó
// (main.js) minden képkockában hívja, amíg a kötelezettség nem teljesült
// (utána a hívó eltávolítja/elrejti a jelölőt).
export function updatePitMarker(marker, elapsedSeconds) {
  marker.label.position.y = LABEL_HEIGHT + Math.sin(elapsedSeconds * 2) * 0.3;
}
