// A pálya SIM-oldala a KLIENSEN: a config-beli (localStorage-ból betöltött vagy
// alapértelmezett) layoutból egyszer felépíti a pálya-állapotot, és a megszokott
// neveken exportálja — a tényleges logika a környezet-független trackFactory.js-ben
// él, amit a Colyseus szerver is ugyanígy használ (szobánként más layouttal).
//
// Nincs fizikai fal: letérni a fűre lehet, de ott a gáz erősen korlátozott
// (lásd sim/car.js updateOffRoadPenalty) — ez tartja a pályán az autót.
//
// Koordináta-leképezés: builder (x, z) = 3D talajsík; Planck fizika (x, y=z).
import { TRACK } from '../config.js';
import { createTrackState } from './trackFactory.js';
import { loadPitLane } from '../trackStorage.js';
import { withPitLaneOffRoad, widenCheckpointsForPitLane } from './race.js';

export const trackState = createTrackState(TRACK.layout, {
  tile: TRACK.tile,
  curbWidth: TRACK.curbWidth,
  gravelWidth: TRACK.gravelWidth,
  checkpointCount: TRACK.checkpointCount,
  start: TRACK.start,
});

const pitLanePoints = loadPitLane();

export const track = trackState.track;
export const spawn = trackState.spawn;
// A boxutcával érintkező checkpointokat (jellemzően a célvonal) kiszélesíti —
// lásd sim/race.js widenCheckpointsForPitLane — hogy a boxutcán áthaladva is
// biztosan érzékelje az átszelést, függetlenül a boxutca pontos távolságától/
// irányától a főúthoz képest.
export const checkpoints = widenCheckpointsForPitLane(
  trackState.checkpoints,
  pitLanePoints,
  trackState.trackProgress,
  trackState.trackLength
);
// A boxutca-útvonal (ha van a pályán) BURKOLATKÉNT viselkedik — büntetlenül
// behajtható (lásd sim/race.js withPitLaneOffRoad). A trackFactory maga nem
// ismeri ezt az útvonalat, ezért itt, a klienshez tartozó egyszeri
// pálya-építésnél fonjuk rá.
export const offRoadExcess = withPitLaneOffRoad(trackState.offRoadExcess, pitLanePoints);
export const trackHeadingAt = trackState.trackHeadingAt;

// Réteg-távolságok a középvonaltól (méter) — a render-réteg használja.
export const ROAD_HALF = trackState.roadHalf;
export const CURB_EDGE = trackState.curbEdge;
export const CHECKPOINT_HALF_WIDTH = trackState.checkpointHalfWidth;
