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
export function createRaceState(totalLaps) {
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
  };
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
function segmentsCross(p1, p2, q1, q2) {
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
    state.phase = 'finished';
    events.push({ type: 'finish', totalTime: state.time });
  } else {
    state.lap += 1;
    state.lapStartTime = state.time;
    state.nextCheckpoint = 1;
    state.lapValid = true; // új kör → tiszta lap, újra érvényes
    events.push({ type: 'lap', lapTime, valid });
  }
  return events;
}
