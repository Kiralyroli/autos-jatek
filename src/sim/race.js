// =============================================================================
//  VERSENY-LOGIKA — tiszta, determinisztikus, framework-mentes (lásd CLAUDE.md).
//  A 3. fázisban a Colyseus szerver UGYANEZT a kódot futtatja, ezért:
//   - az állapot sima, szerializálható objektum (nincs closure, nincs DOM),
//   - az idő a fix fizika-lépésekből akkumulálódik (nem Date.now!),
//   - a raceStep bemenete csak az előző/jelenlegi pozíció és a fix dt.
// =============================================================================
import { RACE } from '../config.js';

// Kezdőállapot. Minden mező szerializálható (JSON-ba írható → hálón küldhető).
// `totalLaps`: a verseny hossza körökben — a rajtnál választható (menü/host);
// ha nincs megadva, a config alapértéke (RACE.laps). A raceStep EZT használja.
// `pitStopRequired`: kötelező kerékcsere van-e ehhez a futamhoz (lásd
// updatePitStop lent) — csak akkor van értelme, ha a hívó a pályán TALÁLT is
// legalább 2 pontos boxutca-útvonalat (lásd trackStorage.js loadPitLane);
// egyébként a cél sosem zárulna le.
export function createRaceState(totalLaps, pitStopRequired = false) {
  return {
    phase: 'countdown', // 'countdown' → 'racing' → 'finished'
    countdownLeft: RACE.countdownSeconds, // s — hátralévő visszaszámlálás
    time: 0, // s — versenyidő a GO óta (finished után áll)
    totalLaps: totalLaps || RACE.laps, // ennyi kör után van cél
    lap: 1, // aktuális kör (1-től)
    nextCheckpoint: 1, // a KÖVETKEZŐ átszelendő checkpoint indexe (0 = célvonal)
    lapStartTime: 0, // s — az aktuális kör kezdete (versenyidőben)
    lastLapTime: null, // s — utolsó teljesített kör ideje
    lastLapValid: true, // az utolsó teljesített kör érvényes volt-e
    bestLapTime: null, // s — legjobb kör (CSAK érvényes körökből)
    lapTimes: [], // s[] — az összes teljesített kör
    wrongWay: false, // épp rossz irányba megy-e (HUD jelzi)
    wrongWaySeconds: 0, // s — mióta halad elfelé (türelmi idő számláló)
    lapValid: true, // az AKTUÁLIS kör érvényes-e — ha a kör alatt letér a pályáról
    //                (fűre/sarokvágás), false lesz, és a köridő nem számít a legjobbhoz.
    currentSplits: [], // s[] — az AKTUÁLIS kör eddigi checkpont-időpillanatai (lapStartTime-tól)
    bestLapSplits: null, // s[] — a legjobb (érvényes) kör checkpont-időpillanatai, ua. indexeléssel
    lastSplitDelta: null, // s — a legutóbb átszelt checkpointnál mért idő - a legjobb kör UGYANAZON
    //                        checkpontjának ideje (negatív = gyorsabb, pozitív = lassabb). A HUD
    //                        ezt (és lastSplitAt-et) egy pár másodperces zöld/piros jelzéshez használja.
    lastSplitAt: null, // s — versenyidő, amikor a lastSplitDelta született (a HUD ebből tudja, mikor tűnjön el)
    pitStopRequired: !!pitStopRequired, // a HUD ebből dönti el, mutassa-e a "Kötelező kiállás" jelzést
    pitStopDone: !pitStopRequired, // ha nem kötelező, "készen" indul — a raceStep sosem várja meg
    pitStopTimer: 0, // s — mióta áll folyamatosan a zónában (lásd updatePitStop)
    // Igaz, ha az UTOLSÓ körben a célvonal-átszelés MÁR megtörtént, de a
    // kötelező kiállás hiánya miatt elutasításra került (lásd raceStep) — csak
    // EKKOR szabad a pitStopDone teljesülését ÖNMAGÁBAN (újabb fizikai
    // átszelés nélkül) célnak elfogadni. Enélkül a `nextCheckpoint === 0`
    // (ami MINDEN kör végén, a célvonal közeledtekor amúgy is előfordul, nem
    // csak elutasítás után) tévesen azonnali lezárást okozott, ha a kiállás
    // egy KÖZTES körben, a célvonal előtt teljesült (élő hibajelentés).
    pitFinishPending: false,
  };
}

// A boxutca-útvonal tömbje KÉTFÉLE pontot tartalmazhat: a rajzolt ÚTVONALAT
// (egymást követő {x,z} pontok, ezek adják a szakaszokat) és TETSZŐLEGES SZÁMÚ
// (legfeljebb RACE.pitStop.maxBoxes) külön "boxhely" jelölőt
// ({x,z,isBox:true}) — ezek NEM részei az összekötött útvonalnak (ne rontsák
// el a szalag alakját), csak kiegészítő pontok ugyanabban a tömbben (így NEM
// kell külön mentési mező/szerver-validáció, lásd trackStorage.js). Ez a
// segédfüggvény szétválasztja a kettőt — mindenki, aki az útvonal ALAKJÁT
// rajzolja/méri (szalag, fű-mentesség, checkpoint-szélesítés), a `path`-t
// használja, a megállás-ellenőrzés (updatePitStop, pitBoxForSlot) pedig a
// `boxes`-t.
export function splitPitLane(pitLanePoints) {
  const arr = Array.isArray(pitLanePoints) ? pitLanePoints : [];
  const boxes = arr.filter((p) => p && p.isBox);
  const path = arr.filter((p) => p && !p.isBox);
  return { path, boxes };
}

// Igaz, ha a boxutca HASZNÁLATRA KÉSZ: van legalább 2 pontos útvonala ÉS
// legalább 1 kijelölt boxhelye — csak EKKOR van értelme a "Kötelező
// kerékcsere" kapcsolónak (lásd main.js/raceTracker.js pitStopRequired
// számítása), különben a cél sosem zárulna le (nincs hova megállni).
export function pitLaneReady(pitLanePoints) {
  const { path, boxes } = splitPitLane(pitLanePoints);
  return path.length >= 2 && boxes.length >= 1;
}

// A JÁTÉKOS SAJÁT boxhelye — a slotIndex (rajtrács-pozíció, a belépési
// sorrend, lásd server/RaceRoom.js p.slotIndex) alapján, KÖRKÖRÖSEN (ha
// kevesebb boxhely van kijelölve, mint ahány játékos ül a szobában).
// Multiplayerben így MINDENKINEK saját helye van — nem kell osztozniuk
// ugyanazon a boxon. Egyjátékosban mindig a slotIndex=0 (az egyetlen)
// boxot adja. null-t ad, ha nincs kijelölt boxhely.
export function pitBoxForSlot(pitLanePoints, slotIndex) {
  const { boxes } = splitPitLane(pitLanePoints);
  if (boxes.length === 0) return null;
  const i = ((slotIndex % boxes.length) + boxes.length) % boxes.length;
  return boxes[i];
}

// A boxutca-útvonalon (points, {x,z}[] — SZABADON rajzolt, NYITOTT polyline,
// lásd editor.js "Boxutca rajzolása" mód) a (x,y) ponthoz legközelebbi
// SZAKASZ távolsága. Ugyanaz a pont-szakasz vetítés, mint sim/trackFactory.js
// offRoadExcess-e, csak NYITOTT útvonalra (nincs "utolsó→első" záró szakasz).
// Üres/hiányzó/1-pontos útvonalra Infinity (nincs mit mérni). A boxhely-
// jelölőt (isBox) NEM veszi figyelembe (lásd splitPitLane) — az nem az
// útvonal alakjának része.
// A rajzolt útvonal ABSZOLÚT első/utolsó pontján túl (a "bekötési
// pontoknál") legfeljebb ekkora sugarú, kis "csatlakozó" tűrést engedünk —
// NEM a teljes laneWidth/2-t — és ez a tűrés is csak a BURKOLAT-mentességnél
// (withPitLaneOffRoad) él, a sebességkorlátnál (isInPitLane) egyáltalán nem
// (lásd distanceToPitLane `includeEndCap` paramétere). Élő hibajelentés: a
// teljes laneWidth/2 (5 m) a vetítés-levágás miatt egy TELJES KÖRRÉ hajlik a
// végpont körül, ami átlóghatott a rendes pálya aszfaltjára a bekötésnél —
// ott tévesen érvénybe léptette a boxutcai sebességkorlátot a rendes
// vonalon haladva is. A burkolat-mentességnél ez a kis tűrés ártalmatlan
// (sőt: kell is a sima fizikai átmenethez), a sebességkorlátnál viszont NEM
// az — ott a végpontokon túl semmilyen ráhagyás nem jár, csak a ténylegesen
// megrajzolt szakaszokon belül (lásd isInPitLane).
const END_CAP_RADIUS = 3; // m

function distanceToPitLane(x, y, pitLanePoints, includeEndCap = true) {
  const { path: points } = splitPitLane(pitLanePoints);
  if (points.length < 2) return Infinity;
  let minDist = Infinity;
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.z - a.z;
    const lenSq = dx * dx + dy * dy;
    const rawT = lenSq < 1e-9 ? 0 : ((x - a.x) * dx + (y - a.z) * dy) / lenSq;
    const beyondStart = i === 0 && rawT < 0;
    const beyondEnd = i === n - 2 && rawT > 1;
    const t = Math.max(0, Math.min(1, rawT));
    const cx = a.x + t * dx;
    const cy = a.z + t * dy;
    const d = Math.hypot(x - cx, y - cy);
    if (beyondStart || beyondEnd) {
      if (includeEndCap && d <= END_CAP_RADIUS && d < minDist) minDist = d;
    } else if (d < minDist) {
      minDist = d;
    }
  }
  return minDist;
}

// A boxhely félátlója + kis ráhagyás — lásd withPitLaneOffRoad megjegyzését.
// Megosztva innen, hogy az isInPitLane (sebességkorlát) UGYANEZT a
// boxhely-tűrést használja, mint a burkolat-mentesség — különben a boxhely
// (ami gyakran az útvonal VÉGE közelében van, tehát az END_CAP_RADIUS-on
// kívül eshet) kimaradhatna a boxutcai sebességkorlát alól.
function nearAnyPitBox(x, y, boxes) {
  if (boxes.length === 0) return false;
  const boxRadius = Math.hypot(RACE.pitStop.boxWidth, RACE.pitStop.boxDepth) / 2 + 2;
  for (const b of boxes) {
    if (Math.hypot(x - b.x, y - b.z) <= boxRadius) return true;
  }
  return false;
}

// (x,y) a boxutca-útvonal MENTÉN (laneWidth/2-n belül) VAGY egy boxhely
// közelében van-e — a hívó (main.js) ezzel dönti el, érvényes-e a boxutcai
// sebességkorlát (lásd RACE.pitStop.maxLaneSpeed / sim/car.js updateCar hívása).
// `offRoadExcess` (opcionális, a FŐ pályáé): a "strict" (végpont-túlnyúlás
// nélküli) útvonal-tűrés ÖNMAGÁBAN nem elég — élő hibajelentés (az "1"
// pályán MÉRVE) mutatta meg, hogy a boxutca rajzolt VÉGPONTJAI (nem a
// végponton TÚLI rész, hanem maga a lerakott pont) simán ESHETNEK a rendes
// pálya aszfaltjára (offRoadExcess pontosan 0 ott, minden más útvonal-/
// boxhely-pont viszont messze — a MÉRÉS szerint 9-13 m — a pályától). Ha a
// hívó megadja a fő pálya offRoadExcess-ét, és a pont MÁR ÚGYIS a rendes
// pályán van, a boxutcai korlát nem lép életbe — MÉRVE: ez a valós
// geometrián kizárólag a két bekötési pontot érinti, a lane belsejét nem
// (lásd sim/race.js-hez tartozó szórvány-tesztek).
export function isInPitLane(x, y, pitLanePoints, offRoadExcess) {
  if (offRoadExcess && offRoadExcess(x, y) <= 0) return false;
  if (distanceToPitLane(x, y, pitLanePoints, false) <= RACE.pitStop.laneWidth / 2) return true;
  return nearAnyPitBox(x, y, splitPitLane(pitLanePoints).boxes);
}

// A boxutca-útvonal BURKOLATKÉNT (nem csak megállásra kijelölt területként) is
// viselkedik: az autó szabadon behajthat, anélkül hogy "letért a pályáról"
// büntetést kapna (fű-lassítás/érvénytelen kör), még akkor is, ha az útvonal a
// FŐ pályától távolabb, párhuzamosan fut (pl. a célegyenes mellett). A hívó
// (sim/track.js kliensen, server/raceTracker.js szerveren) a PÁLYA saját
// offRoadExcess-ét adja át — ez nem magában a trackFactory.js-ben él, mert az
// szándékosan nem ismeri a boxutcát (lásd trackFactory.js fejléc-megjegyzését:
// pálya-független marad).
export function withPitLaneOffRoad(offRoadExcess, pitLanePoints) {
  const { path, boxes } = splitPitLane(pitLanePoints);
  if (path.length < 2) return offRoadExcess;
  return (x, y) => {
    const base = offRoadExcess(x, y);
    if (base <= 0) return base; // már úgyis a pályán van
    if (distanceToPitLane(x, y, pitLanePoints) <= RACE.pitStop.laneWidth / 2) return 0;
    // A boxhely köré is jár ez a "burkolat" tűrés, NEM CSAK az útvonal
    // középvonala köré — élő hibajelentés: szűk hely esetén (a boxutca és a
    // fő pálya közt kevés a tér, VAGY a boxhely az útvonal VÉGE közelében
    // van, az END_CAP_RADIUS-on túl) a boxhely SZÉLE kieshetne a lane
    // tűréséből, miközben a versenyző vizuálisan egyértelműen "a boxban/a
    // boxutcán" van, nem a fűben (lásd nearAnyPitBox).
    if (nearAnyPitBox(x, y, boxes)) return 0;
    return base;
  };
}

// A checkpoint-vonalak (trackFactory.js) FIX szélességűek (a pálya-szélesség
// + rázókő + fű-tűrés) — ez elég ahhoz, hogy sarok-vágásnál/fűre letérésnél
// még átszelhető legyen, DE nem garantáltan ér el egy boxutcáig, ami a fő
// úttól szokatlanabb távolságra/irányban futhat (élő hibajelentés: a
// célvonal mellett, azt "átívelő" — előtte kezdődő, utána végződő —
// boxutcán áthaladva a kör nem záródott le, mert a célvonal-checkpoint
// vonala egyszerűen nem ért el odáig). Ez a függvény minden checkpointot,
// aminek a boxutca VALAMELYIK pontja a közelében van, a legtávolabbi közeli
// boxutca-pontig kiszélesít — így garantáltan átszelhető, FÜGGETLENÜL attól,
// milyen messze/milyen szögben fut a boxutca. A hívó (sim/track.js kliensen,
// server/raceTracker.js szerveren) ezt hívja meg EGYSZER, pálya-építéskor —
// nem a trackFactory.js-ben él, mert az szándékosan nem ismeri a boxutcát.
// `trackProgress` (x,y)=>0..1 és `trackLength` (m): a pálya SAJÁT hurok-menti
// pozíció-mérése (trackFactory.js trackProgress, ugyanaz, amit az élő állás
// sorrendje is használ) — ezzel dönthető el, hogy egy Euklideszi-távolban
// "közeli" boxutca-pont VALÓBAN ehhez a checkponthoz tartozik-e, vagy csak a
// pálya egy TÁVOLI (a hurok más szakaszán lévő) pontja esik történetesen
// fizikailag közel (kanyargó pálya, élő hibajelentés). Opcionális — ha a
// hívó nem adja meg, a régi (csak légvonalbeli) szűrésre esik vissza.
export function widenCheckpointsForPitLane(checkpoints, pitLanePoints, trackProgress, trackLength) {
  const { path: points } = splitPitLane(pitLanePoints);
  if (points.length < 2) return checkpoints;
  // "Közeli" = a checkpont KÖZÉPPONTJÁTÓL mért VALÓDI (mindkét irányú)
  // távolság ezen belül van — ELSŐ javítási kísérletnél ezt tévesen csak a
  // HALADÁSI IRÁNYÚ komponensre szűkítettem, a keresztirányút EGYÁLTALÁN nem
  // korlátozva — élő hibajelentés (ugyanazon a pályán, tisztán a középvonalon
  // haladva is "sarok-vágás" miatt érvénytelenné vált a kör) mutatta meg,
  // hogy ez ÖNMAGÁBAN nem elég: egy pont, ami hosszirányban közeli, DE
  // keresztirányban több száz méterre van, simán átment a szűrőn, és a teljes
  // keresztirányú távolságával szélesítette a checkpointot (mért eset: 312 m
  // hosszú vonal) — ami a pálya EGY EGÉSZEN MÁS pontján, a versenyző valódi
  // (pályán belüli!) útját is átmetszette, hamis "kihagyott checkpoint"
  // jelzést adva. A javítás: a szűrés a VALÓDI távolságot nézi (mindkét
  // komponens együtt bezárva NEARBY_M-be), a szélesítés MÉRTÉKE viszont
  // továbbra is csak a keresztirányú komponens — így a widen soha nem lehet
  // nagyobb, mint NEARBY_M + MARGIN_M, FÜGGETLENÜL attól, milyen irányban áll
  // a boxutca-pont a checkponthoz képest.
  //
  // EZ MÉG MINDIG NEM ELÉG kanyargó pályán: élő hibajelentés (ugyanazon
  // pályán, a rajtegyenesen, tisztán a pályán haladva) mutatta meg, hogy a
  // pálya EGY TÁVOLI (más körszakaszon lévő) checkpointja is "közelinek"
  // számíthat pusztán légvonalban, ha a kanyargó pálya visszahajlik a
  // boxutca közelébe — a NEARBY_M ilyenkor akár 60-70 m-es keresztirányú
  // szélesítést is engedett egy, a hurok EGY EGÉSZEN MÁS pontján lévő
  // checkpointnak, ami így átmetszette a versenyző valódi útját egy teljesen
  // más helyen. Ezért — ha a hívó megadja — a relevancia-szűrés MOST a pálya
  // SAJÁT (hurok-menti) távolságát is megköveteli, nem csak a légvonalbelit:
  // egy pont csak akkor számít "közelinek" egy checkponthoz, ha MINDKÉT
  // mérték szerint közeli — a légvonalbeli ÉS a pálya mentén mért is.
  const NEARBY_M = 80;
  const MARGIN_M = 5;
  const haveProgress = typeof trackProgress === 'function' && Number.isFinite(trackLength) && trackLength > 0;
  return checkpoints.map((cp) => {
    const mx = (cp.a.x + cp.b.x) / 2;
    const my = (cp.a.y + cp.b.y) / 2;
    const dirX = cp.b.x - cp.a.x;
    const dirY = cp.b.y - cp.a.y;
    const len = Math.hypot(dirX, dirY);
    if (len < 1e-6) return cp;
    const ux = dirX / len; // a checkpoint SAJÁT tengelye (keresztirányban, ebbe szélesítünk)
    const uy = dirY / len;
    const cpProgress = haveProgress ? trackProgress(mx, my) * trackLength : null;
    let maxReach = 0;
    let found = false;
    for (const p of points) {
      const dx = p.x - mx;
      const dy = p.z - my;
      if (Math.hypot(dx, dy) > NEARBY_M) continue; // légvonalbeli előszűrés
      if (haveProgress) {
        const pProgress = trackProgress(p.x, p.z) * trackLength;
        const raw = Math.abs(pProgress - cpProgress);
        const alongTrackDist = Math.min(raw, trackLength - raw); // körkörös (a hurok zár)
        if (alongTrackDist > NEARBY_M) continue; // a hurok EGY MÁSIK szakaszán van, nem ide tartozik
      }
      found = true;
      const across = Math.abs(dx * ux + dy * uy); // csak a keresztirányú komponens hízlalja a widen-t
      if (across > maxReach) maxReach = across;
    }
    if (!found) return cp;
    const extend = maxReach + MARGIN_M;
    return {
      a: { x: mx - ux * extend, y: my - uy * extend },
      b: { x: mx + ux * extend, y: my + uy * extend },
    };
  });
}

// Kötelező kerékcsere haladásának frissítése — minden fizika-lépésben hívandó,
// a raceStep MELLETT (ugyanúgy, mint offTrack/hitsCone: a hívó adja a geometriát,
// ez a modul pálya-független marad). NEM elég bárhol megállni a boxutcában —
// a JÁTÉKOS SAJÁT, KIJELÖLT boxhelyén (`pitBox` — a hívó ezt MÁR feloldotta a
// saját slotIndexére, lásd pitBoxForSlot) kell, RACE.pitStop.boxRadius-on
// belül, ~állva (speed <= maxSpeed), RACE.pitStop.requiredSeconds-ot
// folyamatosan; kilépés/felgyorsulás előtte nullázza a számlálót (nem
// "gyűjtögethető" több rövid megállásból — ez a legegyszerűbb, egyértelmű
// szabály). Ha a hívó nem talált saját boxhelyet (pitBox === null), a
// kötelezettség sosem teljesülhet (a hívók ezért a pitLaneReady()-vel
// előzetesen leellenőrzik, hogy egyáltalán van-e értelme kötelezővé tenni).
export function updatePitStop(state, x, y, speed, pitBox, dt) {
  if (!state.pitStopRequired || state.pitStopDone) return;
  if (state.phase !== 'racing' || !pitBox) {
    state.pitStopTimer = 0;
    return;
  }
  const onSpot = Math.hypot(x - pitBox.x, y - pitBox.z) <= RACE.pitStop.boxRadius;
  if (onSpot && speed <= RACE.pitStop.maxSpeed) {
    state.pitStopTimer += dt;
    if (state.pitStopTimer >= RACE.pitStop.requiredSeconds) state.pitStopDone = true;
  } else {
    state.pitStopTimer = 0;
  }
}

// Rossz irány detektálás: a haladási irány SZEMBEN áll-e a pálya HELYI (a jelenlegi
// pozícióhoz legközelebbi középvonal-ponton mért) haladási irányával. Türelmi idővel
// (graceSeconds), hogy egy kanyarbeli megcsúszás ne riasszon.
//
// KORÁBBAN a következő checkpointra mutató EGYENES vonalat néztük — ez kanyarban
// megbízhatatlan volt: a checkpoint a kanyar túloldalán lehet, így a hozzá mutató
// "légvonal" irány jelentősen eltérhet a tényleges útiránytól, ami hamis "rossz
// irány" jelzést adott pont a kanyarokban. A pálya helyi iránya (trackDirAt) ehelyett
// mindig a tényleges, ott érvényes haladási irány — kanyarban is megbízható.
function updateWrongWay(state, prevPos, currPos, dt, trackDirAt) {
  const mvx = currPos.x - prevPos.x;
  const mvy = currPos.y - prevPos.y;
  const speed = Math.hypot(mvx, mvy) / dt;

  const heading = trackDirAt(currPos.x, currPos.y);
  const tdx = Math.cos(heading);
  const tdy = Math.sin(heading);
  const movingAway = speed >= RACE.wrongWay.minSpeed && mvx * tdx + mvy * tdy < 0;

  state.wrongWaySeconds = movingAway ? state.wrongWaySeconds + dt : 0;
  state.wrongWay = state.wrongWaySeconds >= RACE.wrongWay.graceSeconds;
}

// Előjeles terület-orientáció: merre esik c az a→b egyeneshez képest.
function orient(a, b, c) {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

// Két szakasz (p1→p2 és q1→q2) valódi metszése. Ha az autó nem mozdult
// (p1 == p2), minden orientáció 0 → nincs metszés, helyesen.
// Exportálva: a Hot Lap mód (main.js) ezzel ismeri fel a guruló rajt UTÁN a
// TÉNYLEGES rajtvonal első átszelését (a raceStep ezt — helyesen — figyelmen
// kívül hagyja, hiszen nextCheckpoint=1-nél a 0. checkpoint nincs a lookahead-
// ablakban), hogy onnantól indítsa a kör-időzítést.
export function segmentsCross(p1, p2, q1, q2) {
  return (
    orient(p1, p2, q1) !== orient(p1, p2, q2) &&
    orient(q1, q2, p1) !== orient(q1, q2, p2)
  );
}

// Egy fizika-lépésnyi verseny-frissítés. MUTÁLJA a state-et (determinisztikusan),
// és eseménylistát ad vissza (HUD/hang/hálózat reagálhat rá):
//   {type:'go'} | {type:'checkpoint', index, splitTime?, delta?} | {type:'lap', lapTime} | {type:'finish', totalTime}
// A `delta` (lásd state.lastSplitDelta is) csak sorrend szerinti checkpointnál
// van jelen, és csak ha már van referencia (state.bestLapSplits).
// A `checkpoints` paraméterben kapja a pálya keresztvonalait (kliensen a track.js
// singletonét, szerveren a szoba trackState-jét) — így a modul pálya-független.
// `offTrack` (bool): a hívó adja meg, hogy az autó JELENLEG a pályán kívül van-e
// (fűre tért / sarkot vágott). Ha a kör ALATT bármikor igaz, a kör érvénytelen lesz
// (lapValid=false), és a köridő NEM számít a legjobbhoz. A hívó ezt az offRoadExcess-ből
// számolja (kliensen track.js, szerveren a szoba trackState-je) egy tűréshatárral.
// `trackDirAt` (x,y)=>rad: a pálya helyi haladási iránya — a rossz-irány
// detektáláshoz (kliensen track.js trackHeadingAt, szerveren a trackState-je).
export function raceStep(state, prevPos, currPos, dt, checkpoints, offTrack = false, trackDirAt) {
  const events = [];

  if (state.phase === 'countdown') {
    state.countdownLeft -= dt;
    if (state.countdownLeft <= 0) {
      state.countdownLeft = 0;
      state.phase = 'racing';
      events.push({ type: 'go' });
    }
    return events;
  }

  if (state.phase !== 'racing') return events; // finished: az idő áll

  state.time += dt;
  if (offTrack) state.lapValid = false; // letért a pályáról → az egész kör érvénytelen
  if (trackDirAt) updateWrongWay(state, prevPos, currPos, dt, trackDirAt);

  // A kötelező kerékcsere UTÓLAG teljesült (updatePitStop — ami ezen a
  // függvényen KÍVÜL, minden fizika-lépésben lefut — a raceStep MOST
  // következő hívásakor látja, hogy pitStopDone igazzá vált). A
  // `pitFinishPending` flag KIZÁRÓLAG akkor igaz, ha a célvonal-átszelés MÁR
  // ténylegesen megtörtént az utolsó körben, és a kiállás hiánya miatt lett
  // elutasítva (lásd lent) — ilyenkor NEM várjuk meg, hogy a versenyző újra
  // fizikailag átszelje a vonalat (a boxutca jellemzően PONT a célvonal
  // mellett fut, a megállás után egyszerűen továbbhajt, a vonalat többé nem
  // metszi). Élő hibajelentés: korábban ez pusztán `nextCheckpoint === 0`
  // alapján dőlt el, ami MINDEN kör végén előfordul (a célvonal a soron
  // következő checkpoint) — emiatt a verseny AZONNAL lezárult, ha a
  // kötelező kiállás egy KÖZTES körben, még a célvonal ELSŐ elérése ELŐTT
  // teljesült.
  if (state.pitFinishPending && state.pitStopDone) {
    state.pitFinishPending = false;
    state.phase = 'finished';
    events.push({ type: 'finish', totalTime: state.time });
    return events;
  }

  // Alapesetben csak a SORON KÖVETKEZŐ checkpoint átszelése számít — a sorrend
  // így kikényszerített. DE ha sarkot vágunk (a pályán kívül kerülve megkerülünk
  // egy köztes checkpointot úgy, hogy a vonalát SOHA nem metsszük), a
  // `nextCheckpoint` örökre megakadt volna azon a ponton, és a célvonal-átszelés
  // se számított volna — a kör SOSEM fejeződött be (élő hibajelentés: sarok-
  // vágás után 1 körrel többet kellett menni). Ezért néhány (fél környi)
  // checkpointtal ELŐRE is megnézzük, keresztezte-e MÁR azt az autó — ha igen,
  // a kihagyott közteseket "elfogadjuk" (a kör úgyis érvénytelen lesz, hiszen a
  // kihagyás mindig pályaelhagyást jelent). A keresést fél környire korlátozzuk,
  // nehogy a TÁVOLI célvonalat tévesen a jelenlegi (korai) checkpointtal
  // összekeverjük.
  const maxLookahead = Math.max(1, Math.floor(checkpoints.length / 2));
  let foundOffset = -1;
  for (let k = 0; k <= maxLookahead; k++) {
    const idx = (state.nextCheckpoint + k) % checkpoints.length;
    const c = checkpoints[idx];
    if (segmentsCross(prevPos, currPos, c.a, c.b)) {
      foundOffset = k;
      break;
    }
  }
  if (foundOffset === -1) return events;
  if (foundOffset > 0) state.lapValid = false; // kihagyott checkpoint = sarok-vágás

  const crossedCheckpoint = (state.nextCheckpoint + foundOffset) % checkpoints.length;
  if (crossedCheckpoint !== 0) {
    // Köztes checkpoint: lépünk a következőre (a 3. után a 0 = célvonal jön).
    state.nextCheckpoint = (crossedCheckpoint + 1) % checkpoints.length;
    // Szektoridő/delta CSAK a SORREND SZERINTI (nem sarok-vágással átugrott)
    // checkpointoknál van értelme — az indexük (currentSplits.length) körről
    // körre UGYANAZT a pálya-szakaszt jelenti, ezért összevethető a legjobb
    // kör ugyanolyan indexű split-idejével. Átugrott checkpointnál (foundOffset>0)
    // a kör úgyis érvénytelen lesz, nincs mit összevetni.
    if (foundOffset === 0) {
      const splitTime = state.time - state.lapStartTime;
      const sectorIndex = state.currentSplits.length;
      state.currentSplits.push(splitTime);
      const refSplit = state.bestLapSplits ? state.bestLapSplits[sectorIndex] : null;
      state.lastSplitDelta = refSplit != null ? splitTime - refSplit : null;
      state.lastSplitAt = state.time;
      events.push({ type: 'checkpoint', index: state.nextCheckpoint, splitTime, delta: state.lastSplitDelta });
    } else {
      events.push({ type: 'checkpoint', index: state.nextCheckpoint });
    }
    return events;
  }

  // Célvonal, minden checkpointtal a zsebünkben: kör teljesítve.
  const lapTime = state.time - state.lapStartTime;
  const valid = state.lapValid;
  state.lapTimes.push({ time: lapTime, valid });
  state.lastLapTime = lapTime;
  state.lastLapValid = valid;
  // A legjobb körhöz CSAK érvényes kör számít — az ehhez a körhöz tartozó
  // split-időket (currentSplits) ilyenkor referenciaként elmentjük, hogy a
  // KÖVETKEZŐ kör checkpointjai ehhez tudjanak delta-t számolni.
  if (valid && (state.bestLapTime === null || lapTime < state.bestLapTime)) {
    state.bestLapTime = lapTime;
    state.bestLapSplits = state.currentSplits.slice();
  }
  state.currentSplits = [];

  if (state.lap >= state.totalLaps) {
    if (state.pitStopDone) {
      state.phase = 'finished';
      events.push({ type: 'finish', totalTime: state.time });
    } else {
      // Kötelező kiállás még nem történt meg — a célvonal-átszelés NEM zárja le
      // a versenyt, a `lap` szám nem nő (a HUD-on marad "utolsó kör/utolsó kör").
      // FONTOS: a `nextCheckpoint` MARAD 0 (NEM ugrik 1-re)! Élő hibajelentés:
      // korábban 1-re állt, ami azt jelentette, hogy a TELJES kört újra végig
      // kellett volna hajtani (1→2→3→4→5→0), mielőtt a célvonal-átszelés újra
      // számítana — miközben a boxutca jellemzően PONT a célvonal mellett fut,
      // tehát a játékos csak megállt a boxban, majd egyszerűen továbbment, a
      // checkpointok érintése nélkül. A 0-n maradó nextCheckpoint miatt a
      // KÖVETKEZŐ célvonal-átszelés (akár rögtön ugyanott, kerülő nélkül) azonnal
      // felismerésre kerül, amint a kötelezettség teljesült.
      state.lapStartTime = state.time;
      state.lapValid = true;
      state.pitFinishPending = true; // lásd a fenti ellenőrzés megjegyzését
      events.push({ type: 'lap', lapTime, valid, pitRequired: true });
    }
  } else {
    state.lap += 1;
    state.lapStartTime = state.time;
    state.nextCheckpoint = 1;
    state.lapValid = true; // új kör → tiszta lap, újra érvényes
    events.push({ type: 'lap', lapTime, valid });
  }
  return events;
}
