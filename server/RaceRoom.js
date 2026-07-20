// =============================================================================
//  RACE ROOM — a multiplayer verseny SZERVER-oldali szobája.
//
//  KLIENS-AUTORITATÍV MOZGÁS: a szerver NEM szimulál autót. Minden kliens a SAJÁT
//  autóját számolja ki helyben (a bevált egyjátékos-sim), és a kész állapotát
//  'state' üzenetben küldi. A szerver ezt csak ELTÁROLJA és 30 Hz-en szétküldi
//  (relay). Így a saját autót SOSEM "korrigálja" a szerver → nincs rángatás/húzás.
//
//  A szerver marad a KOORDINÁTOR: lobby, host, visszaszámlálás-óra, rajt (slot-
//  kiosztás + fázisváltás), cél-sorrend és a verseny lezárása. A pálya-geometria
//  (spawn-slotok) kell csak neki, fizika nem.
//
//  Kompromisszum (baráti játékhoz vállalt): kliens-autoritatív → csalás ellen nem
//  véd, és kemény ütközésnél a két képernyő kissé eltérhet (a puha szétnyomás
//  tompítja). A "szerver az igazság" modellt (predikció+reconcile) tudatosan
//  cseréltük erre, mert az a valós hálózaton látható korrekció-húzást okozott.
// =============================================================================
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Room } = require('colyseus'); // a colyseus CJS — createRequire-rel töltjük ESM-ből

import { TRACK, RACE, NET, DEFAULT_LAYOUT, resolvePhysicsPreset } from '../src/config.js';
import { createTrackState, spawnSlot } from '../src/sim/trackFactory.js';
import { hashLayout } from '../src/sim/trackKey.js';
import { recordLap } from './leaderboardStore.js';

const num = (v) => (Number.isFinite(v) ? v : 0);
const intOr = (v, d) => (Number.isInteger(v) ? v : d);

// Egy kliens bejelentett autó-állapota (a spawn-pozícióra inicializálva). Minden
// mező a rendereléshez / állás-listához / HUD-hoz kell a TÖBBI kliensnél.
function emptyState(slot) {
  return {
    x: slot.x, y: slot.y, angle: slot.angle,
    vx: 0, vy: 0, w: 0,
    speed: 0, cornering: 0,
    lap: 1, progress: 0, curLap: 0, lastLap: null, bestLap: null,
    lapValid: true, wrongWay: false, finished: false, totalTime: null,
  };
}

export class RaceRoom extends Room {
  onCreate(options) {
    this.maxClients = NET.maxPlayers;

    // A pályát a szobát LÉTREHOZÓ kliens adja (a saját aktív pályája) — validálva.
    const layout = Array.isArray(options?.layout) && options.layout.length > 0
      ? options.layout
      : DEFAULT_LAYOUT;
    this.layout = layout;
    this.decorations = Array.isArray(options?.decorations) ? options.decorations : [];
    // A szoba körszáma — a létrehozó (host) választja; korlátozva 1..50-re.
    this.laps = Number.isFinite(options?.laps)
      ? Math.max(1, Math.min(50, Math.round(options.laps)))
      : RACE.laps;
    // A szoba autó-fizikája (a kliens ezt alkalmazza a helyi simjében).
    this.physics = resolvePhysicsPreset(options?.physics);

    // Örök ranglista: a trackKey a layout GEOMETRIÁJÁHOZ kötött, névtől független.
    this.trackKey = hashLayout(layout);
    this.trackName = String(options?.trackName || 'Egyedi pálya').slice(0, 40);

    // A spawn-slotokhoz kell a pálya-geometria (spawnSlot) — ez NEM fizikai sim.
    this.trackState = createTrackState(layout, {
      tile: TRACK.tile,
      curbWidth: TRACK.curbWidth,
      gravelWidth: TRACK.gravelWidth,
      checkpointCount: TRACK.checkpointCount,
      start: TRACK.start,
    });

    this.players = new Map(); // sessionId → { name, colorIdx, slotIndex, state, finished, place, ... }
    this.phase = 'lobby'; // 'lobby' | 'countdown' | 'racing' | 'finished'
    this.countdownLeft = 0;
    this.hostId = null;
    this.simTime = 0; // szerver-óra (s) — a snapshot időbélyege + laza össz-versenyidő

    // KLIENS-AUTORITATÍV állapot fogadása: átvesszük a kliens által számolt autó-
    // állapotot (számokra szűrve — a szerver nem hisz el NaN-t/hiányzó mezőt).
    this.onMessage('state', (client, msg) => {
      const p = this.players.get(client.sessionId);
      if (!p || this.phase === 'lobby') return;
      const s = p.state;
      s.x = num(msg?.x); s.y = num(msg?.y); s.angle = num(msg?.angle);
      s.vx = num(msg?.vx); s.vy = num(msg?.vy); s.w = num(msg?.w);
      s.speed = num(msg?.speed); s.cornering = num(msg?.cornering);
      s.lap = intOr(msg?.lap, 1); s.progress = num(msg?.progress);
      s.curLap = num(msg?.curLap);
      s.lastLap = msg?.lastLap == null ? null : num(msg.lastLap);
      s.bestLap = msg?.bestLap == null ? null : num(msg.bestLap);
      s.lapValid = msg?.lapValid !== false;
      s.wrongWay = !!msg?.wrongWay;

      // Cél: a kliens jelzi, a HELYEZÉST a szerver osztja a beérkezés sorrendjében
      // (ez a "mindenki a sajátját számolja" modellben a tisztességes rangsor).
      if (msg?.finished && !p.finished) {
        p.finished = true;
        s.finished = true;
        s.totalTime = num(msg?.totalTime);
        p.place = ++this.finishedCount;
      }

      // Örök ranglista: a bejelentett legjobb körből (csak ha ÚJ/JOBB — a tároló
      // amúgy is szűr, ez a felesleges hívásokat spórolja).
      if (
        s.bestLap !== null &&
        (p.lastSubmittedBest === null || s.bestLap < p.lastSubmittedBest - 1e-6)
      ) {
        p.lastSubmittedBest = s.bestLap;
        recordLap(
          {
            trackKey: this.trackKey,
            trackName: this.trackName,
            physics: this.physics,
            playerName: p.name,
            lapTime: s.bestLap,
          },
          Date.now()
        );
      }
    });

    this.onMessage('start', (client) => {
      if (client.sessionId !== this.hostId) return;
      if (this.phase !== 'lobby' && this.phase !== 'finished') return;
      this.startRace();
    });

    // Ping-mérés: a kliens időbélyeget küld, mi azonnal visszaküldjük — a kliens a
    // körbeérésből (RTT) számolja a szerver-kliens késleltetést (lásd main.js).
    this.onMessage('ping', (client, t) => client.send('pong', t));

    // A kliens a 'ready'-re kapja az init-adatokat (pálya, kód, fizika + a SAJÁT
    // spawn-slotja, hogy a helyi sim a jó rácshelyre pozicionáljon).
    this.onMessage('ready', (client) => {
      const p = this.players.get(client.sessionId);
      client.send('init', {
        layout: this.layout,
        decorations: this.decorations,
        laps: this.laps,
        physics: this.physics,
        code: this.roomId,
        slot: p ? p.spawn : null, // a SAJÁT rajtpozíció (x,y,angle) a helyi simhez
      });
      this.broadcastLobby();
    });

    // Szerver-óra (nincs fizika): visszaszámlálás léptetése + cél-koordináció.
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / 20);
    // Snapshot-broadcast (a tárolt kliens-állapotokból).
    this.snapshotTimer = this.clock.setInterval(
      () => this.broadcastSnapshot(),
      1000 / NET.snapshotHz
    );
  }

  onJoin(client, options) {
    if (!this.hostId) this.hostId = client.sessionId;

    const colorIdx =
      Number.isInteger(options?.carIdx) && options.carIdx >= 0 && options.carIdx < 32
        ? options.carIdx
        : 0;

    const slotIndex = this.players.size;
    const slot = spawnSlot(this.trackState, slotIndex);

    this.players.set(client.sessionId, {
      name: String(options?.name || 'Játékos').slice(0, 20),
      colorIdx,
      slotIndex,
      spawn: { x: slot.x, y: slot.y, angle: slot.angle }, // a kliens ide pozicionál
      state: emptyState(slot),
      finished: false,
      place: null,
      lastSubmittedBest: null,
    });

    this.broadcastLobby();
  }

  onLeave(client) {
    this.players.delete(client.sessionId);
    if (client.sessionId === this.hostId) {
      this.hostId = this.players.keys().next().value || null;
    }
    if (this.players.size === 0) return; // a szoba magától megszűnik (autoDispose)
    this.broadcastLobby();
  }

  // --- Verseny-vezérlés ---

  startRace() {
    // Slotok újraosztása (a jelenlegi belépési sorrendben) + állapotok nullázása.
    let i = 0;
    const slots = {};
    for (const [id, p] of this.players.entries()) {
      p.slotIndex = i++;
      const slot = spawnSlot(this.trackState, p.slotIndex);
      p.spawn = { x: slot.x, y: slot.y, angle: slot.angle };
      p.state = emptyState(slot);
      p.finished = false;
      p.place = null;
      p.lastSubmittedBest = null;
      slots[id] = p.spawn; // a kliens a saját id-jéhez tartozó pozícióra pozicionál
    }
    this.phase = 'countdown';
    this.countdownLeft = RACE.countdownSeconds;
    this.finishTimeout = 0;
    this.finishedCount = 0;
    this.simTime = 0;
    this.lock(); // verseny közben nem csatlakozhat új játékos
    // A klienseknek: rajt-slotok — a helyi sim ebből tudja, hova pozicionáljon.
    this.broadcast('raceStart', { slots, laps: this.laps });
    this.broadcastLobby();
  }

  // Szerver-óra: visszaszámlálás + cél-koordináció. NINCS fizika (a mozgást a
  // kliensek számolják, a szerver csak a bejelentett `finished` flageket figyeli).
  tick(dt) {
    this.simTime += dt;

    if (this.phase === 'countdown') {
      this.countdownLeft -= dt;
      if (this.countdownLeft <= 0) {
        this.countdownLeft = 0;
        this.phase = 'racing';
      }
    }

    if (this.phase !== 'racing') return;

    let allFinished = true;
    let anyFinished = false;
    for (const p of this.players.values()) {
      if (p.finished) anyFinished = true;
      else allFinished = false;
    }

    // Az első célba érés után türelmi óra — lejártakor a még kint lévők DNF-ek.
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
      const s = p.state;
      players[id] = {
        x: s.x, y: s.y, angle: s.angle,
        vx: s.vx, vy: s.vy, w: s.w,
        speed: s.speed, cornering: s.cornering,
        lap: s.lap, progress: s.progress, curLap: s.curLap,
        lastLap: s.lastLap, bestLap: s.bestLap,
        lapValid: s.lapValid, wrongWay: s.wrongWay,
        finished: p.finished, totalTime: s.totalTime, place: p.place,
        name: p.name, colorIdx: p.colorIdx,
      };
    }
    this.broadcast('snapshot', {
      t: this.simTime * 1000, // ms — a snapshot szerver-időbélyege (interpolációhoz)
      phase: this.phase,
      countdownLeft: this.countdownLeft,
      players,
    });
  }
}
