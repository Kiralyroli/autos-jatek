// =============================================================================
//  NÉVTÁBLA — lebegő játékosnév az autó fölött (multiplayer). Egy THREE.Sprite,
//  aminek a textúrája egy canvasra rajzolt név; a Sprite mindig a kamera felé
//  fordul (billboard), így minden szögből olvasható. Az autó-mesh gyerekeként
//  lóg, adott magasságban — az autó forgása (yaw) nem forgatja el (a felfelé
//  eltolás Y körüli forgásra invariáns, a Sprite pedig magától a kamera felé néz).
// =============================================================================
import * as THREE from 'three';

const HEIGHT = 4.2; // m — ilyen magasan lebeg az autó fölött
const WORLD_WIDTH = 7; // m — a névtábla világ-szélessége (a magasság ebből arányos)

// Névtábla-sprite létrehozása a megadott szöveggel (és opcionális szín-pöttyel).
export function createNameplate(text, colorHex = '#ffffff') {
  const canvas = document.createElement('canvas');
  const W = 512;
  const H = 128;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const label = String(text || 'Játékos').slice(0, 20);
  const font = '600 60px system-ui, sans-serif';

  // Buborék-háttér a szöveg mögé (kontraszt bármilyen pálya fölött).
  ctx.font = font;
  const textW = ctx.measureText(label).width;
  const padX = 34;
  const dotR = 18;
  const bubbleW = Math.min(W - 8, textW + padX * 2 + dotR * 2 + 14);
  const bubbleH = 84;
  const bx = (W - bubbleW) / 2;
  const by = (H - bubbleH) / 2;
  roundRect(ctx, bx, by, bubbleW, bubbleH, 26);
  ctx.fillStyle = 'rgba(12, 14, 20, 0.72)';
  ctx.fill();

  // Szín-pötty (a játékos autó-színe) + név.
  const cx = bx + padX + dotR;
  const cy = H / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();

  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx + dotR + 14, cy + 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const material = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false, // mindig látszik (nem takarja el az autó-modell)
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(WORLD_WIDTH, (WORLD_WIDTH * H) / W, 1);
  sprite.position.y = HEIGHT;
  sprite.renderOrder = 999;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
