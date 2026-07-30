// =============================================================================
//  KÖRIDŐ-HIHETŐSÉG — a ranglistára beküldött idők FIZIKAI alsó korlátja.
//
//  A játék kliens-autoritatív (lásd RaceRoom.js fejléc), tehát a köridőt a kliens
//  jelenti be — teljes csalás-védelem elvileg lehetetlen szerver-oldali szimuláció
//  nélkül. AMI viszont olcsón kizárható: a FIZIKAILAG LEHETETLEN idő. A kör hossza
//  ismert (a trackKey-hez tartozó layoutból kiszámolható), az autó csúcssebessége
//  a config-ban adott felső korlát — ennél gyorsabban a pálya hosszát senki nem
//  teheti meg. Egy "0.5 másodperces kör" tehát biztosan hamis, és elutasítható.
//
//  Ez nem "anti-cheat", hanem józansági szűrő: a ranglistát a nyilvánvaló
//  szemét-beküldéstől (bárki curl-özhet a nyílt POST /api/leaderboard-ra) védi.
// =============================================================================
import { TRACK, PHYSICS_PRESETS, CAR } from '../src/config.js';
import { createTrackState } from '../src/sim/trackFactory.js';
import { hashLayout } from '../src/sim/trackKey.js';
import { DEFAULT_LAYOUT } from '../src/config.js';
import { listRawTracks } from './trackStore.js';

// A LEGGYORSABB preset csúcssebessége (m/s) — mindig a legmegengedőbbel számolunk,
// hogy egy valós, jogos időt soha ne utasítsunk el.
const MAX_SPEED = Math.max(
  CAR.maxForwardSpeed || 0,
  ...Object.values(PHYSICS_PRESETS).map((p) => p.maxForwardSpeed || 0)
);

// Biztonsági ráhagyás: a ténylegesen megtett ív rövidebb lehet a KÖZÉPVONALNÁL,
// ha a versenyző a kanyarok belső ívét használja (ez szabályos). 0.7 bőven fedi
// ezt, és még mindig nagyságrendekkel a valós köridők alatt van — csak a
// nyilvánvalóan hamis (töredék másodperces) beküldést zárja ki.
const RACING_LINE_FACTOR = 0.7;

// Abszolút alsó korlát, ha a pálya ISMERETLEN (nincs a tárban — pl. egy egyedi,
// el nem mentett layout multiplayer szobából). Ilyenkor a legkisebb ÉRTELMES
// pályára szabott, konzervatív érték marad.
const FALLBACK_MIN_LAP = 3;
const MAX_LAP_TIME = 3600;

// trackKey → minimális hihető köridő (s). A createTrackState nem ingyenes, a
// kulcsok halmaza viszont kicsi és stabil → érdemes gyorsítótárazni.
const minLapCache = new Map();

function trackLengthFor(layout) {
  try {
    return createTrackState(layout, {
      tile: TRACK.tile,
      curbWidth: TRACK.curbWidth,
      gravelWidth: TRACK.gravelWidth,
      checkpointCount: TRACK.checkpointCount,
      start: TRACK.start,
    }).trackLength;
  } catch {
    return null;
  }
}

// A `trackKey`-hez tartozó layout megkeresése: a beépített alappálya, vagy a
// szerveren tárolt pályák közül az, amelynek a geometria-hash-e egyezik.
function layoutForKey(trackKey) {
  if (hashLayout(DEFAULT_LAYOUT) === trackKey) return DEFAULT_LAYOUT;
  for (const t of listRawTracks()) {
    if (hashLayout(t.layout) === trackKey) return t.layout;
  }
  return null;
}

// A minimális hihető köridő EGY ISMERT pályahosszból. Exportálva, hogy a
// multiplayer szoba (server/raceTracker.js) UGYANEZT a képletet használhassa a
// saját trackState.trackLength-jével — ott nem kell (és nem is lehet) trackKey
// alapján visszakeresni a layoutot, viszont a két hely nem térhet el egymástól.
export function minLapFromLength(lengthMeters, maxSpeed = MAX_SPEED) {
  if (!Number.isFinite(lengthMeters) || lengthMeters <= 0 || !(maxSpeed > 0)) {
    return FALLBACK_MIN_LAP;
  }
  return Math.max(FALLBACK_MIN_LAP, (lengthMeters * RACING_LINE_FACTOR) / maxSpeed);
}

export function minPlausibleLapTime(trackKey) {
  if (minLapCache.has(trackKey)) return minLapCache.get(trackKey);
  const layout = layoutForKey(trackKey);
  const len = layout ? trackLengthFor(layout) : null;
  const min = minLapFromLength(len);
  // Ismeretlen pályánál NEM cache-elünk: később elmentheti valaki a pályát, és
  // onnantól a pontos (szigorúbb) korlátot akarjuk használni.
  if (layout) minLapCache.set(trackKey, min);
  return min;
}

// true, ha a beküldött idő fizikailag lehetséges ezen a pályán.
export function isPlausibleLapTime(trackKey, seconds) {
  if (!Number.isFinite(seconds)) return false;
  return seconds >= minPlausibleLapTime(trackKey) && seconds <= MAX_LAP_TIME;
}
