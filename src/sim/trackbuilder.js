// =============================================================================
//  TRACK-BUILDER — RÁCS-alapú, a Kenney Racing Kit csempékhez igazítva.
//  Minden EGYENES csempe 1×1 rács-cella. A kurzor a cella-belépési él közepén áll
//  (world x,z), `dir` a haladási irány. Egy szegmens:
//    straight → a csempe a következő cellába, a kurzor 1 cellát lép.
//    corner   → negyedkör-ív a `size` mezőtől függő sugárral (size=1 → roadCornerSmall,
//               size=2 → roadCornerLarge, size=3 → roadCornerLarger — lásd
//               render3d/scene.js modell-választás). A középvonal-sugár mindig
//               (size-0.5)*tile — ez méréssel igazolt Kenney-konvenció (size=1-nél
//               tile/2, ami megegyezik a korábbi, csak kis kanyart ismerő képlettel).
//               A kurzor 90°-ot fordul és a kilépési élre lép.
//
//  Kimenet:
//    center[]:  a középvonal pontjai {x,z,dir,nx,nz,corner,turn} (fizika/checkpoint/
//               spawn/rázókő — turn: 0 egyenesben, ±1 kanyarban, a KÜLSŐ ív oldala
//               levezethető belőle: turn=+1 (bal) → külső a jobb/negatív offset oldal).
//    tiles[]:   a lerakandó Kenney csempék:
//                 egyenes: {type:'straight', turn:0, cx, cz, dir} (cx,cz = cella-közép)
//                 kanyar:  {type:'corner', turn, size, ex, ez, dir} (ex,ez = BELÉPÉSI pont)
//
//  Koordináták: x,z fizika-méter (3D talajsík). turn: +1 bal (CCW), −1 jobb (CW).
// =============================================================================

// Egy nagyobb sugarú (size>1) kanyar geometriailag PONTOSAN (size-1) csempényit
// "belenyúlik" MINDKÉT szomszédos egyenes szakaszba (a kanyar-ív belépő/kilépő
// pontja ennyivel odébb kerül, mint egy sima kanyarnál) — enélkül a kompenzáció
// nélkül a pálya nem zárna vissza pontosan a kiinduló pontra (mért zárási hiba
// akár 20+ méter is lehet egyetlen átméretezett kanyarnál). A szerkesztő (editor.js
// maxFeasibleCornerSize) garantálja, hogy a felhasználó csak olyan méretet
// állíthat be, aminek a szomszédos egyenesek elég hosszúak — itt védőhálóként
// Math.max(1,...)-szel soha nem megyünk 0/negatív hosszra.
function applyCornerSizeCompensation(rawLayout) {
  const layout = rawLayout.map((s) => ({ ...s }));
  const n = layout.length;
  for (let k = 0; k < n; k++) {
    const seg = layout[k];
    if (seg.type !== 'corner') continue;
    const extra = (seg.size || 1) - 1;
    if (extra <= 0) continue;
    const prev = layout[(k - 1 + n) % n];
    const next = layout[(k + 1) % n];
    if (prev.type === 'straight') prev.n = Math.max(1, prev.n - extra);
    if (next.type === 'straight') next.n = Math.max(1, next.n - extra);
  }
  return layout;
}

export function buildTrackLayout(rawLayout, start, tile) {
  const layout = applyCornerSizeCompensation(rawLayout);
  const half = tile / 2;
  let { x, z, dir } = start;
  const center = [];
  const tiles = [];

  const push = (px, pz, pdir, corner, turn) =>
    center.push({ x: px, z: pz, dir: pdir, nx: -Math.sin(pdir), nz: Math.cos(pdir), corner, turn: turn || 0 });

  push(x, z, dir, false, 0);

  for (const seg of layout) {
    if (seg.type === 'straight') {
      for (let i = 0; i < seg.n; i++) {
        tiles.push({ type: 'straight', turn: 0, cx: x + Math.cos(dir) * half, cz: z + Math.sin(dir) * half, dir });
        x += Math.cos(dir) * tile;
        z += Math.sin(dir) * tile;
        push(x, z, dir, false, 0);
      }
    } else if (seg.type === 'corner') {
      const turn = seg.turn;
      const size = seg.size || 1; // 1=sima, 2=Large, 3=Larger (nagyobb sugarú kanyar)
      const rad = (size - 0.5) * tile; // középvonal-sugár
      tiles.push({ type: 'corner', turn, size, ex: x, ez: z, dir });
      // Ív-középpont: a belépési ponttól oldalra (a fordulás felé) `rad`-dal.
      const ccx = x + Math.cos(dir + turn * (Math.PI / 2)) * rad;
      const ccz = z + Math.sin(dir + turn * (Math.PI / 2)) * rad;
      const startAng = Math.atan2(z - ccz, x - ccx);
      const steps = 6 * size; // nagyobb kanyarnál több mintavételi pont a sima ívhez
      for (let s = 1; s <= steps; s++) {
        const a = startAng + turn * (Math.PI / 2) * (s / steps);
        const px = ccx + Math.cos(a) * rad;
        const pz = ccz + Math.sin(a) * rad;
        push(px, pz, a + turn * (Math.PI / 2), true, turn);
      }
      const last = center[center.length - 1];
      x = last.x; z = last.z; dir = last.dir;
    }
  }

  return { center, tiles, start, end: { x, z, dir }, tile };
}

// Egy középvonal-pontból offszetelt pont: bal (+) / jobb (−) irányban `d` méterre.
export function offsetPoint(p, d) {
  return { x: p.x + p.nx * d, z: p.z + p.nz * d };
}

export function closureError(built) {
  return Math.hypot(built.end.x - built.start.x, built.end.z - built.start.z);
}
