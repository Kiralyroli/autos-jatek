// =============================================================================
//  VERSENY-LOGIKA — tiszta, determinisztikus, framework-mentes (lásd CLAUDE.md).
//  A 3. fázisban a Colyseus szerver UGYANEZT a kódot futtatja, ezért:
//   - az állapot sima, szerializálható objektum (nincs closure, nincs DOM),
//   - az idő a fix fizika-lépésekből akkumulálódik (nem Date.now!),
//   - a raceStep bemenete csak az előző/jelenlegi pozíció és a fix dt.
// =============================================================================
import { RACE } from '../config.js';
import { checkpoints } from './track.js';

// Kezdőállapot. Minden mező szerializálható (JSON-ba írható → hálón küldhető).
export function createRaceState() {
  return {
    phase: 'countdown', // 'countdown' → 'racing' → 'finished'
    countdownLeft: RACE.countdownSeconds, // s — hátralévő visszaszámlálás
    time: 0, // s — versenyidő a GO óta (finished után áll)
    lap: 1, // aktuális kör (1-től)
    nextCheckpoint: 1, // a KÖVETKEZŐ átszelendő checkpoint indexe (0 = célvonal)
    lapStartTime: 0, // s — az aktuális kör kezdete (versenyidőben)
    lastLapTime: null, // s — utolsó teljesített kör ideje
    bestLapTime: null, // s — legjobb kör
    lapTimes: [], // s[] — az összes teljesített kör
    wrongWay: false, // épp rossz irányba megy-e (HUD jelzi)
    wrongWaySeconds: 0, // s — mióta halad elfelé (türelmi idő számláló)
  };
}

// A checkpoint-vonalak felezőpontjai — a "jó irány" célpontjai.
const CP_MIDS = checkpoints.map((cp) => ({
  x: (cp.a.x + cp.b.x) / 2,
  y: (cp.a.y + cp.b.y) / 2,
}));

// Rossz irány detektálás: elfelé mozog-e az autó a következő checkpointtól.
// Türelmi idővel (graceSeconds), hogy egy kanyarbeli megcsúszás ne riasszon.
function updateWrongWay(state, prevPos, currPos, dt) {
  const mid = CP_MIDS[state.nextCheckpoint];
  const mvx = currPos.x - prevPos.x;
  const mvy = currPos.y - prevPos.y;
  const speed = Math.hypot(mvx, mvy) / dt;

  const movingAway =
    speed >= RACE.wrongWay.minSpeed &&
    mvx * (mid.x - currPos.x) + mvy * (mid.y - currPos.y) < 0;

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
//   {type:'go'} | {type:'checkpoint', index} | {type:'lap', lapTime} | {type:'finish', totalTime}
export function raceStep(state, prevPos, currPos, dt) {
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
  updateWrongWay(state, prevPos, currPos, dt);

  // Csak a SORON KÖVETKEZŐ checkpoint átszelése számít — a sorrend így kikényszerített.
  const cp = checkpoints[state.nextCheckpoint];
  if (!segmentsCross(prevPos, currPos, cp.a, cp.b)) return events;

  if (state.nextCheckpoint !== 0) {
    // Köztes checkpoint: lépünk a következőre (a 3. után a 0 = célvonal jön).
    state.nextCheckpoint = (state.nextCheckpoint + 1) % checkpoints.length;
    events.push({ type: 'checkpoint', index: state.nextCheckpoint });
    return events;
  }

  // Célvonal, minden checkpointtal a zsebünkben: kör teljesítve.
  const lapTime = state.time - state.lapStartTime;
  state.lapTimes.push(lapTime);
  state.lastLapTime = lapTime;
  if (state.bestLapTime === null || lapTime < state.bestLapTime) {
    state.bestLapTime = lapTime;
  }

  if (state.lap >= RACE.laps) {
    state.phase = 'finished';
    events.push({ type: 'finish', totalTime: state.time });
  } else {
    state.lap += 1;
    state.lapStartTime = state.time;
    state.nextCheckpoint = 1;
    events.push({ type: 'lap', lapTime });
  }
  return events;
}
