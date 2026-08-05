// =============================================================================
//  SZERVER-OLDALI VERSENY-MÉRÉS — a köridőt a SZERVER méri, nem a kliens jelenti.
//
//  MIÉRT: a mozgás kliens-autoritatív marad (a szerver NEM szimulál autót — lásd
//  RaceRoom.js fejléc), mert a fizika szerverre tolása input-késleltetést okoz, amit
//  a tapadás határán vezetve nem lehet elrejteni. UGYANEZT teszik a versenyszimulátorok
//  (iRacing, ACC): a fizikát a kliens számolja — DE a KÖRIDŐT ÉS A SZEKTOROKAT a
//  szerver méri a bejelentett pozíciókból. Ez a modul a hiányzó második fél.
//
//  Korábban a kliens egyszerűen elküldte a `bestLap` SZÁMOT, és a szerver elhitte —
//  vagyis a ranglistára bármit be lehetett írni. Most a szerver ugyanazt a
//  determinisztikus `raceStep`-et futtatja (src/sim/race.js — ugyanaz a kód, mint a
//  kliensen) a bejelentett pozíciókra, és a SAJÁT mérését használja mindenhez:
//  körszám, kör-érvényesség, köridő, célba érés sorrendje, ranglista.
//
//  Amit ez kiszűr: hamis köridő, kihagyott checkpoint, rossz irányból "teljesített"
//  kör, teleportálás/gyorsítás (sebesség-józansági ellenőrzés).
//  Amit NEM: egy tökéletesen, de HITELESEN vezető bot. Az ellen semmilyen
//  architektúra nem véd (az iRacing sem — ott emberi vizsgálat és valódi identitás
//  a védelem, ami baráti játéknál értelmezhetetlen).
//
//  IDŐMÉRÉS: a szerver SAJÁT órájából (a beérkezés idejéből), sosem a kliens által
//  bejelentett időből — utóbbi hamisítható lenne. A pontosság korlátja a mintavételi
//  sűrűség (NET.sendHz = 60 Hz → ~16 ms) plusz a hálózati jitter; egy ~24 s-os körön
//  ez néhány század másodperc. Cserébe az idő NEM hamisítható.
// =============================================================================
import { CAR, RACE, TRACK, PHYSICS_PRESETS } from '../src/config.js';
import { createRaceState, raceStep, updatePitStop, withPitLaneOffRoad, widenCheckpointsForPitLane, pitLaneReady, pitBoxForSlot } from '../src/sim/race.js';
import { minLapFromLength } from './lapValidation.js';

// Az időlépést SZÁNDÉKOSAN NEM vágjuk felső korláttal (ellentétben a kliens
// frame-ciklusával, ahol a Math.min(dt, 0.1) a FIZIKÁT védi a szétesés ellen).
// Itt nincs fizika, csak IDŐMÉRÉS — és a vágás MÉRÉSI HIBÁT okozott: méréssel
// kiderült, hogy löketesen érkező csomagoknál (12 üzenet egyszerre, 200 ms
// mozgással) a vágás miatt egy 15,3 s-os kört 7,7 s-nak mért a szerver. Ez nem
// csak pontatlan, hanem KIHASZNÁLHATÓ is lett volna: a szándékosan akadozó
// kapcsolat rövidebb köridőt adott volna. A valós eltelt idővel a race.time
// összege mindig pontosan a faliórát követi.
// Nulla-osztás elleni alsó korlát (a raceStep a dt-vel sebességet is számol).
const MIN_DT = 1e-6;

// --- CSALÁS-FELISMERÉS PARAMÉTEREI ---
//
// A LEGFONTOSABB TERVEZÉSI SZEMPONT ITT A HAMIS RIASZTÁS ELKERÜLÉSE: egy tisztességes,
// de rossz hálózatú játékost kirúgni sokkal rosszabb, mint egy csalót nem elkapni.
// Ezért két külön szint van, és a "puha" jelzés magában SOSEM rúg ki.
//
// Miért nem elég az üzenetenkénti sebesség-ellenőrzés: a WebSocket-csomagok
// LÖKETEKBEN érkeznek (ezt ebben a projektben már mérve is láttuk — lásd
// RaceRoom.js broadcastSnapshot Date.now()-megjegyzése: sim-időben 50 ms-ra lévő
// üzenetek 2 ms különbséggel jöttek meg). Ilyenkor a beérkezési időből számolt
// "sebesség" a valóság többszöröse lehet CSALÁS NÉLKÜL is. Ezért a fő ellenőrzés
// egy CSÚSZÓ ABLAKON vett ÁTLAG-sebesség, ami a löketességet kiátlagolja.
const SPEED_WINDOW = 1.0; // s — ekkora ablakon átlagolunk
// A ráhagyás MÉRT adatból származik, nem tippelt. A valódi fizikát végigfuttatva a
// legnagyobb elérhető 1 másodperces átlag-sebesség a maxForwardSpeed 1,001–1,005×-e:
//   - teljes gáz egyenesben:            1,001×
//   - teljes gáz + tartós drift-kanyar: 1,001×  (a drift LASSÍT: az oldalsó súrlódás
//                                        lekoptatja a sebességet — csúcs 14 m/s)
//   - két autó tartósan egymásba lógva (carSeparation lépésenként 0,3 m-t is tolhat,
//     ami elvben 18 m/s-nyi útvonal-hizlalást adna): szintén 1,001×, mert az átfedés
//     pár lépés alatt feloldódik, nem tart ki.
// Ehhez képest 1,15 kényelmes tartalék a hálózati mérési zajra. KORÁBBAN 1,5 volt —
// az RÉS volt: egy tartósan 85 m/s-mal (1,4×) haladó csaló így ALATTA maradt a
// küszöbnek, és a köridő-alsókorlátot is átlépte volna (306 m / 85 m/s = 3,6 s > 3,57 s).
const AVG_SPEED_MARGIN = 1.15;
// KÖR-SZINTŰ tartós sebesség: a TÉNYLEGESEN megtett útvonal hossza osztva a szerver
// által mért köridővel. Ez a legmegbízhatóbb "tartósan gyorsabb, mint a fizika"
// jelzés, mert (a) egy teljes körön a zaj kiátlagolódik, és (b) a valódi útvonalat
// méri, tehát a kanyarvágás NEM zavarja meg (szemben a köridő-alsókorláttal, aminek
// pont ezért kell 30%-os kanyarvágási ráhagyást adni).
// Ez a SZIGORÚBB küszöb (1,08 az 1 másodperces ablak 1,15-éhez képest), és pontosan
// azért lehet szigorúbb, mert egy teljes körön több száz mintából átlagolunk — a
// hálózati zaj itt gyakorlatilag eltűnik. Ráadásul a húrokból összegzett útvonal
// ALULBECSÜLI a valódi ívet, tehát a mérés eleve a játékos javára téved.
// Ez fogja meg a "finom" csalót (tartós 1,1×), amit az ablakos szűrő átengedne.
const LAP_SPEED_MARGIN = 1.08;
// Durva, EGYETLEN ugrásra szóló korlát (a fenti ablak mellett, gyors reagáláshoz).
// A tényleges eltelt időből számol, ezért egy 2 másodperces hálózati kimaradás utáni
// nagy, de JOGOS elmozdulást nem büntet. Az alsó időkorlát a löketesség ellen van.
const JUMP_MIN_DT = 0.1;
const JUMP_MARGIN = 3;
// DURVA ugrás: ekkora ráhagyás felett már semmilyen hálózati magyarázat nem áll meg
// (a valós eltelt időből számolunk, tehát egy hosszú lag utáni nagy elmozdulás NEM
// esik ide). 60 m/s-os autónál ez ~60 m egyetlen, 16 ms-os frissítés alatt.
const HARD_JUMP_MARGIN = 10;
// Ennyi PUHA jelzés után tekintjük bizonyítottnak a szándékosságot. Löketesség
// egy-két jelzést adhat; nyolc, egy futamon belül, már nem magyarázható hálózattal.
const SOFT_STRIKES_TO_KICK = 8;
// Az ÁTLAGSEBESSÉG-túllépés súlyosabb jelzés, mint egy egyszeri ugrás: egy teljes
// másodpercen át tartó, korlát feletti átlag nem jöhet létre hálózati zajból (az
// autó sebessége amúgy is clamp-elt). Ezért egy ilyen jelzés több strike-ot ér —
// így egy folyamatos sebesség-csaló pár másodperc alatt kiesik, nem 8 alatt.
const WINDOW_STRIKE_WEIGHT = 3;
// Ennél nagyobb koordináta nem lehet valós (a pálya-validálás ±10 km-re korlátozza a
// geometriát, lásd trackStore.js MAX_COORD) — ez már biztosan manipulált kliens.
const MAX_ABS_COORD = 100000;

// A teljes autó a pályán KÍVÜL van-e — a sim/car.js isFullyOffRoad POZÍCIÓ-ALAPÚ
// megfelelője (a szerver nem tart fizikai testet, ezért a body-alapú változat nem
// használható; a geometria és a döntés viszont BETŰ SZERINT ugyanez, hogy a szerver
// és a kliens ne ítélje meg máshogy a kör érvényességét).
function fullyOffRoad(x, y, angle, offRoad) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hl = CAR.length / 2;
  const hw = CAR.width / 2;
  for (const [lx, ly] of [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]]) {
    const wx = x + lx * cos - ly * sin;
    const wy = y + lx * sin + ly * cos;
    if (offRoad(wx, wy) <= 0) return false; // ez a sarok még a burkolaton van
  }
  return true;
}

// Terelőkúp-ütközés — a sim/car.js hitsCone pozíció-alapú megfelelője (lásd fent).
function hitsCone(x, y, angle, cones, hitRadius) {
  if (cones.length === 0) return false;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hl = CAR.length / 2 + hitRadius;
  const hw = CAR.width / 2 + hitRadius;
  for (const pt of cones) {
    const dx = pt.x - x;
    const dy = pt.y - y;
    const lx = dx * cos + dy * sin; // világ → autó helyi kerete (inverz forgatás)
    const ly = -dx * sin + dy * cos;
    if (Math.abs(lx) <= hl && Math.abs(ly) <= hw) return true;
  }
  return false;
}

// Szobaszintű kontextus (egyszer épül fel pályánként/versenyenként).
export function createTrackerContext({ trackState, decorations, pitLane, physics, laps, pitStopRequired }) {
  const baseMaxSpeed = PHYSICS_PRESETS[physics]?.maxForwardSpeed || CAR.maxForwardSpeed;
  // A BOOST (src/sim/car.js applyDrive) ideiglenesen megemeli a csúcssebesség-
  // határt — a csalás-szűrőnek ezt a MEGEMELT, szabályosan elérhető sebességet
  // kell felső korlátnak tekintenie, különben egy legitim boostoló játékost
  // "tartósan a fizikai korlát felett" jelzéssel kirúgna (lásd update() lent).
  const maxSpeed = baseMaxSpeed * (CAR.boostMaxSpeedMultiplier || 1);
  const pitLanePoints = Array.isArray(pitLane) ? pitLane : [];
  return {
    trackState,
    // Boxutca-útvonal: burkolatnak számít, büntetlenül behajtható (lásd
    // sim/race.js withPitLaneOffRoad) — ezt kell használni az offRoad-ellenőrzésnél
    // a NYERS trackState.offRoadExcess helyett (lásd update() lent).
    offRoadExcess: withPitLaneOffRoad(trackState.offRoadExcess, pitLanePoints),
    // A boxutcával érintkező checkpointokat (jellemzően a célvonal)
    // kiszélesíti (lásd sim/race.js widenCheckpointsForPitLane) — ezt kell
    // használni a NYERS trackState.checkpoints helyett (lásd update() lent),
    // különben a boxutcán áthaladva a fix szélességű célvonal-checkpoint nem
    // biztos, hogy átszelhető marad.
    checkpoints: widenCheckpointsForPitLane(trackState.checkpoints, pitLanePoints),
    laps,
    // A leggyorsabb elérhető csúcssebesség ehhez a szobához (BOOST-tal együtt) —
    // a sebesség-ellenőrzés felső korlátja. A szoba fizikája adja; ismeretlennél
    // a globális CAR értéke.
    maxSpeed,
    // A fizikailag leggyorsabb lehetséges kör EZEN a pályán. Ha a SZERVER SAJÁT
    // mérése ennél rövidebb kört ad, az csak hamisított pozíciókból jöhet — ez a
    // legerősebb, gyakorlatilag hamis-riasztás-mentes csalás-jelzés.
    minLapTime: minLapFromLength(trackState.trackLength, maxSpeed),
    // Terelőkúpok VILÁG-koordinátái — ugyanaz a dgx/dgy * TRACK.tile képlet, mint a
    // kliensen (main.js conePoints) és a render-rétegben.
    cones: (Array.isArray(decorations) ? decorations : [])
      .filter((d) => d && d.type === 'pylon')
      .map((d) => ({ x: (Number(d.dgx) || 0) * TRACK.tile, y: (Number(d.dgy) || 0) * TRACK.tile })),
    // Boxutca-útvonal (kötelező kerékcsere) — csak akkor "igazán" kötelező, ha
    // a pályán VAN is legalább 2 pontos útvonal, különben a cél sosem zárulna
    // le (lásd createPlayerTracker, ami ezt a két mezőt AND-olja
    // createRaceState-hez).
    pitLane: pitLanePoints,
    pitStopRequired: !!pitStopRequired,
  };
}

// Egy JÁTÉKOS verseny-követője. A `spawn` a rajtpozíció (innen indul a pozíció-előzmény).
// `slotIndex`: a rajtrács-pozíció (lásd RaceRoom.js p.slotIndex) — ebből dől
// el, MELYIK boxhely ennek a JÁTÉKOSNAK a sajátja (lásd sim/race.js
// pitBoxForSlot), ha több van kijelölve. Multiplayerben így senkinek sem kell
// osztoznia egy boxon.
export function createPlayerTracker(ctx, spawn, slotIndex) {
  const race = createRaceState(ctx.laps, ctx.pitStopRequired && pitLaneReady(ctx.pitLane));
  const myPitBox = pitBoxForSlot(ctx.pitLane, slotIndex || 0);
  const prev = { x: spawn.x, y: spawn.y };
  const curr = { x: spawn.x, y: spawn.y };
  let lastAt = null; // ms — az előző beszámított frissítés beérkezési ideje
  let strikes = 0; // puha jelzések száma (lásd SOFT_STRIKES_TO_KICK)
  // Csúszó ablak az ÁTLAGSEBESSÉG-ellenőrzéshez (a csomag-löketesség kiátlagolására).
  let winDist = 0;
  let winTime = 0;
  // Az AKTUÁLIS körben ténylegesen megtett útvonal hossza (m) — a kör-szintű
  // tartós-sebesség ellenőrzéshez, lásd LAP_SPEED_MARGIN.
  let lapDist = 0;

  // A verseny tényleges indítása (a szoba 'racing' fázisba lépésekor). A szerver
  // maga NEM visszaszámol — azt a szoba órája végzi —, ezért egyenesen 'racing'-re
  // állunk, hogy a raceStep a countdown-ágat átlépje és az időt mérni kezdje.
  function begin(nowMs) {
    race.phase = 'racing';
    race.countdownLeft = 0;
    race.time = 0;
    race.lapStartTime = 0;
    lastAt = nowMs;
  }

  // Egy bejelentett pozíció beszámítása.
  // Visszatérés: { events, cheat } — az `events` a raceStep eseménylistája (kör kész,
  // célba ért), a `cheat` pedig `null`, vagy `{ hard, reason }`, ha csalást állapítottunk
  // meg. `hard: true` → azonnali kirúgás; a puha jelzések csak a kört érvénytelenítik,
  // és csak ismétlődés után válnak kirúgássá (lásd SOFT_STRIKES_TO_KICK).
  function update(x, y, angle, nowMs) {
    if (race.phase !== 'racing' || lastAt === null) return { events: [], cheat: null };

    // Nyilvánvalóan manipulált koordináta — ez sosem lehet valós vezetés eredménye.
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_ABS_COORD || Math.abs(y) > MAX_ABS_COORD) {
      return { events: [], cheat: { hard: true, reason: 'Érvénytelen pozíció-adat.' } };
    }

    // A TÉNYLEGES eltelt idő — nem vágjuk (lásd MIN_DT megjegyzése). A pozíciót
    // akkor is FEL KELL dolgozni, ha két üzenet ugyanabban a ms-ban érkezett:
    // egyébként kimaradna a mozgás-szakasz, és egy checkpoint-átszelés észrevétlen
    // maradhatna (a raceStep a prev→curr szakaszok metszéséből dolgozik).
    const elapsed = Math.max((nowMs - lastAt) / 1000, MIN_DT);
    lastAt = nowMs;

    const moved = Math.hypot(x - curr.x, y - curr.y);
    let cheat = null;
    // A megtehető távolság korlátja. A VALÓS eltelt időből számol, ezért egy hosszú
    // hálózati kimaradás utáni nagy — de jogos — elmozdulást nem büntet; az alsó
    // időkorlát a csomag-löketesség ellen van.
    const jumpBudget = ctx.maxSpeed * Math.max(elapsed, JUMP_MIN_DT);

    // (1a) DURVA, MAGYARÁZHATATLAN UGRÁS → azonnali kirúgás.
    if (moved > jumpBudget * HARD_JUMP_MARGIN) {
      cheat = {
        hard: true,
        reason: `Teleportálás: ${moved.toFixed(0)} m ${(elapsed * 1000).toFixed(0)} ms alatt.`,
      };
    } else if (moved > jumpBudget * JUMP_MARGIN) {
      // (1b) Gyanús, de még belemagyarázható ugrás → a kör nem érvényes, strike.
      strikes++;
      race.lapValid = false;
    }

    // (2) ÁTLAGSEBESSÉG csúszó ablakon — ez fogja meg a "folyamatosan gyorsabb"
    // csalást, amit az egyszeri ugrás-ellenőrzés átengedne, és nem érzékeny a
    // csomagok löketességére (lásd SPEED_WINDOW megjegyzése).
    winDist += moved;
    winTime += elapsed;
    lapDist += moved;
    if (winTime >= SPEED_WINDOW) {
      if (winDist / winTime > ctx.maxSpeed * AVG_SPEED_MARGIN) {
        strikes += WINDOW_STRIKE_WEIGHT;
        race.lapValid = false;
      }
      winDist = 0;
      winTime = 0;
    }

    prev.x = curr.x;
    prev.y = curr.y;
    curr.x = x;
    curr.y = y;

    const offTrack =
      fullyOffRoad(x, y, angle, ctx.offRoadExcess) ||
      hitsCone(x, y, angle, ctx.cones, RACE.coneHitRadius);

    // Kötelező kerékcsere haladása — a raceStep MELLETT, ugyanabból a bejelentett
    // pozícióból (lásd sim/race.js updatePitStop). A `moved/elapsed` itt a
    // ténylegesen megtett út / ténylegesen eltelt idő, tehát ugyanaz a "sebesség",
    // amit a csalás-szűrő is használ — nem kell külön sebesség-mezőt bíznunk a kliensre.
    updatePitStop(race, x, y, moved / elapsed, myPitBox, elapsed);

    const events = raceStep(
      race,
      prev,
      curr,
      elapsed,
      ctx.checkpoints,
      offTrack,
      ctx.trackState.trackHeadingAt
    );
    if (cheat) return { events, cheat }; // durva ugrás — a mérést már nem folytatjuk

    // (3) KÖR LEZÁRÁSAKOR: két, egymást kiegészítő ellenőrzés.
    for (const e of events) {
      if ((e.type !== 'lap' && e.type !== 'finish') || !Number.isFinite(race.lastLapTime)) continue;
      const lapTime = race.lastLapTime;

      // (3a) TARTÓSAN a fizikai korlát felett: a TÉNYLEGESEN megtett útvonal hossza
      // osztva a szerver által mért köridővel. Egy teljes körön a mérési zaj
      // kiátlagolódik, és mivel a valódi útvonalat mérjük, a kanyarvágás sem zavar.
      if (lapTime > 0 && lapDist / lapTime > ctx.maxSpeed * LAP_SPEED_MARGIN) {
        cheat = {
          hard: true,
          reason:
            `Tartósan a fizikai korlát felett: ${(lapDist / lapTime).toFixed(0)} m/s átlag ` +
            `egy teljes körön (a maximum ${ctx.maxSpeed} m/s).`,
        };
      }

      // (3b) LEHETETLEN KÖRIDŐ. Ezt a SZERVER mérte a szerver órájával, tehát nem a
      // bejelentett időt hisszük el; ha mégis a fizikai minimum alatt van, az csak
      // hamisított pozíció-sorozatból jöhet.
      if (!cheat && lapTime < ctx.minLapTime) {
        cheat = { hard: true, reason: `Fizikailag lehetetlen köridő (${lapTime.toFixed(2)} s).` };
      }

      lapDist = 0; // új kör → új útvonal-számláló
    }

    // (4) Ismétlődő puha jelzés — egy-kettő még lehet hálózati löketesség, ennyi már nem.
    if (!cheat && strikes >= SOFT_STRIKES_TO_KICK) {
      cheat = { hard: true, reason: 'Ismétlődő, fizikailag lehetetlen mozgás.' };
    }

    return { events, cheat };
  }

  return {
    race,
    begin,
    update,
    get strikes() {
      return strikes;
    },
    get finished() {
      return race.phase === 'finished';
    },
  };
}
