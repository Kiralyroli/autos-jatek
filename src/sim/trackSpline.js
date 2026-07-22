// =============================================================================
//  TRACK-SPLINE — SZABADVONALAS pálya: zárt, centripetális Catmull-Rom görbe
//  a felhasználó által lerakott kontrollpontokon át, egyenletes ívhossz-lépésben
//  újramintavételezve.
//
//  Tiszta, környezet-független modul (nincs DOM/Three.js/config import) — EZT a
//  függvényt hívja mind a sim (kliens + szerver, trackFactory.js-en át), mind a
//  2D szerkesztő élő előnézete, így a szerkesztőben rajzolt görbe GARANTÁLTAN
//  megegyezik azzal, amit a játékban vezetünk (WYSIWYG).
//
//  Bemenet: kontrollpontok {x,z,width,sharp}[] — zárt hurok, min. 4 pont,
//  nincs típus/sugár-metaadat (szemben a rács-alapú trackbuilder.js szegmens-
//  listájával). A `width` (teljes útszélesség méterben) MINDEN pontnál kötelező
//  — a defaultolás a hívó (trackFactory.js) felelőssége, hogy ez a modul
//  DOM/config-mentes maradhasson. A `sharp` (opcionális boolean, hiányzó =
//  false) egy kontrollpontot TÖRÉSPONTTÁ tesz — a hozzá kapcsolódó szakaszok
//  egyenes vonalként futnak, nem a szokásos sima Catmull-Rom görbeként (lásd
//  editor.js — dupla kattintással állítható).
//
//  Kimenet (sampleSpline): {x,z,dir,nx,nz,width,sharp}[] — a `width` UGYANAZZAL
//  a Catmull-Rom súlyozással interpolált, mint a pozíció (kivéve éles
//  szakaszokon, ott lineárisan), így szakaszonként simán változhat. A `sharp`
//  jelzi, hogy az adott mintapont egy szándékosan éles szakaszból való (a
//  validáció ezt használja, hogy ne jelezzen ott hamis "túl éles kanyar"
//  hibát). A `corner`/`turn` mezőket sehol nem olvassa a downstream kód (lásd
//  trackFactory.js), ezért azok itt el is maradnak.
// =============================================================================

const ALPHA = 0.5; // centripetális paraméterezés — egyenetlen pont-távolságnál sem
//                    hurkol/csúcsosodik be a görbe (szemben a sima uniform Catmull-Rommal).

// Egy 4 kontrollpontos (p0,p1,p2,p3) Catmull-Rom szakasz kiértékelése t∈[0,1]-nél
// (p1→p2 közt), centripetális csomó-távolságokkal.
function catmullRomPoint(p0, p1, p2, p3, t) {
  const d01 = Math.max(1e-6, Math.hypot(p1.x - p0.x, p1.z - p0.z) ** ALPHA);
  const d12 = Math.max(1e-6, Math.hypot(p2.x - p1.x, p2.z - p1.z) ** ALPHA);
  const d23 = Math.max(1e-6, Math.hypot(p3.x - p2.x, p3.z - p2.z) ** ALPHA);

  const t0 = 0;
  const t1 = t0 + d01;
  const t2 = t1 + d12;
  const t3 = t2 + d23;
  const tt = t1 + (t2 - t1) * t;

  function axis(key) {
    const a1 = ((t1 - tt) / (t1 - t0)) * p0[key] + ((tt - t0) / (t1 - t0)) * p1[key];
    const a2 = ((t2 - tt) / (t2 - t1)) * p1[key] + ((tt - t1) / (t2 - t1)) * p2[key];
    const a3 = ((t3 - tt) / (t3 - t2)) * p2[key] + ((tt - t2) / (t3 - t2)) * p3[key];
    const b1 = ((t2 - tt) / (t2 - t0)) * a1 + ((tt - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - tt) / (t3 - t1)) * a2 + ((tt - t1) / (t3 - t1)) * a3;
    return ((t2 - tt) / (t2 - t1)) * b1 + ((tt - t1) / (t2 - t1)) * b2;
  }

  // A szélességet UGYANAZZAL a Catmull-Rom súlyozással interpoláljuk, mint a
  // pozíciót — így a szélesség-váltás is simán illeszkedik, nem törik meg a
  // kontrollpontoknál (lásd trackFactory.js buildSplineTrack: minden pontnak
  // van `.width`-je, a hívó gondoskodik a defaultolásról).
  return { x: axis('x'), z: axis('z'), width: axis('width') };
}

// A teljes zárt görbe kiértékelése egy [0,1) globális paraméternél (n szakasz,
// mindegyik [i/n, (i+1)/n) tartományban).
//
// ÉLES SAROK: ha a szakasz VALAMELYIK végpontja `sharp: true` (a felhasználó a
// szerkesztőben dupla kattintással jelölte meg — lásd editor.js), a p1→p2
// szakaszt EGYSZERŰ LINEÁRIS interpolációval adjuk vissza (a szomszédos p0/p3
// pontok hatása nélkül) — ez törésponttá teszi a görbét abban a pontban,
// mindkét oldalról egyenesen befutva/kifutva, mint egy vektorgrafikus
// szerkesztő "sarok-node"-ja. A pálya többi (nem-éles) szakasza változatlanul
// sima Catmull-Rom marad.
function evalClosedSpline(points, u) {
  const n = points.length;
  const seg = Math.floor(u * n) % n;
  const t = u * n - Math.floor(u * n);
  const p1 = points[seg];
  const p2 = points[(seg + 1) % n];
  if (p1.sharp || p2.sharp) {
    return {
      x: p1.x + (p2.x - p1.x) * t,
      z: p1.z + (p2.z - p1.z) * t,
      width: p1.width + (p2.width - p1.width) * t,
      sharp: true,
    };
  }
  const p0 = points[(seg - 1 + n) % n];
  const p3 = points[(seg + 2) % n];
  return { ...catmullRomPoint(p0, p1, p2, p3, t), sharp: false };
}

// A kontrollpontokon átfektetett zárt görbét FINOMAN (sűrűn) mintavételezi, hogy
// pontos ívhossz-táblát építhessünk belőle — ez adja az egyenletes újramintavétel
// alapját (a nyers paraméteres `u` NEM arányos az ívhosszal).
const FINE_STEPS_PER_POINT = 20;

function buildFineSamples(points) {
  const n = points.length;
  const steps = n * FINE_STEPS_PER_POINT;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    pts.push(evalClosedSpline(points, i / steps));
  }
  return pts;
}

// Kumulatív ívhossz a finom mintasoron (zárt hurok — az utolsó→első távolság is
// benne van), plusz a teljes kör-hossz.
function buildArcLengthTable(finePts) {
  const n = finePts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) {
    const a = finePts[i - 1];
    const b = finePts[i];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const closing = Math.hypot(finePts[0].x - finePts[n - 1].x, finePts[0].z - finePts[n - 1].z);
  const total = cum[n - 1] + closing;
  return { cum, total };
}

// A kontrollpontokon átfektetett zárt Catmull-Rom görbét EGYENLETES ívhossz-
// lépésben (`stepLen` méterenként) újramintavételezi, és minden pontra kiszámolja
// a haladási irányt (dir) + a bal-normált (nx,nz) — ugyanazzal a konvencióval,
// mint trackbuilder.js: nx=-sin(dir), nz=cos(dir).
export function sampleSpline(points, stepLen = 2) {
  if (!Array.isArray(points) || points.length < 4) {
    throw new Error('sampleSpline: legalább 4 kontrollpont kell egy zárt hurokhoz');
  }
  const fine = buildFineSamples(points);
  const { cum, total } = buildArcLengthTable(fine);
  const nFine = fine.length;
  const stepCount = Math.max(8, Math.round(total / stepLen));

  // Egy célzott ívhossznál megkeresi a finom mintasor megfelelő pontját (lineáris
  // interpolációval a két legközelebbi finom minta közt) — a finom lépésköz
  // (kör-hossz / (n*20)) jóval kisebb, mint a kívánt stepLen, ezért ez elég pontos.
  let fineIdx = 0;
  function pointAtArcLength(target) {
    while (fineIdx < nFine - 1 && cum[fineIdx + 1] < target) fineIdx++;
    const a = fine[fineIdx];
    const b = fine[(fineIdx + 1) % nFine];
    const segLen = fineIdx === nFine - 1 ? total - cum[nFine - 1] : cum[fineIdx + 1] - cum[fineIdx];
    const t = segLen < 1e-9 ? 0 : Math.max(0, Math.min(1, (target - cum[fineIdx]) / segLen));
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      width: a.width + (b.width - a.width) * t,
      // Ha BÁRMELYIK szomszédos finom minta éles-szakaszból való, ez az
      // újramintavételezett pont is legyen éles-jelölt (lásd trackValidation.js
      // — ez véd ki egy hamis "túl éles kanyar" hibát a szándékos törésponton).
      sharp: a.sharp || b.sharp,
    };
  }

  const raw = [];
  for (let i = 0; i < stepCount; i++) {
    raw.push(pointAtArcLength((i * total) / stepCount));
  }

  // Irány: központi differencia a szomszédos (zárt hurok) újramintavételezett
  // pontok közt — simább, mint egy egyoldali (csak "előre") differencia.
  // KIVÉTEL: éles (sharp) mintapontnál a központi differencia ÁTLAGOLNÁ az
  // irányt a törésponton át (a be- és kifutó egyenes szakasz irányát keverve),
  // ami a szélesség-eltolásnál (ribbon/curb, lásd render3d/trackRibbon.js) "X"
  // alakú átfedést/keresztezést okoz a sarkon (élő hibajelentés — screenshoton
  // látszó, keresztbe álló fehér szegély-csíkok). Éles pontnál ezért EGYOLDALI
  // (csak "előre", cur→next) differenciát használunk — ez pontosan a helyi
  // (a törésponthoz tartozó) egyenes irányt adja, nincs átlagolás a törésponton
  // át, így a szélesség-eltolás nem keresztezi önmagát.
  const center = [];
  for (let i = 0; i < stepCount; i++) {
    const prev = raw[(i - 1 + stepCount) % stepCount];
    const cur = raw[i];
    const next = raw[(i + 1) % stepCount];
    const dir = cur.sharp
      ? Math.atan2(next.z - cur.z, next.x - cur.x)
      : Math.atan2(next.z - prev.z, next.x - prev.x);
    center.push({
      x: raw[i].x,
      z: raw[i].z,
      dir,
      nx: -Math.sin(dir),
      nz: Math.cos(dir),
      // A Catmull-Rom interpoláció nagy szélesség-ugrásoknál kis mértékben
      // túllőhet a kontrollpontok értékein (nem monoton) — egy alsó korlát
      // (2m) védi ki a degenerált (nulla/negatív szélességű) geometriát.
      width: Math.max(2, raw[i].width),
      sharp: raw[i].sharp,
    });
  }

  // ÉLES SAROK GEOMETRIAI ILLESZTÉSE (a szalag/szegély-geometria — lásd
  // render3d/trackRibbon.js — pontos "törés-sapkája"). Az egyenletes ívhossz-
  // rács NEM feltétlenül talál PONTOSAN a töréspontra (a legközelebbi minta
  // akár ~stepLen távolságra is eshet tőle) — emiatt a szélesség-eltolás
  // (ribbon/curb) egy HOSSZÚ, átlós szakasszal kötné össze a be- és kifutó
  // (eltérő irányú) élt a sarkon, ami messze túlnyúló fehér csíkként látszik
  // (élő hibajelentés, screenshot). A javítás: minden éles KONTROLLPONTNÁL két
  // PONTOS bejegyzést szúrunk be UGYANARRA a pozícióra — az egyik a bejövő, a
  // másik a kimenő egyenes szakasz irányával —, hogy a szalag a sarok PONTOS
  // helyén törjön (kis, a szélességgel arányos "sapka" a domború oldalon,
  // apró átfedés a homorún — ez a szokásos, gyakorlatilag észrevehetetlen
  // viselkedés bármilyen egyszerű vonal-vastagító algoritmusnál).
  const n = points.length;
  const cornerS = [];
  for (let j = 0; j < n; j++) {
    if (points[j].sharp) cornerS.push(cum[j * FINE_STEPS_PER_POINT]);
  }
  // A meglévő egyenletes-rács mintát KIHAGYJUK, ha (majdnem) pontosan egy sarok
  // ívhossz-pozíciójára esik — azt a lenti PONTOS be-/kimenő páros helyettesíti;
  // enélkül ez a "felesleges" minta (ami maga is a kimenő irányt kapná a
  // korábbi egyoldali-differencia szabály miatt) rossz sorrendben, a bejövő
  // páros ELÉ kerülne, és visszahozná az eredeti átlós-ugrás hibát.
  const EPS = 1e-4;
  const withCorners = center
    .map((p, i) => ({ ...p, s: (i * total) / stepCount }))
    .filter((p) => !cornerS.some((s) => Math.abs(p.s - s) < EPS));
  for (let j = 0; j < n; j++) {
    if (!points[j].sharp) continue;
    const prevP = points[(j - 1 + n) % n];
    const nextP = points[(j + 1) % n];
    const dirIn = Math.atan2(points[j].z - prevP.z, points[j].x - prevP.x);
    const dirOut = Math.atan2(nextP.z - points[j].z, nextP.x - points[j].x);
    // Egy köztes ("felező") irány a be- és kifutó egyenes közt — a szélesség-
    // eltoló szalag/szegély-geometria (render3d/trackRibbon.js) így KÉT kisebb
    // (fele-akkora szögű) lépésben töri meg az irányt egy nagy ugrás helyett,
    // ami éles (akár ~90°+ fokos) sarkoknál elkerüli az önmagát metsző
    // ("bowtie") négyszöget a kötő-szakaszon (élő hibajelentés — screenshoton
    // látszó, a fűbe "beharapó" rés a szegélyen). Vektor-átlaggal számolva
    // (nem szög-átlaggal), hogy ne legyen gond a ±180°-os szög-átfordulással.
    const midDir = Math.atan2(Math.sin(dirIn) + Math.sin(dirOut), Math.cos(dirIn) + Math.cos(dirOut));
    const s = cum[j * FINE_STEPS_PER_POINT];
    const w = points[j].width;
    const mk = (dir, sOffset) => ({
      x: points[j].x, z: points[j].z, dir,
      nx: -Math.sin(dir), nz: Math.cos(dir), width: w, sharp: true, s: s + sOffset,
    });
    withCorners.push(mk(dirIn, 0), mk(midDir, 1e-6), mk(dirOut, 2e-6));
  }
  withCorners.sort((a, b) => a.s - b.s);
  return withCorners.map(({ s, ...rest }) => rest);
}
