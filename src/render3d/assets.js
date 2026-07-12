// Külső assetek betöltése FALLBACKKEL. Minden betöltő "puha": ha a fájl hiányzik
// vagy hibás, csendben null-t ad (a hívó a beépített megjelenésre esik vissza).
// A betöltés aszinkron és nem blokkol — a scene azonnal fut, az assetek "beúsznak".
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ASSETS, CAR } from '../config.js';

// A config.js (és pl. grassField.js) az assetekre MINDIG gyökér-relatív utat ad meg
// (pl. '/assets/car.glb') — ez helyi devnél helyes, de GitHub Pages-en a projekt egy
// al-útvonalon fut (/autos-jatek/), ahol ez az abszolút út 404-et adna. A
// import.meta.env.BASE_URL (Vite tölti fel a vite.config.js `base`-jéből, dev=/'/,
// build='/autos-jatek/') hozzáfűzésével MINDEN betöltés a tényleges helyre mutat.
function withBase(url) {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + url;
}

// A Kenney GLB egy relatív "Textures/colormap.png"-t hivatkoz, ami a public mappában
// máshol/más case-sel van → átirányítjuk a tényleges fájlra (így nincs 404, és a
// modell a saját textúrájával tölt be).
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) =>
  url.includes('colormap.png') ? withBase(ASSETS.car.colormap) : url
);

const gltfLoader = new GLTFLoader(manager);
const texLoader = new THREE.TextureLoader();

// Egy glTF/GLB modell betöltése. Siker esetén a scene-gráf gyökér objektuma, különben null.
export function loadModel(url) {
  return new Promise((resolve) => {
    gltfLoader.load(
      withBase(url),
      (gltf) => resolve(gltf.scene),
      undefined,
      () => resolve(null) // hiányzik/hibás → fallback
    );
  });
}

// Ismétlődő (tileable) textúra betöltése. Siker esetén THREE.Texture, különben null.
export function loadTexture(url, repeat = 1) {
  return new Promise((resolve) => {
    texLoader.load(
      withBase(url),
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

// Modell-atlasz textúra (pl. Kenney colormap). NEM ismétlődő, és flipY=false,
// mert a glTF UV-k így várják. Siker esetén THREE.Texture, különben null.
export function loadModelTexture(url) {
  return new Promise((resolve) => {
    texLoader.load(
      withBase(url),
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

// A megadott modellt a fizikai autó méretére igazítja: AUTOMATIKUS skálázás a
// befoglaló doboz alapján (a leghosszabb vízszintes tengely = CAR.length), a talajra
// ültetve és középre igazítva. Az orientáció/finomhangolás az ASSETS.car configból —
// kivéve ha a hívó rotationY-t ad meg (a multiplayer raceCar-modellek MÁS tengely
// mentén állnak, mint a fő car.glb, nekik saját forgatás kell).
export function fitCarModel(model, colormap = null, rotationY = null) {
  const cfg = ASSETS.car;

  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      // A Kenney színatlasz kézi rátétele (a GLB belső textúra-hivatkozása helyett).
      if (colormap && o.material) {
        o.material.map = colormap;
        o.material.color.set(0xffffff);
        o.material.needsUpdate = true;
      }
    }
  });

  // Nyers méret és auto-skála a valós autóhosszhoz (× finomhangoló szorzó).
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const modelLength = Math.max(size.x, size.z) || 1;
  const scale = (CAR.length / modelLength) * cfg.scale;

  // Belső "aligner": elforgatjuk (hogy az orra +x felé nézzen), skálázzuk,
  // és a talajra ültetjük (a modell alja y=0-ra, a középpontja az origóra).
  const aligner = new THREE.Group();
  aligner.rotation.y = rotationY !== null ? rotationY : cfg.rotationY;
  aligner.scale.setScalar(scale);
  const center = box.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -box.min.y, -center.z);
  aligner.add(model);

  // Külső holder: a config yOffset finomhangoló a talaj-illesztéshez.
  const holder = new THREE.Group();
  holder.position.y = cfg.yOffset;
  holder.add(aligner);
  return holder;
}
