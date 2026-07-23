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
import { registerJoinCode, unregisterJoinCode } from './roomCodes.js';

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
    // Verseny-generáció: minden startRace() növeli, és a kliens minden 'state'
    // üzenetben visszaküldi (lásd main.js mpSendState). Így az ELŐZŐ versenyből
    // még hálón lévő (pl. `finished: true`-t tartalmazó) elkésett üzenetek nem
    // tudják tévesen újra "célba ért"-nek jelölni a játékost rögtön az új
    // visszaszámlálás/rajt elején (élő hibajelentés: emiatt állt le azonnal az
    // új verseny, mielőtt elindulhatott volna).
    this.raceGen = 0;
    // Rövid, számokból álló csatlakozási kód (lásd roomCodes.js) — a hosszú
    // belső Colyseus roomId helyett ezt mondja be egymásnak a felhasználó.
    this.joinCode = registerJoinCode(this.roomId);

    // KLIENS-AUTORITATÍV állapot fogadása: átvesszük a kliens által számolt autó-
    // állapotot (számokra szűrve — a szerver nem hisz el NaN-t/hiányzó mezőt).
    this.onMessage('state', (client, msg) => {
      const p = this.players.get(client.sessionId);
      if (!p || this.phase === 'lobby') return;
      // Elkésett üzenet egy KORÁBBI versenyből (lásd raceGen fenti kommentje) —
      // eldobjuk, nehogy stale `finished`/kör-adat szennyezze az új versenyt.
      if (intOr(msg?.raceGen, -1) !== this.raceGen) return;
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
      // CSAK 'racing' fázisban fogadjuk el — a kliens csak akkor jelezhetne
      // valódi célba érést, ha a verseny ténylegesen fut; 'countdown' alatt ez
      // mindig elkésett/idő előtti jelzés (lásd raceGen fenti kommentje), ami
      // NÉLKÜLE azonnal "vége a versenynek"-et okozna, amint a fázis 'racing'-ra vált.
      if (msg?.finished && !p.finished && this.phase === 'racing') {
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

    // Autó-választás — BÁRMELYIK kliens, BÁRMIKOR (csatlakozás után és két
    // verseny közt is, hogy ne kelljen kilépni/újra-csatlakozni a váltáshoz).
    // Csak a színt/modellt jelöli (colorIdx) — a KÖVETKEZŐ raceStart-nál (vagy
    // a lobby/állás-listán) érvényesül.
    this.onMessage('setCar', (client, carIdx) => {
      const p = this.players.get(client.sessionId);
      if (!p || !Number.isInteger(carIdx) || carIdx < 0 || carIdx >= 32) return;
      p.colorIdx = carIdx;
      this.broadcastLobby();
    });

    // Host-beállítások (pálya/körök/fizika) — CSAK a host, és csak akkor, ha
    // épp nem fut verseny (lobby vagy finished között) — így nem lehet egy
    // aktív futam közepén alatta cserélni a pályát. Ugyanez az üzenet teszi
    // lehetővé, hogy két verseny közt (a végeredmény-panelről is) újra
    // választhasson pályát/fizikát anélkül, hogy bárkinek ki kéne lépnie.
    this.onMessage('hostSettings', (client, msg) => {
      if (client.sessionId !== this.hostId) return;
      if (this.phase === 'countdown' || this.phase === 'racing') return;
      if (Array.isArray(msg?.layout) && msg.layout.length > 0) {
        this.layout = msg.layout;
        this.decorations = Array.isArray(msg?.decorations) ? msg.decorations : [];
        this.trackName = String(msg?.trackName || 'Egyedi pálya').slice(0, 40);
        this.trackKey = hashLayout(this.layout);
        this.trackState = createTrackState(this.layout, {
          tile: TRACK.tile,
          curbWidth: TRACK.curbWidth,
          gravelWidth: TRACK.gravelWidth,
          checkpointCount: TRACK.checkpointCount,
          start: TRACK.start,
        });
      }
      if (Number.isFinite(msg?.laps)) {
        this.laps = Math.max(1, Math.min(50, Math.round(msg.laps)));
      }
      if (msg?.physics) this.physics = resolvePhysicsPreset(msg.physics);
      // Mindenki (a hostot is beleértve) ugyanabból az üzenetből frissít — így
      // egységes a viselkedés: ha a pálya változott, a kliens (lásd main.js
      // roomSettings kezelő) elmenti aktívnak + újratölti magát (a rejoin-
      // mintával automatikusan visszalép ugyanebbe a szobába).
      this.broadcast('roomSettings', {
        trackName: this.trackName,
        layout: this.layout,
        decorations: this.decorations,
        laps: this.laps,
        physics: this.physics,
      });
      this.broadcastLobby();
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
        trackName: this.trackName,
        code: this.joinCode,
        slot: p ? p.spawn : null, // a SAJÁT rajtpozíció (x,y,angle) a helyi simhez
      });
      this.broadcastLobby();
    });

    // Szerver-óra (nincs fizika): visszaszámlálás léptetése + cél-koordináció.
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), 1000 / 20);
    // Snapshot-broadcast (a tárolt kliens-állapotokból). SZÁNDÉKOSAN sima Node
    // `setInterval`, NEM `this.clock.setInterval` — a Colyseus Clock ütemezett
    // hívásai KIZÁRÓLAG a `setSimulationInterval` saját ciklusából kapott
    // `clock.tick()`-ekkor süthetnek el (lásd @colyseus/core Room.js
    // setSimulationInterval/setPatchRate), tehát egy `clock.setInterval`
    // SOSEM futhat gyorsabban, mint a fenti 20Hz-es szimulációs ciklus — ez
    // a NET.snapshotHz=40-es beállítás ELLENÉRE is csak ~19-20Hz-es tényleges
    // broadcastot adott (mérve: ~53ms-es lépésköz 25ms helyett), ami a
    // kliens-oldali interpolációnak rendhagyó, "lökésszerű" ütemet adott —
    // ez okozta a jelentett szaggatást. A sima `setInterval` ettől a
    // csatolástól teljesen független, pontosan a kért ütemben fut.
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000 / NET.snapshotHz);
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

  // A kapcsolat megszakadása NEM feltétlenül szándékos kilépés — pl. a
  // pálya/fizika-váltás (hostSettings → roomSettings) miatt a kliens
  // MAGA tölti újra az oldalt (lásd main.js ensureTrackMatches), ami a
  // WebSocketet minden "leave" szándék nélkül, egyszerűen eldobja. Enélkül
  // a javítás nélkül ez a régi kódban azonnal törölte a helyet (`onLeave`
  // szinkron törlés) — ha a szoba emiatt átmenetileg kiürült (pl. a host
  // egyedül tesztelt, vagy mindenki kb. egyszerre reload-olt), a Colyseus
  // `autoDispose` AZONNAL megszüntette a szobát, mire bárki visszatért volna
  // (élő hibajelentés: "szétdob, vagy beakad"). A `consented` csak a
  // SZÁNDÉKOS "Kilépés"/"Vissza" gomboknál igaz (azok explicit `room.leave()`-
  // et hívnak reload előtt) — egyébként (reload, hálózat-kiesés) néhány
  // másodpercig várunk egy `reconnect()`-tel (NEM joinById-vel) érkező
  // visszatérésre, ami UGYANAZT a helyet (sessionId, host-szerep, colorIdx)
  // adja vissza, seat-vesztés nélkül.
  async onLeave(client, consented) {
    const wasHost = client.sessionId === this.hostId;
    if (consented) {
      this.removePlayer(client.sessionId, wasHost);
      return;
    }
    try {
      await this.allowReconnection(client, 20);
      // Sikeres reconnect — a players Map bejegyzése (colorIdx, spawn, stb.)
      // változatlan, csak frissítjük a lobbyt (pl. ha időközben más is változott).
      this.broadcastLobby();
    } catch {
      this.removePlayer(client.sessionId, wasHost);
    }
  }

  removePlayer(sessionId, wasHost) {
    this.players.delete(sessionId);
    if (wasHost) {
      this.hostId = this.players.keys().next().value || null;
    }
    if (this.players.size === 0) return; // a szoba magától megszűnik (autoDispose)
    this.broadcastLobby();
  }

  onDispose() {
    // A sima Node `setInterval`-t (lásd onCreate snapshotTimer) a Colyseus NEM
    // állítja le automatikusan (azt csak a saját `this.clock`-on regisztrált
    // időzítőkkel tenné) — enélkül a szoba megszűnése után is tovább futna,
    // egy már eldobott room-ra hivatkozva.
    clearInterval(this.snapshotTimer);
    unregisterJoinCode(this.joinCode);
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
    this.raceGen++;
    this.lock(); // verseny közben nem csatlakozhat új játékos
    // A klienseknek: rajt-slotok — a helyi sim ebből tudja, hova pozicionáljon.
    this.broadcast('raceStart', { slots, laps: this.laps, raceGen: this.raceGen });
    this.broadcastLobby();
  }

  // Szerver-óra: visszaszámlálás + cél-koordináció. NINCS fizika (a mozgást a
  // kliensek számolják, a szerver csak a bejelentett `finished` flageket figyeli).
  tick(dt) {
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
      code: this.joinCode,
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
      // ms — a snapshot időbélyege (interpolációhoz, lásd net/mpClient.js
      // createSnapshotBuffer). KRITIKUS: Date.now(), NEM a simTime (a tick()
      // 20Hz-es, a broadcast viszont NET.snapshotHz Hz-en fut — a két ütem nem
      // esik egybe, ezért a simTime-mal bélyegzett snapshotok EGYMÁS UTÁN
      // TÖBBSZÖR AZONOS időbélyeget kaptak, majd egy nagyot ugrottak, amikor a
      // tick végre lépett. Ez a kliens-oldali interpoláció span-ját 0-ra vagy
      // rendhagyóan nagyra tolta → látható szaggatás/akadozás a távoli
      // autóknál. A Date.now() minden broadcast-hívásnál a TÉNYLEGES, finom
      // időt adja, a firing-ütem apró szabálytalanságával együtt is — az
      // interpoláció ebből mindig helyesen számol, nincs több duplikált/
      // ugrásszerű időbélyeg.
      t: Date.now(),
      phase: this.phase,
      countdownLeft: this.countdownLeft,
      players,
    });
  }
}
