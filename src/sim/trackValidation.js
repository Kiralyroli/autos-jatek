// =============================================================================
//  PÁLYA-VALIDÁCIÓ (szabadvonalas szerkesztő) — tiszta, környezet-független
//  ellenőrzések a MINTAVÉTELEZETT középvonalon (nem a nyers kontrollpontokon,
//  mert a görbe simíthatja/torzíthatja a nyers pontok közti geometriát — a
//  ténylegesen vezetett pályát kell ellenőrizni).
//
//  A szerkesztő (editor.js) ezt hívja Mentés előtt, és a #status panelen jeleníti
//  meg az első hibát (piros keret) vagy a "Pálya érvényes" üzenetet (zöld).
// =============================================================================
import { sampleSpline } from './trackSpline.js';

export const MIN_CONTROL_POINTS = 4;
export const MIN_POINT_SPACING = 6; // m — két szomszédos KONTROLLPONT közt
export const MIN_TURN_RADIUS = 6; // m — a mintavételezett görbén sehol ne legyen élesebb (szűk, de kerekített hajtűk is beleférjenek éles-sarok jelölés nélkül)
export const MIN_TRACK_LENGTH = 150; // m — a teljes kör-hossz
export const MIN_WIDTH = 8; // m — pályaszélesség alsó határa (szakaszonként állítható, lásd editor.js)
export const MAX_WIDTH = 40; // m — pályaszélesség felső határa

// Három pont körülírt körének sugara. Majdnem egyenes (kolineáris) hármasnál a
// terület ~0 → a sugarat végtelennek vesszük (nem "éles", hanem egyenes szakasz).
function circumradius(p0, p1, p2) {
  const a = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const b = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  const c = Math.hypot(p2.x - p0.x, p2.z - p0.z);
  const cross2 = Math.abs((p1.x - p0.x) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.x - p0.x));
  if (cross2 < 1e-9) return Infinity;
  return (a * b * c) / (2 * cross2);
}

// Előjeles orientáció + szakasz-metszés (ugyanaz a technika, mint sim/race.js
// checkpoint-átszelésénél) — az önmetszés-ellenőrzéshez.
function orient(a, b, c) {
  return Math.sign((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
}
function segmentsCross(p1, p2, q1, q2) {
  return (
    orient(p1, p2, q1) !== orient(p1, p2, q2) &&
    orient(q1, q2, p1) !== orient(q1, q2, p2)
  );
}

// A pálya (kontrollpontok VAGY már mintavételezett középvonal) ellenőrzése.
// Visszatérés: { valid, errors: [{ code, message, index? }] }. Az ELSŐ hibánál
// megáll az adott ellenőrzési szakasz (pl. ha túl kevés pont van, nincs értelme
// tovább mintavételezni) — de a hívó a `valid` mezőt nézi, az `errors` az összeset
// tartalmazhatja, ha a korai szakaszok mind átmentek.
export function validateSplineTrack(points) {
  const errors = [];

  if (!Array.isArray(points) || points.length < MIN_CONTROL_POINTS) {
    errors.push({
      code: 'too-few-points',
      message: `Legalább ${MIN_CONTROL_POINTS} kontrollpont kell (most: ${points?.length || 0}).`,
    });
    return { valid: false, errors };
  }

  // Nyers kontrollpontok közti távolság (zárt hurok — az utolsó→első is számít).
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d < MIN_POINT_SPACING) {
      errors.push({
        code: 'points-too-close',
        message: `A(z) ${i + 1}. és ${((i + 1) % n) + 1}. pont túl közel van egymáshoz (${d.toFixed(1)} m < ${MIN_POINT_SPACING} m).`,
        index: i,
      });
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  // Pontonkénti szélesség-korlát (csak ha a pontnak VAN width mezője — a régi
  // szerkesztő-állapotból még hiányozhat, azt a trackFactory.js defaultolja).
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (!Number.isFinite(p.width)) continue;
    if (p.width < MIN_WIDTH || p.width > MAX_WIDTH) {
      errors.push({
        code: 'width-out-of-range',
        message: `A(z) ${i + 1}. pont szélessége (${p.width.toFixed(0)} m) a megengedett [${MIN_WIDTH}, ${MAX_WIDTH}] m tartományon kívül esik.`,
        index: i,
        pos: { x: p.x, z: p.z },
      });
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  let center;
  try {
    center = sampleSpline(points, 2);
  } catch (e) {
    errors.push({ code: 'sample-failed', message: e.message });
    return { valid: false, errors };
  }

  // Teljes kör-hossz (a mintavételezett pontok lépésköze kb. állandó, 2m).
  const m = center.length;
  let length = 0;
  for (let i = 0; i < m; i++) {
    const a = center[i];
    const b = center[(i + 1) % m];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  if (length < MIN_TRACK_LENGTH) {
    errors.push({
      code: 'too-short',
      message: `A pálya túl rövid (${length.toFixed(0)} m < ${MIN_TRACK_LENGTH} m).`,
    });
  }

  // Éles kanyar (túl kicsi sugár) a mintavételezett görbén. FONTOS: a három
  // pontot NEM egymás melletti (2m-es lépésközű) mintákból vesszük — az ilyen
  // szűk alapvonalú (~4m) becslés a mintavételezés apró numerikus zajára
  // (a finom belső mintázás és a végső 2m-es újramintavétel kerekítési hibája)
  // ÁLHAMISAN éles kanyart jelzett akár egy hétköznapi, tág téglalap-alakú
  // pályánál is (élő hibajelentés — egy 80×60 m-es pályánál 147 mintapontból 1
  // 10,7 m-re esett a küszöb alá, miközben a valódi geometria sima). CURVE_WINDOW
  // mintányi (≈6m) alapvonal bőven kisimítja ezt a zajt, miközben egy TÉNYLEG
  // éles kanyart (pl. 5m sugarú S-kanyar) továbbra is helyesen elkap.
  const CURVE_WINDOW = 3;
  let sharpestIdx = -1;
  let sharpestR = Infinity;
  for (let i = 0; i < m; i++) {
    const p0 = center[(i - CURVE_WINDOW + m) % m];
    const p1 = center[i];
    const p2 = center[(i + CURVE_WINDOW) % m];
    // Szándékosan éles sarok (a felhasználó dupla kattintással jelölte meg,
    // lásd editor.js/sim/trackSpline.js) — ott a kis sugár VÁRT, nem hiba,
    // ezért kihagyjuk a legkisebb-sugár keresésből.
    if (p0.sharp || p1.sharp || p2.sharp) continue;
    const r = circumradius(p0, p1, p2);
    if (r < sharpestR) {
      sharpestR = r;
      sharpestIdx = i;
    }
  }
  if (sharpestR < MIN_TURN_RADIUS) {
    const p = center[sharpestIdx];
    errors.push({
      code: 'turn-too-sharp',
      message: `Túl éles kanyar (kb. ${sharpestR.toFixed(1)} m sugár < ${MIN_TURN_RADIUS} m).`,
      index: sharpestIdx,
      pos: { x: p.x, z: p.z }, // a szerkesztő ide rajzol egy jelölőt, hogy egyértelmű legyen, HOL
    });
  }

  // Önmetszés: a mintavételezett sokszög szakasz-párjai, a szomszédos (a görbe
  // simulása miatt "majdnem érintkező") szakaszokat kihagyva mindkét irányban.
  const SKIP_WINDOW = 3;
  outer: for (let i = 0; i < m; i++) {
    const a1 = center[i];
    const a2 = center[(i + 1) % m];
    for (let j = i + 1; j < m; j++) {
      const dist = Math.min(Math.abs(j - i), m - Math.abs(j - i));
      if (dist <= SKIP_WINDOW) continue;
      const b1 = center[j];
      const b2 = center[(j + 1) % m];
      if (segmentsCross(a1, a2, b1, b2)) {
        errors.push({
          code: 'self-intersecting',
          message: `A pálya keresztezi önmagát (kb. a(z) ${i + 1}. és ${j + 1}. mintapont közt).`,
          index: i,
          pos: { x: a1.x, z: a1.z },
        });
        break outer;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
