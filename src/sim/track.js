// A pálya SIM-oldala: a szegmens-builderből előállítja a rajtpozíciót, a
// checkpointokat és az úttól való távolságot (fű-büntetéshez). Phaser/three-mentes.
//
// Nincs fizikai fal: letérni a fűre lehet, de minél tovább vagy rajta, annál
// kevesebb gázt kapunk (lásd sim/car.js updateOffRoadPenalty) — ez tartja a
// pályán az autót, láthatatlan korlát nélkül.
//
// Koordináta-leképezés: builder (x, z) = 3D talajsík; Planck fizika (x, y=z).
import { TRACK } from '../config.js';
import { buildTrackLayout, offsetPoint } from './trackbuilder.js';

export const track = buildTrackLayout(TRACK.layout, TRACK.start, TRACK.tile);

// Réteg-távolságok a középvonaltól (méter).
export const ROAD_HALF = TRACK.tile / 2;
export const CURB_EDGE = ROAD_HALF + TRACK.curbWidth;
// A checkpoint-vonalak félszélessége — elég széles ahhoz, hogy a fűre letérve
// (fal híján akár messzebbre is) az autó még mindig átszelje őket.
export const CHECKPOINT_HALF_WIDTH = ROAD_HALF + TRACK.curbWidth + TRACK.gravelWidth;

// A rajt/cél Kenney-kapu (roadStart.glb, render3d/scene.js) 2 csempényi hosszú,
// és a rajta festett vonal NEM a kapu elején, hanem PONTOSAN A KÖZEPÉN van (a
// 2 csempe határán) — méréssel igazolva (debug-gömbökkel a böngészőben). Ha a
// kapu ténylegesen lerakható (ugyanaz a feltétel, mint a scene.js
// canPlaceStartGate-jében), a rajt/cél referenciapontot 1 csempével arrébb
// (track.center[1]-re) kell tolni, hogy a spawn és a checkpoint a VALÓDI
// festett vonalhoz igazodjon — enélkül az autó a vonal MÖGÜL indult, és a kör
// is a vonal előtt ért véget.
const gateFits =
  track.tiles.length >= 2 &&
  track.tiles[0].type === 'straight' &&
  track.tiles[1].type === 'straight' &&
  track.tiles[0].dir === track.tiles[1].dir;
const START_IDX = gateFits ? 1 : 0;

export const spawn = {
  x: track.center[START_IDX].x,
  y: track.center[START_IDX].z,
  angle: track.center[START_IDX].dir,
};

// Checkpointok: keresztvonalak nagy szélességben (így a fűre letérve is átszeli az autó).
// A 0. checkpoint (rajt/cél) a START_IDX-en van; a többi ehhez képest, a kör
// mentén egyenletesen elosztva.
export const checkpoints = (() => {
  const n = track.center.length;
  const cps = [];
  for (let i = 0; i < TRACK.checkpointCount; i++) {
    const p = track.center[(START_IDX + Math.round((i * n) / TRACK.checkpointCount)) % n];
    const a = offsetPoint(p, CHECKPOINT_HALF_WIDTH);
    const b = offsetPoint(p, -CHECKPOINT_HALF_WIDTH);
    cps.push({ a: { x: a.x, y: a.z }, b: { x: b.x, y: b.z } });
  }
  return cps;
})();

// Pont távolsága egy szakasztól (a legközelebbi pontig, a szakaszra vetítve és clampelve).
function pointSegmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

// Mennyivel van az (x,z) pont az útszélen KÍVÜL (0, ha az úton van). A fű-büntetéshez
// (sim/car.js) — a középvonal-poligon minden szakaszához (a záró szakaszt is beleértve)
// megnézzük a legrövidebb távolságot, abból vonjuk ki az út félszélességét.
export function offRoadExcess(x, z) {
  const pts = track.center;
  let minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = pointSegmentDistance(x, z, a.x, a.z, b.x, b.z);
    if (d < minDist) minDist = d;
  }
  return Math.max(0, minDist - ROAD_HALF);
}
