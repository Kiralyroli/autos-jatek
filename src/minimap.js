// =============================================================================
//  MINITÉRKÉP — kis felülnézeti pálya-rajz a HUD-on, hogy versenyközben
//  lássuk, ki merre jár a körön (a saját autónk kiemelve, a többi a saját
//  autó-színével). Tiszta canvas 2D — nem függ Three.js-től/kamerától.
//
//  A `centerPoints` a pálya középvonala (sim/track(bBuilder|Factory).js
//  `track.center` — {x,z,...} pontok, ugyanaz mindkét pálya-formátumnál),
//  VILÁG-méterben; a canvas méretéhez illesztett, torzításmentes skálázással
//  jelenik meg (a hosszabb világ-tengely tölti ki a canvast).
// =============================================================================
export function createMinimap(canvas, centerPoints) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const PAD = 8;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of centerPoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxZ - minZ);
  const scale = Math.min((W - PAD * 2) / worldW, (H - PAD * 2) / worldH);
  const offX = (W - worldW * scale) / 2;
  const offY = (H - worldH * scale) / 2;

  // Világ (x,z) → canvas (cx,cy) — UGYANAZ a leképezés (nincs tengely-tükrözés),
  // mint az editor.js worldToScreen-je, hogy a minitérkép pontosan úgy álljon,
  // ahogy a pálya-szerkesztőben látszik (élő hibajelentés: korábban Z-ben
  // tükrözve, "fejjel lefelé" jelent meg a szerkesztőhöz képest).
  function toCanvas(x, z) {
    return {
      cx: offX + (x - minX) * scale,
      cy: offY + (z - minZ) * scale,
    };
  }

  // A pálya középvonala — egyszer kiszámolt, minden `draw`-nál újrarajzolt
  // (a canvas maga törlődik, a középvonal nem változik menet közben).
  const trackPoints = centerPoints.map((p) => toCanvas(p.x, p.z));

  // `dots`: [{x, z, color, isMe}] — a JELENLEGI autó-pozíciók (világ-méterben).
  function draw(dots) {
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    trackPoints.forEach((p, i) => (i === 0 ? ctx.moveTo(p.cx, p.cy) : ctx.lineTo(p.cx, p.cy)));
    ctx.closePath();
    ctx.stroke();

    // A SAJÁT pont legyen felül (utoljára rajzolva) — ha egybeesik egy
    // másikéval, akkor is a mienk (fehér kerettel kiemelt) látszódjon.
    const sorted = [...dots].sort((a, b) => (a.isMe ? 1 : 0) - (b.isMe ? 1 : 0));
    for (const d of sorted) {
      const { cx, cy } = toCanvas(d.x, d.z);
      ctx.beginPath();
      ctx.arc(cx, cy, d.isMe ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = d.color || '#ffffff';
      ctx.fill();
      if (d.isMe) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  return { draw };
}
