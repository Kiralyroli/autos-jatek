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
import { createWorld, createStepper } from '../src/sim/world.js';
import {
  createCarBody,
  updateCar,
  coastToStop,
  resetCar,
  createDriveState,
  speedKmh,
  corneringLoad,
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
    // A szoba szimulációs órája (s) — a snapshotok időbélyege. A kliens EZZEL
    // (nem a csomag-fogadás idejével!) interpolál: a hálózati jitter/burst így
    // nem torzítja az idővonalat (különben szaggatna a mozgás).
    this.simTime = 0;

    this.onMessage('input', (client, msg) => {
      const p = this.players.get(client.sessionId);
      if (!p || this.phase !== 'racing') return;
      // Csak boolean-öket veszünk át — a kliens sosem küldhet erőt/pozíciót.
      const input = {
        up: !!msg?.up,
        down: !!msg?.down,
        left: !!msg?.left,
        right: !!msg?.right,
        drift: !!msg?.drift,
      };
      // A predikciós kliens SORSZÁMOZOTT inputot küld minden fix lépéséhez —
      // sorba tesszük, és fizika-lépésenként EGYET fogyasztunk el (így a szerver
      // pontosan ugyanazt az input-szekvenciát játssza le, mint a kliens helyi
      // predikciója; a lastSeq a snapshotban megy vissza a reconcile-hoz).
      const seq = Number.isFinite(msg?.seq) ? msg.seq : null;
      if (seq !== null && seq > (p.lastQueuedSeq || 0)) {
        p.lastQueuedSeq = seq;
        p.inputQueue.push({ seq, input });
        // Ha a kliens elszaladt (burst/lag utáni bepótlás), a legrégebbieket dobjuk.
        if (p.inputQueue.length > 30) p.inputQueue.splice(0, p.inputQueue.length - 30);
      } else if (seq === null) {
        p.input = input; // sorszám nélküli (régi stílusú) input — azonnal érvényes
      }
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

    // Fix-lépéses fizika AKKUMULÁTORRAL (ugyanaz a createStepper, mint a kliensen).
    // FONTOS: a Node/Windows timer nem pontos (a 16.7ms-os interval ~15.6/31.2ms-onként
    // tüzel felváltva) — ha tüzelésenként pontosan EGY fix lépést tennénk, a
    // szimulációs óra (snapshot-időbélyeg) és a fizika szétcsúszna, és a kliensen
    // a látszólagos sebesség folyamatosan ingadozna (= szaggatás). Az akkumulátor
    // annyi fix lépést futtat, amennyi valós idő ténylegesen eltelt.
    this.stepper = createStepper();
    this.setSimulationInterval(
      (dtMs) =>
        this.stepper(
          this.world,
          dtMs / 1000,
          (fixedDt) => this.beforeStep(fixedDt),
          () => this.afterStep()
        ),
      1000 * SIM.fixedDt
    );

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
      inputQueue: [], // sorszámozott kliens-inputok (predikció) — lépésenként 1 fogy
      lastSeq: 0, // az utolsó FELDOLGOZOTT input sorszáma (snapshotban megy vissza)
      lastQueuedSeq: 0,
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
      p.inputQueue = [];
      p.lastSeq = 0;
      p.lastQueuedSeq = 0;
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

  // Minden fix fizika-lépés ELŐTT: óra, countdown, erők az autókra. A fizika
  // MINDEN fázisban fut (lobby/countdown: a parkoló autók állnak; finished:
  // kigurulás coastToStop-pal — enélkül a célba éréskor a világ befagyna, az
  // autók mozgás közben megdermednének, és a sebesség/motorhang beragadna).
  beforeStep(dt) {
    this.simTime += dt; // a snapshot-időbélyeg PONTOSAN a fizika óráját követi

    if (this.phase === 'countdown') {
      this.countdownLeft -= dt;
      if (this.countdownLeft <= 0) {
        this.countdownLeft = 0;
        this.phase = 'racing';
      }
    }

    for (const p of this.players.values()) {
      if (this.phase === 'racing' && !p.finished) {
        // Lépésenként EGY sorszámozott inputot fogyasztunk (ha van) — ha épp
        // nincs (kimaradó csomag), az utolsó ismert input marad érvényben.
        if (p.inputQueue.length > 0) {
          const q = p.inputQueue.shift();
          p.input = q.input;
          p.lastSeq = q.seq;
        }
        updateCar(p.body, p.input, dt, p.drive, this.trackState.offRoadExcess);
      } else {
        coastToStop(p.body);
      }
    }
  }

  // Minden fix fizika-lépés UTÁN: verseny-logika (checkpoint/kör/cél).
  afterStep() {
    if (this.phase !== 'racing') return;
    const dt = SIM.fixedDt;

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
      const vel = p.body.getLinearVelocity();
      players[id] = {
        x: pos.x,
        y: pos.y,
        angle: p.body.getAngle(),
        // A saját-autó predikció visszatekeréséhez (reconcile) kell a TELJES
        // mozgásállapot + az utolsó feldolgozott input sorszáma:
        vx: vel.x,
        vy: vel.y,
        w: p.body.getAngularVelocity(),
        seq: p.lastSeq,
        speed: speedKmh(p.body),
        cornering: corneringLoad(p.body), // a kliens gumicsikorgás-hangjához
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
      t: this.simTime * 1000, // ms — a fizikai állapot szimulációs időbélyege
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
