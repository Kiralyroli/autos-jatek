// =============================================================================
//  PÁLYA-FACTORY — tiszta, környezet-független (böngésző ÉS Node/szerver).
//
//  Egy layout-ból (szegmens-lista, lásd trackbuilder.js) előállítja a teljes
//  sim-oldali pálya-állapotot: középvonal, rajtpozíció, checkpointok és az
//  offRoadExcess (fű-büntetés) függvényt. NEM importál config-ot/localStorage-t —
//  minden paramétert kívülről kap, így a Colyseus szerver szobánként MÁS-MÁS
//  pályával tudja meghívni (a kliens track.js-e pedig a config-belivel).
// =============================================================================
import { buildTrackLayout, offsetPoint } from './trackbuilder.js';

// opts: { tile, curbWidth, gravelWidth, checkpointCount, start? }
export function createTrackState(layout, opts) {
  const { tile, curbWidth, gravelWidth, checkpointCount } = opts;
  const start = opts.start || { x: 0, z: 0, dir: 0 };

  const track = buildTrackLayout(layout, start, tile);

  const roadHalf = tile / 2;
  const curbEdge = roadHalf + curbWidth;
  // A checkpoint-vonalak félszélessége — elég széles ahhoz, hogy a fűre letérve
  // is átszelje az autó (nincs fizikai fal, ami az úton tartaná).
  const checkpointHalfWidth = roadHalf + curbWidth + gravelWidth;

  // A rajt/cél Kenney-kapu (roadStart.glb) 2 csempényi hosszú, és a festett
  // vonala a KÖZEPÉN van — ha a kapu lerakható (2 azonos irányú egyenes az
  // elején), a rajt/cél referenciapont 1 csempével beljebb (center[1]) van.
  const gateFits =
    track.tiles.length >= 2 &&
    track.tiles[0].type === 'straight' &&
    track.tiles[1].type === 'straight' &&
    track.tiles[0].dir === track.tiles[1].dir;
  const startIdx = gateFits ? 1 : 0;

  const spawn = {
    x: track.center[startIdx].x,
    y: track.center[startIdx].z,
    angle: track.center[startIdx].dir,
  };

  const checkpoints = (() => {
    const n = track.center.length;
    const cps = [];
    for (let i = 0; i < checkpointCount; i++) {
      const p = track.center[(startIdx + Math.round((i * n) / checkpointCount)) % n];
      const a = offsetPoint(p, checkpointHalfWidth);
      const b = offsetPoint(p, -checkpointHalfWidth);
      cps.push({ a: { x: a.x, y: a.z }, b: { x: b.x, y: b.z } });
    }
    return cps;
  })();

  // Pont távolsága egy szakasztól (a legközelebbi pontig, a szakaszra vetítve).
  function pointSegmentDistance(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
    const cx = ax + t * dx;
    const cz = az + t * dz;
    return Math.hypot(px - cx, pz - cz);
  }

  // Mennyivel van az (x,z) pont az útszélen KÍVÜL (0, ha az úton van) — a
  // fű-büntetéshez (sim/car.js updateOffRoadPenalty).
  function offRoadExcess(x, z) {
    const pts = track.center;
    let minDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = pointSegmentDistance(x, z, a.x, a.z, b.x, b.z);
      if (d < minDist) minDist = d;
    }
    return Math.max(0, minDist - roadHalf);
  }

  // --- Ívhossz-paraméterezés a középvonal mentén ---
  // Kumulatív ívhossz minden center-pontig (0-tól a pálya-hosszig, zárt hurok).
  const n = track.center.length;
  const cumLen = [0];
  for (let i = 1; i < n; i++) {
    const a = track.center[i - 1];
    const b = track.center[i];
    cumLen.push(cumLen[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const closingLen = Math.hypot(
    track.center[0].x - track.center[n - 1].x,
    track.center[0].z - track.center[n - 1].z
  );
  const trackLength = cumLen[n - 1] + closingLen;

  // Az (x,z) pont ÍVHOSSZ SZERINTI haladása a körön, 0..1 törtként (a legközelebbi
  // középvonal-szakaszra vetítve). ROBUSZTUS élő rangsorhoz (multiplayer állás):
  // a checkpoint-index (durva, néhány pontos milestone) helyett folytonos értéket
  // ad, ami NEM ugrál akkor, ha két játékos épp ugyanazt a checkpointot célozza,
  // de a valós pálya-menti távolságuk eltér — ez okozta a sorrend-villogást.
  function trackProgress(x, z) {
    let bestDist = Infinity;
    let bestI = 0;
    let bestT = 0;
    for (let i = 0; i < n; i++) {
      const a = track.center[i];
      const b = track.center[(i + 1) % n];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lenSq));
      const cx = a.x + t * dx;
      const cz = a.z + t * dz;
      const d = Math.hypot(x - cx, z - cz);
      if (d < bestDist) {
        bestDist = d;
        bestI = i;
        bestT = t;
      }
    }
    const segLen = bestI === n - 1 ? closingLen : cumLen[bestI + 1] - cumLen[bestI];
    return (cumLen[bestI] + bestT * segLen) / trackLength;
  }

  // A pálya HELYI haladási iránya (rad) az (x,z)-hez legközelebbi középvonal-ponton.
  // A rossz-irány detektáláshoz (sim/race.js) ez KANYARBAN IS MEGBÍZHATÓ — szemben
  // azzal, ha a következő (távoli) checkpointra mutató egyenes vonalat néznénk: az
  // a valódi útiránytól kanyarban jelentősen eltérhet, hamis "rossz irány" jelzést
  // adva. A középvonal `dir` mezője pontosan a helyes (építéskori) haladási irány.
  function trackHeadingAt(x, z) {
    let bestDist = Infinity;
    let bestDir = 0;
    for (let i = 0; i < n; i++) {
      const p = track.center[i];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bestDist) {
        bestDist = d;
        bestDir = p.dir;
      }
    }
    return bestDir;
  }

  return {
    track,
    spawn,
    checkpoints,
    offRoadExcess,
    trackProgress,
    trackHeadingAt,
    roadHalf,
    curbEdge,
    checkpointHalfWidth,
  };
}

// Multiplayer rajtrács: az i-edik játékos rajt-pozíciója — a rajtvonal MÖGÖTT,
// két oszlopban, soronként hátrébb tolva (mint egy igazi rajtrács), hogy senki
// ne álljon a vonalon a countdown alatt.
export function spawnSlot(trackState, i) {
  const s = trackState.spawn;
  const dx = Math.cos(s.angle);
  const dy = Math.sin(s.angle);
  const nx = -dy; // bal-normál
  const ny = dx;
  const row = Math.floor(i / 2);
  const side = i % 2 === 0 ? -1 : 1;
  const back = 5 + row * 7; // m — az első sor 5m-re a vonal mögött, soronként +7m
  const lateral = side * 3.2; // m — két oszlop a felezővonal két oldalán
  return {
    x: s.x - dx * back + nx * lateral,
    y: s.y - dy * back + ny * lateral,
    angle: s.angle,
  };
}
