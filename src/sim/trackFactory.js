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
import { sampleSpline } from './trackSpline.js';

// A LAYOUT KÉTFÉLE FORMÁTUMÚ lehet — a régi (rács/szegmens-alapú, trackbuilder.js)
// és az új (szabadvonalas, trackSpline.js) pályák visszamenőlegesen, migráció
// nélkül élnek egymás mellett. Megkülönböztetés: a régi formátum minden eleme
// {type:'straight'|'corner', ...}, az új csak {x,z} kontrollpontokból áll (nincs
// `type` mező). Ez a diszkrimináló olcsó és a meglévő mentett pályákra biztosan
// működik (azoknak MINDIG van type mezőjük).
export function isSplineLayout(layout) {
  return (
    Array.isArray(layout) &&
    layout.length > 0 &&
    layout[0] &&
    typeof layout[0].x === 'number' &&
    layout[0].type === undefined
  );
}

// Szabadvonalas pálya "csempe nélküli" építése: a sampleSpline már megadja a
// {x,z,dir,nx,nz,width} középvonalat — a többi mező (tiles üres, start=end=
// center[0]) csak azért kell, hogy a buildTrackLayout()-tal AZONOS alakot adjon
// vissza. A pontok szélessége (width) OPCIONÁLIS a mentett layoutban — a régebbi
// (e funkció előtt mentett) pályáknál nincs ilyen mező, ezért itt kapják meg a
// pálya alap-szélességét (tile) mielőtt a spline-ba kerülnek; a trackSpline.js
// maga elvárja, hogy MINDEN pontnak legyen numerikus width-je.
function buildSplineTrack(points, tile) {
  const normalized = points.map((p) => ({
    x: p.x,
    z: p.z,
    width: Number.isFinite(p.width) && p.width > 0 ? p.width : tile,
    sharp: !!p.sharp,
  }));
  const center = sampleSpline(normalized, 2);
  const p0 = center[0];
  const start = { x: p0.x, z: p0.z, dir: p0.dir };
  return { center, tiles: [], start, end: start, tile };
}

// opts: { tile, curbWidth, gravelWidth, checkpointCount, start? }
export function createTrackState(layout, opts) {
  const { tile, curbWidth, gravelWidth, checkpointCount } = opts;
  const start = opts.start || { x: 0, z: 0, dir: 0 };

  const track = isSplineLayout(layout)
    ? buildSplineTrack(layout, tile)
    : buildTrackLayout(layout, start, tile);

  const roadHalf = tile / 2;
  const curbEdge = roadHalf + curbWidth;
  // A checkpoint-vonalak félszélessége — elég széles ahhoz, hogy a fűre letérve
  // is átszelje az autó (nincs fizikai fal, ami az úton tartaná). Ez a globális
  // (fallback) érték — szabadvonalas pályánál minden checkpoint a SAJÁT
  // pontjának width-jéből számol (lásd lent), csempés pályánál (nincs width a
  // center-pontokon) ez marad a tényleges érték.
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
      const localHalfWidth = Number.isFinite(p.width) ? p.width / 2 + curbWidth + gravelWidth : checkpointHalfWidth;
      const a = offsetPoint(p, localHalfWidth);
      const b = offsetPoint(p, -localHalfWidth);
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

  // Mennyivel van az (x,z) pont a RÁZÓKÖVÖN (curb) IS TÚL, KÍVÜL (0, ha még
  // az úton VAGY a rázókövön van) — a fű-büntetéshez (sim/car.js
  // updateOffRoadPenalty). A rázókő vizuálisan is a pálya része, ezért a
  // határ nem a puszta aszfalt-szélnél (roadHalf), hanem curbWidth-del
  // arrébb, a rázókő külső élénél húzódik — enélkül a kocsi már a rázókövön
  // állva is "letértnek" számított, ami túl érzékenynek hatott. A LEGKÖZELEBBI
  // szakasz két végpontjának width-átlagából számolt félszélességet vonjuk le
  // (+curbWidth) — így a szélesebb/keskenyebb szakaszokon máshol kezdődik a fű
  // (szabadvonalas pályánál); csempés pályánál (nincs width a center-pontokon)
  // a globális curbEdge marad, változatlanul.
  function offRoadExcess(x, z) {
    const pts = track.center;
    let minDist = Infinity;
    let localHalf = curbEdge;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = pointSegmentDistance(x, z, a.x, a.z, b.x, b.z);
      if (d < minDist) {
        minDist = d;
        localHalf = Number.isFinite(a.width) && Number.isFinite(b.width)
          ? (a.width + b.width) / 4 + curbWidth
          : curbEdge;
      }
    }
    return Math.max(0, minDist - localHalf);
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
    trackLength, // méter — a multiplayer élő állás időrés-becsléséhez (main.js updateStandings)
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
