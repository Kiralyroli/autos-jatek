// A teljes talaj Kenney grass.glb csempékből — a korábbi textúrázott sík
// helyett. A pálya (track.center) befoglaló téglalapja köré, margóval kitöltve,
// hogy a kamera normál vezetés közben sose lásson "szélét" a mezőnek. A
// csempék saját (egyszerű, sima színű) Kenney-anyaga fölé egy valós fű-fotó
// textúra kerül (ASSETS.textures.grass), hogy a felület részletesebbnek tűnjön.
//
// A részletes csempézés (GRASS_TILE méretű elemek) csak a MARGIN-ig tart —
// ez a legtöbb pályánál elég, DE élő hibajelentés szerint néhány nagyobb
// pályánál/kameraszögnél mégis látszott a mező vége (a köd — lásd scene.js
// Fog(220,520) — nem takarta el, mert a részletes mező széle a köd
// hatótávolságán belül ért véget). Ezért a csempézett mező ALÁ egy
// EGYETLEN, hatalmas (BIG_GROUND_SIZE) síklap kerül, ugyanazzal a
// fű-textúrával, jóval túlnyúlva a kamera vágósíkján (CAMERA far=700 m,
// lásd scene.js) — így a mezőnek gyakorlatilag SOSEM érhető el/látszik a
// széle, bárhonnan nézve. Mivel ez a réteg messze van és a köd amúgy is
// eltakarja a részleteit, egyetlen lapos sík (2 háromszög) bőven elég —
// nem kell csempézni, elhanyagolható a render-költsége.
import * as THREE from 'three';
import { track } from '../sim/track.js';
import { loadModel, loadTexture } from './assets.js';
import { ASSETS } from '../config.js';

const MARGIN = 150; // m — ennyivel nyúlik túl a fű-mező a pálya befoglalóján
const GRASS_TILE = 64; // m — egy fű-csempe mérete (nagyobb, mint az útcsempe, kevesebb elem)
const BIG_GROUND_SIZE = 6000; // m — a "sosincs látható széle" háttér-sík mérete
const BIG_GROUND_REPEAT = 300; // a háttér-sík textúra-ismétlése (csak közelről számítana, de messze van/ködös)

export async function addGrassField(scene) {
  const xs = track.center.map((p) => p.x);
  const zs = track.center.map((p) => p.z);
  const minX = Math.min(...xs) - MARGIN;
  const maxX = Math.max(...xs) + MARGIN;
  const minZ = Math.min(...zs) - MARGIN;
  const maxZ = Math.max(...zs) + MARGIN;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;

  // A hatalmas háttér-sík FÜGGETLENÜL a részletes grass.glb csempéktől —
  // akkor is legyen "vég nélküli" talaj, ha a modell betöltése elbukna
  // (lásd lent a `grass` null-ellenőrzését). Kicsivel a csempék (-0.02)
  // ALATT, hogy ne z-fighteljen velük ott, ahol átfednek.
  const bigTex = await loadTexture(ASSETS.textures.grass, BIG_GROUND_REPEAT);
  const bigGeo = new THREE.PlaneGeometry(BIG_GROUND_SIZE, BIG_GROUND_SIZE);
  const bigMat = new THREE.MeshLambertMaterial({
    map: bigTex || null,
    color: bigTex ? 0xffffff : 0x5a8a4a, // ha a textúra sem tölt be, egyszerű fű-zöld marad
  });
  const bigMesh = new THREE.Mesh(bigGeo, bigMat);
  bigMesh.rotation.x = -Math.PI / 2;
  bigMesh.position.set(centerX, -0.05, centerZ);
  scene.add(bigMesh);

  const grass = await loadModel('/assets/track/grass.glb');
  if (!grass) return;
  const grassTex = await loadTexture(ASSETS.textures.grass, ASSETS.textures.grassRepeat);

  const box0 = new THREE.Box3().setFromObject(grass);
  const anchorX = (box0.min.x + box0.max.x) / 2;
  const anchorZ = (box0.min.z + box0.max.z) / 2;
  const groundY = box0.min.y;

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
