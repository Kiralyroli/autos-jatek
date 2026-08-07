// =============================================================================
//  PÁLYA-SZERKESZTŐ — 3D ELŐNÉZET. A cél: a 2D-ben (editor.js) lerakott
//  kontrollpontokat/dekorációkat UGYANAZZAL a Three.js renderelővel mutatja,
//  amit a játék is használ (render3d/scene.js, trackRibbon.js, decorations.js),
//  hogy a dekorációk VALÓS méretben/takarásban látszódjanak, mielőtt mentenénk.
//
//  SCOPE (leegyeztetve): a pálya VONALÁT és a boxutcát ez a nézet csak
//  MEGJELENÍTI — a kontrollpontok húzása/beszúrása/törlése marad a 2D
//  nézetben. Ami interaktív itt: a DEKORÁCIÓ elhelyezése/törlése/forgatása
//  (rácél-mutatással, raycastGround-on át), plusz egy szabad/vezetői-nézet
//  kamera, hogy úgy lássuk a pályát, mint versenyzés közben.
//
//  A pálya-vonal és a dekorációk MINDIG az editor.js élő (esetleg még nem
//  mentett) állapotából épülnek újra (rebuildEditorTrack/rebuildEditorDecorations)
//  — nincs saját, duplikált állapot ebben a modulban.
// =============================================================================
import * as THREE from 'three';
import { TRACK, ASSETS, DECORATION_TYPES } from '../config.js';
import { createScene3D } from './scene.js';
import { loadTrackRibbon } from './trackRibbon.js';
import { loadDecorations } from './decorations.js';
import { loadModel, loadTexture } from './assets.js';
import { sampleSpline } from '../sim/trackSpline.js';

const GROUND_SIZE = 3000; // m — bőven a szerkesztőben elhelyezhető pályák mérete fölött

// Egy Object3D (és minden gyereke) GPU-erőforrásainak felszabadítása — a
// szerkesztőben gyakori (minden dekoráció-módosításnál) újraépítés nélküle
// GPU-memória-szivárgást okozna (a régi geometriák/anyagok/textúrák sosem
// szabadulnának fel, csak a JS-referenciák).
function disposeObject3D(root) {
  root.traverse((o) => {
    if (o.isMesh || o.isLineSegments) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        m.map?.dispose();
        m.dispose();
      }
    }
  });
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children[group.children.length - 1];
    disposeObject3D(child);
    group.remove(child);
  }
}

// A szerkesztő 3D-jelenete: a valódi játék-renderelőt (createScene3D) hívja,
// autó-mesh nélkül (includeCar:false — nincs vezetett autó a szerkesztőben),
// plusz egy egyszerű, nagy fű-sík talaj (NEM a grassField.js dupla-rétege —
// az a GLOBÁLIS aktív pályához van kötve, itt viszont egy még el nem mentett,
// tetszőlegesen alakuló layout-ot kell kiszolgálni, ezért egy önálló,
// pálya-független síkkal dolgozunk).
export async function createEditorScene(container) {
  const { renderer, scene, camera } = createScene3D(container, { includeCar: false });

  const groundTex = await loadTexture(ASSETS.textures.grass, GROUND_SIZE / 40);
  const groundMat = new THREE.MeshLambertMaterial({
    map: groundTex || null,
    color: groundTex ? 0xffffff : 0x5a8a4a,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  // Külön csoport a pálya-hálónak és a dekorációknak — így egy dekoráció-
  // módosítás nem kényszeríti a (drágább) pálya-szalag újraépítését, és fordítva.
  const trackGroup = new THREE.Group();
  const decorGroup = new THREE.Group();
  scene.add(trackGroup, decorGroup);

  return { renderer, scene, camera, trackGroup, decorGroup };
}

// A pálya-vonal (+ boxutca) újraépítése a szerkesztő ÉLŐ kontrollpontjaiból.
// `pitLanePoints`/`pitBoxPoints`: editor.js saját (még nem kombinált) tömbjei —
// a kombinálást (isBox jelöléssel, lásd editor.js pitLaneForSave) itt végezzük,
// hogy editor.js-nek ne kelljen ismernie trackRibbon.js belső elvárását.
export async function rebuildEditorTrack(trackGroup, points, closed, roadHalf, pitLanePoints, pitBoxPoints) {
  clearGroup(trackGroup);
  if (!closed || points.length < 4) return;
  const center = sampleSpline(points, 2);
  const combinedPitLane = [
    ...pitLanePoints.map((p) => ({ x: p.x, z: p.z })),
    ...pitBoxPoints.map((p) => ({ x: p.x, z: p.z, isBox: true })),
  ];
  await loadTrackRibbon(trackGroup, { center }, roadHalf, combinedPitLane.length >= 2 ? combinedPitLane : undefined);
}

// A dekorációk újraépítése — editor.js `{x,z,type,rot}` (VILÁG-méter) tömbjét
// a decorations.js által várt `{type,dgx,dgy,rot}` (rács-egység) alakra
// képezzük, UGYANAZZAL a képlettel, mint editor.js decorationsForSave()-je.
export async function rebuildEditorDecorations(decorGroup, decorations) {
  clearGroup(decorGroup);
  if (!decorations.length) return;
  const mapped = decorations.map((d) => ({
    type: d.type,
    dgx: d.x / TRACK.tile,
    dgy: d.z / TRACK.tile,
    rot: d.rot || 0,
    scale: d.scale || 1,
  }));
  await loadDecorations(decorGroup, mapped);
}

// Egérpozíció → világ (x,z) a talajsíkon (y=0) — a 3D nézet megfelelője a 2D
// screenToWorld-nek. `canvasEl`: a renderer vászna (getBoundingClientRect a
// kliens-pixel → normalizált eszköz-koordináta átváltáshoz).
const _raycaster = new THREE.Raycaster();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
export function raycastGround(camera, clientX, clientY, canvasEl) {
  const rect = canvasEl.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
  // `setFromCamera` a camera.matrixWorld-ből számol — azt normál esetben a
  // renderelő RAF-hurok (renderer.render) frissíti minden képkockán, DE az
  // első esemény (pl. egy azonnali mousemove az első kép kirajzolása ELŐTT)
  // még a kamera léptetés előtti, elavult mátrixot látná. Az explicit hívás
  // olcsó (nincs geometria/textúra), és garantáltan naprakész irányt ad.
  camera.updateMatrixWorld();
  _raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  const hit = new THREE.Vector3();
  const ok = _raycaster.ray.intersectPlane(_groundPlane, hit);
  return ok ? { x: hit.x, z: hit.z } : null;
}

// Szabad kamera — az EGYETLEN kamera-mód (nincs külön "vezetői"/"orbit"
// váltás): bal egérgomb lenyomva húzással nézünk körbe (yaw/pitch), WASD
// mozgat a nézési irányhoz képest VÍZSZINTESEN, Shift/Ctrl pedig
// FÜGGŐLEGESEN emeli/süllyeszti a kamerát — tehát szabad repülés, nem
// rögzített magasságú "sétálás". Szándékosan NEM PointerLockControls
// (böngésző-API súrlódás/engedélykérés elkerülése) — a meglévő "drag =
// interakció" mintát követi, mint a 2D szerkesztő pont-húzása.
// `target`: {x,z} — a kezdő pozíció ehhez képest (fölé, átlósan) indul.
const MOVE_SPEED = 30; // m/s — vízszintes ÉS függőleges mozgás egyaránt
export function createFreeCameraController(camera, domElement, target) {
  camera.position.set(target.x + 60, 70, target.z + 60);
  let yaw = Math.PI + Math.PI / 4; // a kezdő pozícióból nagyjából a target felé néz
  let pitch = -0.5;
  camera.rotation.order = 'YXZ';
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  const keys = new Set();
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onKeyDown(e) { keys.add(e.code); }
  function onKeyUp(e) { keys.delete(e.code); }
  function onMouseDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; }
  function onMouseUp() { dragging = false; }
  function onMouseMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    yaw -= dx * 0.004;
    pitch -= dy * 0.004;
    pitch = Math.max(-1.4, Math.min(1.4, pitch));
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  domElement.addEventListener('keydown', onKeyDown);
  domElement.addEventListener('keyup', onKeyUp);
  domElement.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  domElement.addEventListener('mousemove', onMouseMove);
  domElement.tabIndex = 0; // hogy a canvas fókuszt kaphasson (keydown-hoz kell)

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  return {
    update: (dt) => {
      // A kamera TÉNYLEGES nézési iránya (Three.js: alapállásban -Z-t néz) —
      // ennek kell megfelelnie a "W = előre" mozgásnak. Élő hibajelentés: a
      // korábbi (sin,cos) előjel a nézési iránnyal ELLENTÉTES vektort adott,
      // ezért a W hátra, az S előre mozgatott.
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      const move = new THREE.Vector3();
      if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
      if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
      if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
      if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
      if (keys.has('ShiftLeft') || keys.has('ShiftRight')) move.y += 1;
      if (keys.has('ControlLeft') || keys.has('ControlRight')) move.y -= 1;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MOVE_SPEED * dt);
        camera.position.add(move);
      }
    },
    dispose: () => {
      domElement.removeEventListener('keydown', onKeyDown);
      domElement.removeEventListener('keyup', onKeyUp);
      domElement.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      domElement.removeEventListener('mousemove', onMouseMove);
    },
  };
}

// Fél-áttetsző "szellem" előnézet a kiválasztott dekorációról, ami a hover-
// pozíciót követi decor módban — ugyanazt a modellt mutatja, mint ami
// lerakáskor tényleg odakerülne.
export function createDecorGhost(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  let currentType = null;
  const modelCache = new Map();
  function ensureModel(type) {
    if (!modelCache.has(type)) {
      const def = DECORATION_TYPES[type];
      modelCache.set(type, def ? loadModel(def.model) : Promise.resolve(null));
    }
    return modelCache.get(type);
  }

  async function setType(type) {
    currentType = type;
    clearGroup(group);
    const model = await ensureModel(type);
    if (!model || type !== currentType) return; // időközben más típusra váltottak
    const def = DECORATION_TYPES[type];
    const inner = model.clone(true);
    inner.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.55;
        o.material.depthWrite = false;
      }
    });
    const box = new THREE.Box3().setFromObject(inner);
    inner.position.x -= (box.min.x + box.max.x) / 2;
    inner.position.z -= (box.min.z + box.max.z) / 2;
    inner.position.y -= box.min.y;
    const scaler = new THREE.Group();
    scaler.add(inner);
    scaler.scale.setScalar(TRACK.tile * (def?.scale || 1));
    group.add(scaler);
  }

  return {
    // `rotRad`: RADIÁN (szabad forgatás — lásd editor.js activeRot/R+görgő),
    // NEM negyedfordulat-index. `scale`: a "kézben" lévő méret-szorzó
    // (activeScale) — a `scaler` (típus-normalizálás) FÖLÉ, a group saját
    // transzformációjaként kerül, hogy típusváltáskor (setType) ne kelljen
    // újraszámolni/újraépíteni semmit emiatt.
    update(type, x, z, rotRad, scale = 1) {
      if (type !== currentType) setType(type); // aszinkron, "fire and forget"
      group.position.set(x, 0.05, z);
      group.rotation.y = rotRad || 0;
      group.scale.setScalar(scale || 1);
      group.visible = true;
    },
    hide() { group.visible = false; },
    dispose() {
      disposeObject3D(group);
      scene.remove(group);
    },
  };
}
