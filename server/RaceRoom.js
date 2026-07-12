// =============================================================================
//  RACE ROOM — a multiplayer verseny SZERVER-oldali szobája (authoritative).
//
//  A szerver futtatja az "igazi" játékot: UGYANAZOKKAL a sim-modulokkal
//  (src/sim/*), mint a kliens — a kliensek csak inputot küldenek és renderelnek.
//  Fázisok: lobby → countdown → racing → finished (host újraindíthatja).
//
//  Állapot-szinkron (3. fázis, egyszerű): a szerver NET.snapshotHz-szel teljes
//  JSON pillanatképet broadcastol ('snapshot'). 2-4 játékosnál ez pár száz bájt —
//  a delta-sync/prediction a 4. fázis dolga.
// =============================================================================
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Room } = require('colyseus'); // a colyseus CJS — createRequire-rel töltjük ESM-ből

import { SIM, TRACK, RACE, NET, DEFAULT_LAYOUT } from '../src/config.js';
import { createTrackState, spawnSlot } from '../src/sim/trackFactory.js';
import { createWorld } from '../src/sim/world.js';
import {
  createCarBody,
  updateCar,
  coastToStop,
  resetCar,
  createDriveState,
  speedKmh,
} from '../src/sim/car.js';
import { createRaceState, raceStep } from '../src/sim/race.js';

const NEUTRAL = Object.freeze({ up: false, down: false, left: false, right: false, drift: false });

export class RaceRoom extends Room {
  onCreate(options) {
    this.maxClients = NET.maxPlayers;

    // A pályát a szobát LÉTREHOZÓ kliens adja (a saját aktív pályája) — validálva.
    const layout = Array.isArray(options?.layout) && options.layout.length > 0
      ? options.layout
      : DEFAULT_LAYOUT;
    this.layout = layout;
    this.decorations = Array.isArray(options?.decorations) ? options.decorations : [];

    this.trackState = createTrackState(layout, {
      tile: TRACK.tile,
      curbWidth: TRACK.curbWidth,
      gravelWidth: TRACK.gravelWidth,
      checkpointCount: TRACK.checkpointCount,
      start: TRACK.start,
    });

    this.world = createWorld();
    this.players = new Map(); // sessionId → { name, colorIdx, body, drive, race, input, prev }
    this.phase = 'lobby'; // 'lobby' | 'countdown' | 'racing' | 'finished'
    this.countdownLeft = 0;
    this.hostId = null;
    this.usedColorIdx = new Set();

    this.onMessage('input', (client, msg) => {
      const p = this.players.get(client.sessionId);
      if (!p || this.phase !== 'racing') return;
      // Csak boolean-öket veszünk át — a kliens sosem küldhet erőt/pozíciót.
      p.input = {
        up: !!msg?.up,
        down: !!msg?.down,
        left: !!msg?.left,
        right: !!msg?.right,
        drift: !!msg?.drift,
      };
    });

    this.onMessage('start', (client) => {
      if (client.sessionId !== this.hostId) return;
      if (this.phase !== 'lobby' && this.phase !== 'finished') return;
      this.startRace();
    });

    // A kliens AZUTÁN kéri el az init-adatokat (pálya, kód), hogy már minden
    // onMessage-kezelőjét regisztrálta — az onJoin-ból küldött üzenet ugyanis
    // versenyhelyzetben el is veszhetne (a kliens handshake közben még nem figyel).
    this.onMessage('ready', (client) => {
      client.send('init', {
        layout: this.layout,
        decorations: this.decorations,
        laps: RACE.laps,
        code: this.roomId,
      });
      this.broadcastLobby();
    });

    // 60 Hz fix-lépéses fizika — determinisztikus, mint a kliensen.
    this.setSimulationInterval((dtMs) => this.simTick(dtMs / 1000), 1000 * SIM.fixedDt);

    // Snapshot-broadcast ritkábban (sávszélesség-kímélés).
    this.snapshotTimer = this.clock.setInterval(
      () => this.broadcastSnapshot(),
      1000 / NET.snapshotHz
    );
  }

  onJoin(client, options) {
    if (!this.hostId) this.hostId = client.sessionId;

    // Első szabad szín-index (0-3) — a kliens ebből választ autó-modellt.
    let colorIdx = 0;
    while (this.usedColorIdx.has(colorIdx)) colorIdx++;
    this.usedColorIdx.add(colorIdx);

    const slotIdx = this.players.size;
    const slot = spawnSlot(this.trackState, slotIdx);
    const body = createCarBody(this.world, slot.x, slot.y, slot.angle);

    this.players.set(client.sessionId, {
      name: String(options?.name || 'Játékos').slice(0, 20),
      colorIdx,
      body,
      drive: createDriveState(),
      race: createRaceState(),
      input: { ...NEUTRAL },
      prev: { x: slot.x, y: slot.y },
      finished: false,
      totalTime: null,
    });

    // Az init-adatokat (pálya stb.) NEM itt küldjük, hanem a kliens 'ready'
    // üzenetére (lásd onCreate) — így biztosan nem vész el a handshake alatt.
    this.broadcastLobby();
  }

  onLeave(client) {
    const p = this.players.get(client.sessionId);
    if (p) {
      this.usedColorIdx.delete(p.colorIdx);
      this.world.destroyBody(p.body);
      this.players.delete(client.sessionId);
    }
    if (client.sessionId === this.hostId) {
      // Host-átadás a legrégebbi bent lévőnek.
      this.hostId = this.players.keys().next().value || null;
    }
    if (this.players.size === 0) return; // a szoba magától megszűnik (autoDispose)
    this.broadcastLobby();
  }

  // --- Verseny-vezérlés ---

  startRace() {
    // Mindenki vissza a rajtrácsra, verseny-állapot nulláról.
    let i = 0;
    for (const p of this.players.values()) {
      const slot = spawnSlot(this.trackState, i++);
      resetCar(p.body, slot.x, slot.y, slot.angle);
      Object.assign(p.race, createRaceState());
      p.race.phase = 'racing'; // a countdownt a SZOBA vezérli, nem a per-játékos state
      p.race.time = 0;
      p.drive.throttleMul = 1;
      p.drive.wasOnGrass = false;
      p.input = { ...NEUTRAL };
      p.prev = { x: slot.x, y: slot.y };
      p.finished = false;
      p.totalTime = null;
    }
    this.phase = 'countdown';
    this.countdownLeft = RACE.countdownSeconds;
    this.finishTimeout = 0;
    this.lock(); // verseny közben nem csatlakozhat új játékos
    this.broadcastLobby();
  }

  simTick(dt) {
    if (this.phase === 'countdown') {
      this.countdownLeft -= dt;
      if (this.countdownLeft <= 0) {
        this.countdownLeft = 0;
        this.phase = 'racing';
      }
      return;
    }
    if (this.phase !== 'racing') return;

    // Input/erők minden autóra, MAJD egyetlen közös world.step (az autók
    // egymással is ütköznek — ugyanabban a Planck világban élnek).
    for (const p of this.players.values()) {
      if (p.finished) coastToStop(p.body);
      else updateCar(p.body, p.input, dt, p.drive, this.trackState.offRoadExcess);
    }
    this.world.step(SIM.fixedDt, SIM.velocityIterations, SIM.positionIterations);

    // Verseny-logika játékosonként (checkpoint/kör/cél).
    let allFinished = true;
    let anyFinished = false;
    for (const p of this.players.values()) {
      const pos = p.body.getPosition();
      const curr = { x: pos.x, y: pos.y };
      if (!p.finished) {
        raceStep(p.race, p.prev, curr, dt, this.trackState.checkpoints);
        if (p.race.phase === 'finished') {
          p.finished = true;
          p.totalTime = p.race.time;
        } else {
          allFinished = false;
        }
      }
      if (p.finished) anyFinished = true;
      p.prev = curr;
    }

    // Az első célba érés után indul egy türelmi óra — lejártakor a még kint
    // lévők DNF-ek (totalTime marad null), és a verseny lezárul.
    if (anyFinished && !allFinished) {
      this.finishTimeout = (this.finishTimeout || 0) + dt;
    }

    if ((allFinished || this.finishTimeout > RACE.finishTimeoutSeconds) && this.players.size > 0) {
      this.phase = 'finished';
      this.finishTimeout = 0;
      this.unlock();
      this.broadcastLobby();
    }
  }

  // --- Üzenetek a klienseknek ---

  broadcastLobby() {
    this.broadcast('lobby', {
      code: this.roomId,
      hostId: this.hostId,
      phase: this.phase,
      players: [...this.players.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        colorIdx: p.colorIdx,
      })),
    });
  }

  broadcastSnapshot() {
    if (this.phase === 'lobby') return;
    const players = {};
    for (const [id, p] of this.players.entries()) {
      const pos = p.body.getPosition();
      players[id] = {
        x: pos.x,
        y: pos.y,
        angle: p.body.getAngle(),
        speed: speedKmh(p.body),
        lap: p.race.lap,
        ncp: p.race.nextCheckpoint,
        curLap: p.race.time - p.race.lapStartTime, // futó köridő (HUD)
        lastLap: p.race.lastLapTime,
        bestLap: p.race.bestLapTime,
        wrongWay: p.race.wrongWay,
        finished: p.finished,
        totalTime: p.totalTime,
        name: p.name,
        colorIdx: p.colorIdx,
      };
    }
    this.broadcast('snapshot', {
      phase: this.phase,
      countdownLeft: this.countdownLeft,
      raceTime: this.firstRaceTime(),
      players,
    });
  }

  // A HUD versenyidejéhez: bármelyik még versenyző játékos race.time-ja jó
  // (mind ugyanakkor rajtolt) — ha már mindenki célba ért, a leggyorsabb ideje.
  firstRaceTime() {
    let t = 0;
    for (const p of this.players.values()) t = Math.max(t, p.race.time);
    return t;
  }
}
