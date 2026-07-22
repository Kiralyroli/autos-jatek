// A teljes talaj Kenney grass.glb csempékből — a korábbi textúrázott sík
// helyett. A pálya (track.center) befoglaló téglalapja köré, margóval kitöltve,
// hogy a kamera normál vezetés közben sose lásson "szélét" a mezőnek. A
// csempék saját (egyszerű, sima színű) Kenney-anyaga fölé egy valós fű-fotó
// textúra kerül (ASSETS.textures.grass), hogy a felület részletesebbnek tűnjön.
import * as THREE from 'three';
import { track } from '../sim/track.js';
import { loadModel, loadTexture } from './assets.js';
import { ASSETS } from '../config.js';

const MARGIN = 150; // m — ennyivel nyúlik túl a fű-mező a pálya befoglalóján
const GRASS_TILE = 64; // m — egy fű-csempe mérete (nagyobb, mint az útcsempe, kevesebb elem)

export async function addGrassField(scene) {
  const grass = await loadModel('/assets/track/grass.glb');
  if (!grass) return;
  const grassTex = await loadTexture(ASSETS.textures.grass, ASSETS.textures.grassRepeat);

  const box0 = new THREE.Box3().setFromObject(grass);
  const anchorX = (box0.min.x + box0.max.x) / 2;
  const anchorZ = (box0.min.z + box0.max.z) / 2;
  const groundY = box0.min.y;

  const xs = track.center.map((p) => p.x);
  const zs = track.center.map((p) => p.z);
  const minX = Math.min(...xs) - MARGIN;
  const maxX = Math.max(...xs) + MARGIN;
  const minZ = Math.min(...zs) - MARGIN;
  const maxZ = Math.max(...zs) + MARGIN;

  for (let x = minX; x <= maxX; x += GRASS_TILE) {
    for (let z = minZ; z <= maxZ; z += GRASS_TILE) {
      const inner = grass.clone(true);
      inner.traverse((o) => {
        if (o.isMesh) {
          o.receiveShadow = true;
          if (grassTex) {
            o.material = o.material.clone();
            o.material.map = grassTex;
            o.material.color.set(0xffffff);
            o.material.needsUpdate = true;
          }
        }
      });
      inner.position.x -= anchorX;
      inner.position.z -= anchorZ;
      inner.position.y -= groundY;

      const scaler = new THREE.Group();
      scaler.add(inner);
      scaler.scale.setScalar(GRASS_TILE);

      const holder = new THREE.Group();
      holder.add(scaler);
      // Enyhe véletlen forgatás (90°-onként), hogy a sok azonos csempe ne
      // hasson feltűnően rácsosnak/ismétlődőnek.
      holder.rotation.y = Math.floor(Math.random() * 4) * (Math.PI / 2);
      holder.position.set(x, -0.02, z);
      scene.add(holder);
    }
  }
}
