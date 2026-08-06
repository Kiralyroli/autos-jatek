// =============================================================================
//  RACE ROOM — a multiplayer verseny SZERVER-oldali szobája.
//
//  KLIENS-AUTORITATÍV MOZGÁS: a szerver NEM szimulál autót. Minden kliens a SAJÁT
//  autóját számolja ki helyben (a bevált egyjátékos-sim), és a kész állapotát
//  'state' üzenetben küldi. A szerver ezt csak ELTÁROLJA és 30 Hz-en szétküldi
//  (relay). Így a saját autót SOSEM "korrigálja" a szerver → nincs rángatás/húzás.
//
//  DE A VERSENYT A SZERVER MÉRI (2026-07-29): a körszámot, a köridőt, a kör
//  érvényességét és a célba érést a szerver SAJÁT SZÁMÍTÁSA adja — ugyanazt a
//  determinisztikus `raceStep`-et futtatja a bejelentett pozíciókra (lásd
//  raceTracker.js), a saját órájával. A kliens ilyen mezőit (lap/bestLap/finished)
//  SZÁNDÉKOSAN nem is olvassuk. Korábban a kliens egyszerűen elküldte a köridő
//  SZÁMOT és a szerver elhitte — vagyis a ranglistára bármit be lehetett írni.
//
//  Ez PONTOSAN a versenyszimulátorok (iRacing, ACC) modellje: a fizikát a kliens
//  számolja (különben a kormánymozdulat és a kép közé hálózati késés kerül, amit a
//  tapadás határán vezetve nem lehet elrejteni), a VERSENYT viszont a szerver méri.
//
//  A szerver továbbá KOORDINÁTOR: lobby, host, visszaszámlálás-óra, rajt (slot-
//  kiosztás + fázisváltás), cél-sorrend, a verseny lezárása — és a csalás-szűrés
//  (raceTracker.js: teleportálás/sebesség-hack → kirúgás indoklással).
//
//  MEGMARADÓ kompromisszum: a POZÍCIÓ továbbra is a kliens állítása, ezért egy
//  hitelesen (a fizikai korlátokon belül) hamisított pálya elvben átjut — ez ellen
//  csak a teljes szerver-fizika védene, amit viszont az iRacing sem használ. Kemény
//  ütközésnél a két képernyő is kissé eltérhet (a puha szétnyomás tompítja). A
//  "szerver az igazság" MOZGÁS-modellt (predikció+reconcile) tudatosan cseréltük
//  erre, mert az a valós hálózaton látható korrekció-húzást okozott.
// =============================================================================
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Room } = require('colyseus'); // a colyseus CJS — createRequire-rel töltjük ESM-ből

import { TRACK, RACE, NET, DEFAULT_LAYOUT, resolvePhysicsPreset } from '../src/config.js';
import { createTrackState, spawnSlot } from '../src/sim/trackFactory.js';
import { hashLayout } from '../src/sim/trackKey.js';
import { recordLap, MAX_GHOST_SAMPLES } from './leaderboardStore.js';
import { sanitizeLayout, sanitizePitLane } from './trackStore.js';
import { registerJoinCode, unregisterJoinCode } from './roomCodes.js';
import { createTrackerContext, createPlayerTracker } from './raceTracker.js';

const num = (v) => (Number.isFinite(v) ? v : 0);
const intOr = (v, d) => (Number.isInteger(v) ? v : d);

// Játékos-/pályanév megtisztítása. A `<` és `>` eltávolítása MÁSODIK védvonal a
// tárolt XSS ellen: a nevet a kliens a HUD-ba/állás-listába írja, ahol az elsődleges
// védelem a kimenet escape-elése (src/main.js escapeHtml) — de ami sosem kerül be a
// tárba, azt elrontani sem lehet, ha valahol később kimarad egy escape.
function cleanName(v, fallback, maxLen) {
  const s = String(v ?? '').replace(/[<>]/g, '').trim().slice(0, maxLen);
  return s || fallback;
}

// A kliens által küldött dekoráció-lista mérethatára (a trackStore MAX_DECOR-jával
// összhangban) — a szoba ezt csak továbbítja a többi kliensnek, de a méretét
// korlátozni kell, hogy egy felfújt lista ne terhelje a broadcastot.
const MAX_ROOM_DECOR = 5000;
const safeDecor = (d) => (Array.isArray(d) ? d.slice(0, MAX_ROOM_DECOR) : []);

// Egy kliens bejelentett autó-állapota (a spawn-pozícióra inicializálva). Minden
// mező a rendereléshez / állás-listához / HUD-hoz kell a TÖBBI kliensnél.
function emptyState(slot) {
  return {
    x: slot.x, y: slot.y, angle: slot.angle,
    vx: 0, vy: 0, w: 0,
    speed: 0, cornering: 0,
    lap: 1, progress: 0, curLap: 0, lastLap: null, bestLap: null,
    lapValid: true, wrongWay: false, finished: false, totalTime: null,
    // A kliens bejelentett VEZÉRLÉSE (bitmaszk, lásd src/input.js encodeInput).
    // A szerver csak továbbítja — ebből a TÖBBI kliens a valódi fizikán
    // szimulálja tovább ezt az autót (lásd src/net/remoteCars.js), így a távoli
    // autók igazi ívet írnak le és jelen-időben látszanak.
    inp: 0,
  };
}

export class RaceRoom extends Room {
  onCreate(options) {
    this.maxClients = NET.maxPlayers;

    // A pályát a szobát LÉTREHOZÓ kliens adja (a saját aktív pályája). A layoutból
    // a szerver GEOMETRIÁT ÉPÍT (createTrackState lentebb), ezért ugyanazon a
    // szűrőn kell átmennie, mint a REST-en mentett pályáknak — enélkül egy
    // kézzel összerakott `create` üzenet (több ezer kontrollpont, csillagászati
    // koordinátákkal) megfoghatná a teljes szerverfolyamatot. Érvénytelen adatra
    // csendben az alappályára esünk vissza.
    const layout = sanitizeLayout(options?.layout) || DEFAULT_LAYOUT;
    this.layout = layout;
    this.decorations = safeDecor(options?.decorations);
    // Boxutca-útvonal — UGYANAZON a szűrőn (sanitizePitLane) megy át, mint a
    // REST-en mentett pályáknál, ugyanazért az okért, mint a layout: a szerver
    // minden fizika-lépésben végigfut rajta (raceTracker.js), validálatlanul
    // ez is a szerverfolyamatot foghatná meg.
    this.pitLane = sanitizePitLane(options?.pitLane);
    // A szoba körszáma — a létrehozó (host) választja; korlátozva 1..50-re.
    this.laps = Number.isFinite(options?.laps)
      ? Math.max(1, Math.min(50, Math.round(options.laps)))
      : RACE.laps;
    // A szoba autó-fizikája (a kliens ezt alkalmazza a helyi simjében).
    this.physics = resolvePhysicsPreset(options?.physics);
    // Kötelező kerékcsere (boxkiállás) — a host kapcsolja be/ki (lásd hostSettings
    // lentebb). Csak akkor "él", ha a pályán VAN is boxutca-útvonal — ezt a
    // rebuildTrackerContext/createTrackerContext dönti el (lásd raceTracker.js).
    this.pitStopRequired = !!options?.pitStopRequired;

    // Örök ranglista: a trackKey a layout GEOMETRIÁJÁHOZ kötött, névtől független.
    this.trackKey = hashLayout(layout);
    this.trackName = cleanName(options?.trackName, 'Egyedi pálya', 40);

    // A pálya-geometria kell a spawn-slotokhoz ÉS a szerver-oldali verseny-méréshez
    // (checkpointok, fű-határ, pálya-irány) — ez NEM fizikai sim.
    this.trackState = createTrackState(layout, {
      tile: TRACK.tile,
      curbWidth: TRACK.curbWidth,
      gravelWidth: TRACK.gravelWidth,
      checkpointCount: TRACK.checkpointCount,
      start: TRACK.start,
    });
    this.rebuildTrackerContext();

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

    // A MOZGÁS kliens-autoritatív (a szerver nem szimulál autót), a VERSENY viszont
    // szerver-mért: a pozíciót/sebességet átvesszük a rendereléshez, de a körszámot,
    // a köridőt, a kör érvényességét és a célba érést a szerver MAGA számolja ki
    // ugyanezekből a pozíciókból (lásd raceTracker.js). A kliens ilyen mezőit
    // (lap/curLap/lastLap/bestLap/finished/totalTime) SZÁNDÉKOSAN nem is olvassuk.
    this.onMessage('state', (client, msg) => {
      const p = this.players.get(client.sessionId);
      if (!p || this.phase === 'lobby') return;
      // Elkésett üzenet egy KORÁBBI versenyből (lásd raceGen fenti kommentje) —
      // eldobjuk, nehogy stale kör-adat szennyezze az új versenyt.
      if (intOr(msg?.raceGen, -1) !== this.raceGen) return;
      const s = p.state;
      s.x = num(msg?.x); s.y = num(msg?.y); s.angle = num(msg?.angle);
      s.vx = num(msg?.vx); s.vy = num(msg?.vy); s.w = num(msg?.w);
      s.speed = num(msg?.speed); s.cornering = num(msg?.cornering);
      s.inp = intOr(msg?.inp, 0);

      // --- A SZERVER SAJÁT MÉRÉSE a most kapott pozícióból ---
      const measured = p.tracker
        ? p.tracker.update(s.x, s.y, s.angle, Date.now())
        : { events: [], cheat: null };
      const events = measured.events;
      if (measured.cheat) {
        this.kickForCheating(client, p, measured.cheat.reason);
        return;
      }
      const r = p.tracker?.race;
      if (r) {
        s.lap = r.lap;
        s.curLap = r.time - r.lapStartTime;
        s.lastLap = r.lastLapTime;
        s.bestLap = r.bestLapTime;
        s.lapValid = r.lapValid;
        s.wrongWay = r.wrongWay;
        // A pálya-menti haladás is szerver-oldalon számolt (az élő állás sorrendje
        // és az időrés-becslés ebből épül) — így az sem hamisítható.
        s.progress = this.trackState.trackProgress(s.x, s.y);
      }

      // CÉL: a szerver SAJÁT mérése dönt (nem a kliens bejelentése). A helyezést a
      // célba érés sorrendjében osztjuk. Az `events` a raceStep-től jön, tehát csak
      // akkor van 'finish', ha a szerver szerint minden checkpoint és kör megvolt.
      if (!p.finished && this.phase === 'racing' && events.some((e) => e.type === 'finish')) {
        p.finished = true;
        s.finished = true;
        s.totalTime = r.time;
        p.place = ++this.finishedCount;
      }

      // Örök ranglista: a SZERVER által mért legjobb körből (csak ha ÚJ/JOBB — a
      // tároló amúgy is szűr, ez a felesleges hívásokat spórolja). Korábban itt a
      // kliens által BEJELENTETT szám szerepelt, vagyis a ranglistára bármit be
      // lehetett írni; most a szerver mérése az egyetlen forrás.
      if (
        r &&
        r.bestLapTime !== null &&
        (p.lastSubmittedBest === null || r.bestLapTime < p.lastSubmittedBest - 1e-6)
      ) {
        p.lastSubmittedBest = r.bestLapTime;
        recordLap(
          {
            trackKey: this.trackKey,
            trackName: this.trackName,
            physics: this.physics,
            playerName: p.name,
            lapTime: r.bestLapTime,
            // A legutóbb beküldött ghost-mintasor (lásd 'lapGhost' üzenet lejjebb)
            // — a leaderboardStore.recordLap MAGA validálja (sanitizeGhost), itt
            // nem kell megbízni benne; ha hibás/hiányzik, a köridő ghost nélkül
            // mentődik, ugyanúgy, mint az egyjátékos REST-beküldésnél.
            ghost: p.pendingGhost,
          },
          Date.now()
        );
      }
    });

    // A kliens EGY teljes kör (x,y,angle) mintasorát küldi, amikor a SAJÁT helyi
    // mérése szerint most fejezett be egy kört — ez NEM a szerver hivatalos
    // mérése (az fentebb, a 'state' kezelőben történik, p.tracker-rel), csak egy
    // "ha ez lenne az új legjobb kör, ez a hozzá tartozó felvétel" jelzés. A
    // szerver csak akkor őrzi meg TARTÓSAN (a ranglistán), ha a SAJÁT mérése
    // szerint EZUTÁN tényleg új legjobb kör született (lásd fent). Méret-korlát
    // MÁR ITT, mielőtt egyáltalán memóriában tartanánk — ugyanaz az elv, mint a
    // pálya-layoutnál (lásd CLAUDE.md "Biztonság").
    this.onMessage('lapGhost', (client, msg) => {
      const p = this.players.get(client.sessionId);
      if (!p) return;
      const samples = msg?.samples;
      if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_GHOST_SAMPLES) return;
      p.pendingGhost = samples;
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
      // Ugyanaz a layout-szűrő, mint az onCreate-nél (lásd ott a magyarázatot) —
      // a host is "csak egy kliens", az üzenete ugyanúgy hamisítható.
      const nextLayout = sanitizeLayout(msg?.layout);
      if (nextLayout) {
        this.layout = nextLayout;
        this.decorations = safeDecor(msg?.decorations);
        this.pitLane = sanitizePitLane(msg?.pitLane);
        this.trackName = cleanName(msg?.trackName, 'Egyedi pálya', 40);
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
      if (typeof msg?.pitStopRequired === 'boolean') this.pitStopRequired = msg.pitStopRequired;
      // A verseny-mérés kontextusa a pályából/körszámból/fizikából épül — bármelyik
      // változott, újra kell építeni (különben a következő futam a RÉGI pálya
      // checkpointjaival és a régi csúcssebesség-korláttal mérne).
      this.rebuildTrackerContext();
      // Mindenki (a hostot is beleértve) ugyanabból az üzenetből frissít — így
      // egységes a viselkedés: ha a pálya változott, a kliens (lásd main.js
      // roomSettings kezelő) elmenti aktívnak + újratölti magát (a rejoin-
      // mintával automatikusan visszalép ugyanebbe a szobába).
      this.broadcast('roomSettings', {
        trackName: this.trackName,
        layout: this.layout,
        decorations: this.decorations,
        pitLane: this.pitLane,
        laps: this.laps,
        physics: this.physics,
        pitStopRequired: this.pitStopRequired,
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
        pitLane: this.pitLane,
        laps: this.laps,
        physics: this.physics,
        trackName: this.trackName,
        code: this.joinCode,
        pitStopRequired: this.pitStopRequired,
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
      name: cleanName(options?.name, 'Játékos', 20),
      colorIdx,
      slotIndex,
      spawn: { x: slot.x, y: slot.y, angle: slot.angle }, // a kliens ide pozicionál
      state: emptyState(slot),
      finished: false,
      place: null,
      lastSubmittedBest: null,
      // A kliens LEGUTÓBB beküldött, teljes körhöz tartozó ghost-mintasora
      // (lásd 'lapGhost' üzenet-kezelő) — a szerver akkor csatolja a
      // ranglistára, ha EZUTÁN a saját mérése szerint ez lett az új legjobb kör.
      pendingGhost: null,
      // Szerver-oldali verseny-követő (lásd raceTracker.js). A startRace() minden
      // futam elején újat készít; ez itt csak azért kell, hogy egy lobbyban
      // beérkező 'state' üzenet se találjon üres helyet.
      tracker: createPlayerTracker(this.trackerCtx, slot, slotIndex),
    });

    this.broadcastLobby();
  }

  // Csalás miatti eltávolítás. A játékos ELŐBB kap egy magyarázó üzenetet, és csak
  // utána zárjuk a kapcsolatot — különben a kliens csak egy néma szétkapcsolást
  // látna, és hibának hinné.
  //
  // A `kicked` flag KRITIKUS: az onLeave alapesetben 60 másodpercig VÁR egy
  // `reconnect()`-re (a reload/hálózat-kiesés kezelése miatt) — enélkül a kirúgott
  // játékos egyszerűen visszatérhetne a saját helyére, host-szereppel együtt.
  kickForCheating(client, p, reason) {
    if (p.kicked) return; // már kirúgva — ne küldjük ki többször
    p.kicked = true;
    console.warn(`[anticheat] kirúgva: ${p.name} (${client.sessionId}) — ${reason}`);
    try {
      client.send('kicked', { reason });
    } catch {
      /* a kapcsolat már bomlott — a leave() alább akkor is lezárja */
    }
    // Rövid késleltetés, hogy az üzenet ténylegesen kimenjen a socketre a zárás előtt.
    setTimeout(() => {
      try {
        client.leave(4000); // saját záró-kód: "kirúgva"
      } catch {
        /* már lecsatlakozott */
      }
    }, 120);
  }

  // A verseny-mérés szobaszintű kontextusa (checkpointok, fű-határ, terelőkúpok,
  // csúcssebesség-korlát). A pálya/körszám/fizika bármelyik változásakor újra kell
  // építeni — lásd onCreate és a 'hostSettings' kezelő.
  rebuildTrackerContext() {
    this.trackerCtx = createTrackerContext({
      trackState: this.trackState,
      decorations: this.decorations,
      pitLane: this.pitLane,
      physics: this.physics,
      laps: this.laps,
      pitStopRequired: this.pitStopRequired,
    });
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
    const p = this.players.get(client.sessionId);
    // CSALÁS MIATT KIRÚGVA: azonnali, VÉGLEGES eltávolítás — semmilyen
    // visszacsatlakozási türelmi idő (lásd kickForCheating), különben a kirúgott
    // játékos a `reconnect()`-tel visszatérne a saját helyére.
    if (p?.kicked) {
      this.removePlayer(client.sessionId, wasHost);
      return;
    }
    if (consented) {
      this.removePlayer(client.sessionId, wasHost);
      return;
    }
    try {
      // 20 → 60 mp: localhoston egy pálya/fizika-váltás miatti reload+rejoin
      // ~1-3 mp (élő hibajelentés szerint ott sosem dob ki), de ÉLESBEN (valós
      // hálózat, teljes oldal-újratöltés — a JS-bundle + GLB/textúra assetek
      // letöltése, a Three.js jelenet újraépítése, majd a WS-kézfogás) ez
      // ÉRDEMBEN tovább tarthat, és a 20 mp-es ablak élesben követhetően
      // el is fogyott (a szoba emiatt üresen maradt, autoDispose törölte,
      // mielőtt bárki visszatérhetett volna). 60 mp bőven elég tartalék,
      // mégsem tartja élve feleslegesen sokáig az üres szobát, ha valaki
      // TÉNYLEG kilépett hálózat-kieséssel (nem szándékos "Kilépés" gombbal).
      await this.allowReconnection(client, 60);
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
    // Slotok újraosztása — VÉLETLENSZERŰ sorrendben (ne mindig a csatlakozás
    // sorrendje döntsön, különben a host/első csatlakozó mindig ugyanazt a
    // rajthelyet kapná minden futamnál). Fisher–Yates keverés a Map
    // bejegyzésein, majd a megkevert sorrendben osztjuk ki a slotIndex-eket.
    let i = 0;
    const slots = {};
    const entries = [...this.players.entries()];
    for (let k = entries.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [entries[k], entries[j]] = [entries[j], entries[k]];
    }
    for (const [id, p] of entries) {
      p.slotIndex = i++;
      const slot = spawnSlot(this.trackState, p.slotIndex);
      p.spawn = { x: slot.x, y: slot.y, angle: slot.angle };
      p.state = emptyState(slot);
      p.finished = false;
      p.place = null;
      p.lastSubmittedBest = null;
      p.pendingGhost = null; // előző futamból itt ragadt ghost sose keveredjen az újba
      // FRISS verseny-követő minden futamhoz (új kör-számláló, nullázott idő, a
      // pozíció-előzmény a rajtrácsról indul).
      p.tracker = createPlayerTracker(this.trackerCtx, slot, p.slotIndex);
      // A slotIndex is átmegy — a kliens ebből tudja, melyik boxhely a SAJÁTJA
      // (lásd sim/race.js pitBoxForSlot, main.js raceStart-kezelő).
      slots[id] = { ...p.spawn, slotIndex: p.slotIndex };
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

  // Szerver-óra: visszaszámlálás + cél-koordináció. NINCS autófizika (a mozgást a
  // kliensek számolják) — a VERSENY-MÉRÉS viszont szerver-oldali (raceTracker.js),
  // a célba érést is a szerver saját mérése állapítja meg.
  tick(dt) {
    if (this.phase === 'countdown') {
      this.countdownLeft -= dt;
      if (this.countdownLeft <= 0) {
        this.countdownLeft = 0;
        this.phase = 'racing';
        // Rajt: innentől mér a szerver. A követők órája MOST indul, hogy a
        // visszaszámlálás alatt beérkezett pozíciók ne számítsanak bele az időbe.
        const now = Date.now();
        for (const p of this.players.values()) p.tracker?.begin(now);
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
        inp: s.inp,
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
