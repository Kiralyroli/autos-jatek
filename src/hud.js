// HUD — a verseny-állapot MEGJELENÍTÉSE a DOM-ban. Csak olvas a race state-ből,
// soha nem írja; a játék igazsága a sim/race.js-ben van.
import { RACE, BOOST } from './config.js';

// Ennyi másodpercig látszik a szektor-delta egy checkpont átszelése után —
// ebből az első/utolsó SPLIT_ANIM_SECONDS a be-/kicsengő animációé.
const SPLIT_DISPLAY_SECONDS = 2.5;
const SPLIT_ANIM_SECONDS = 0.22;

// Az "Érvénytelen kör!" szalag csak EGYSZER, RÖVIDEN villan fel, amikor a kör
// érvénytelenné válik — utána a piros, ⚠-es köridő önmagában elég jelzés.
// (Korábban a kör végéig kint maradt, és folyamatosan takarta a pályát.)
const INVALID_BANNER_SECONDS = 2.6;
const INVALID_FADE_SECONDS = 0.4;

// A szektor-delta jelvény opacitása/eltolása/mérete a split óta eltelt idő
// (elapsed, s) TISZTA FÜGGVÉNYEKÉNT — nincs CSS-animáció/osztály-újraindítás,
// ezért két gyorsan egymás utáni split (rövid szektorok) esetén sem "akad meg"
// egy félbehagyott átmenet: minden frame-ben újraszámolt, konzisztens állapot.
function splitAnimStyle(elapsed) {
  if (elapsed < SPLIT_ANIM_SECONDS) {
    const t = elapsed / SPLIT_ANIM_SECONDS; // 0..1, belépő szakasz
    return { opacity: t, translateY: (1 - t) * -8, scale: 0.85 + 0.15 * t };
  }
  const fadeStart = SPLIT_DISPLAY_SECONDS - SPLIT_ANIM_SECONDS;
  if (elapsed < fadeStart) {
    return { opacity: 1, translateY: 0, scale: 1 }; // teljes láthatóság
  }
  const t = (elapsed - fadeStart) / SPLIT_ANIM_SECONDS; // 0..1, kilépő szakasz
  return { opacity: Math.max(0, 1 - t), translateY: 0, scale: 1 };
}

// Másodperc → "1:03.45" vagy "23.45 s" formátum. Exportálva — a ranglista
// (main.js renderLeaderboard) is ezt használja a köridők megjelenítésére.
export function fmt(seconds) {
  if (seconds === null || seconds === undefined) return '–';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)} s`;
}

// Helyezés → "1." + hely-emoji (dobogó az első 3-nak).
function placeLabel(place) {
  const medal = place === 1 ? '🥇 ' : place === 2 ? '🥈 ' : place === 3 ? '🥉 ' : '';
  return `${medal}${place}. helyezés`;
}

export function createHud(onRestart, onHotlapReset) {
  const raceInfoEl = document.getElementById('raceinfo');
  const lapEl = document.getElementById('lap');
  const timeEl = document.getElementById('laptime');
  const bestEl = document.getElementById('bestlap');
  const cdEl = document.getElementById('countdown');
  const wrongWayEl = document.getElementById('wrongway');
  const invalidLapEl = document.getElementById('invalidlap');
  const restartEl = document.getElementById('restart');
  const sectorDeltaEl = document.getElementById('sectordelta');
  const hotlapResetEl = document.getElementById('hotlapReset');
  const speedoRingEl = document.getElementById('speedoRing');
  const boostMeterEl = document.getElementById('boostMeter');
  const boostFillEl = document.getElementById('boostBarFill');
  const boostValueEl = document.getElementById('boostValue');
  const pitStopEl = document.getElementById('pitStopHud');

  if (onRestart) restartEl.addEventListener('click', onRestart);
  if (onHotlapReset) hotlapResetEl.addEventListener('click', onHotlapReset);

  // Mikor (race.time) vált a kör érvénytelenné — ebből számoljuk, hogy az
  // "Érvénytelen kör!" szalag még látszik-e (lásd INVALID_BANNER_SECONDS).
  // null = a jelenlegi kör érvényes, nincs mit mutatni.
  let invalidSince = null;

  return function updateHud(race) {
    raceInfoEl.style.display = 'flex'; // updateHud csak játék közben fut
    if (speedoRingEl) speedoRingEl.style.display = 'flex';
    if (boostMeterEl) boostMeterEl.style.display = 'flex';
    wrongWayEl.style.display =
      race.phase === 'racing' && race.wrongWay ? 'flex' : 'none';
    // Kötelező kerékcsere: amíg nincs meg, végig látszik a versenyen (lásd
    // sim/race.js pitStopRequired/pitStopDone) — nem villanás, mert a
    // versenyzőnek EGÉSZ végig kell tudnia, hogy még be kell hajtania.
    if (pitStopEl) {
      const showPitStop = race.phase === 'racing' && race.pitStopRequired && !race.pitStopDone;
      pitStopEl.style.display = showPitStop ? 'flex' : 'none';
      if (showPitStop) {
        // Amíg a zónában, ~állva méri az idő (lásd sim/race.js updatePitStop —
        // pitStopTimer > 0 csak akkor, ha ÉPP ott áll) — VISSZASZÁMLÁLÁST mutatunk,
        // különben a statikus "menj be" emlékeztetőt.
        pitStopEl.textContent =
          race.pitStopTimer > 0
            ? `🔧 Állj meg még ${Math.max(0, RACE.pitStop.requiredSeconds - race.pitStopTimer).toFixed(1)} mp-ig!`
            : '🔧 Kötelező kiállás a boxutcában!';
      }
    }
    // A cél utáni "Új verseny" gombot MP-ben a végeredmény-panel váltja ki (main.js).
    restartEl.style.display =
      race.phase === 'finished' && !race.hideRestart ? 'block' : 'none';
    // Hot Lap: nincs "cél" (végtelen körszám), ezért ehelyett egy MINDIG látható
    // reset gomb — azonnal vissza a guruló-rajt pontra, új próba (main.js
    // startSingleplayer hotLap ág).
    hotlapResetEl.style.display = race.isHotLap ? 'block' : 'none';

    // Hot Lap módban totalLaps=Infinity ("ne legyen körszám" — lásd main.js
    // startSingleplayer hotLap ág) — ilyenkor nincs "/N" limit, csak a futó kör.
    lapEl.textContent = Number.isFinite(race.totalLaps)
      ? `${race.lap}/${race.totalLaps}`
      : `${race.lap}`;
    const current =
      race.phase === 'racing' ? race.time - race.lapStartTime : race.lastLapTime;
    // Érvénytelen kör (letért a pályáról): a köridő VÉGIG pirosan, ⚠-vel
    // jelzi az állapotot — ez a TARTÓS jelzés. Az "Érvénytelen kör!" szalag
    // viszont csak a bekövetkezés pillanatában villan fel röviden, hogy a
    // figyelmet odavigye, aztán eltűnik és nem takarja tovább a pályát.
    const invalidLap = race.phase === 'racing' && race.lapValid === false;
    timeEl.textContent = (invalidLap ? '⚠ ' : '') + fmt(current);
    timeEl.style.color = invalidLap ? 'var(--danger)' : '';

    if (!invalidLap) {
      invalidSince = null;
    } else if (invalidSince === null || race.time < invalidSince) {
      // Most vált érvénytelenné — VAGY visszaugrott az óra (új kör/verseny,
      // pl. Hot Lap reset), ilyenkor újra kell indítani a visszaszámlálást,
      // különben a szalag soha többé nem jelenne meg.
      invalidSince = race.time;
    }
    const invalidElapsed = invalidSince === null ? Infinity : race.time - invalidSince;
    const showInvalidBanner = invalidLap && invalidElapsed < INVALID_BANNER_SECONDS;
    invalidLapEl.style.display = showInvalidBanner ? 'flex' : 'none';
    if (showInvalidBanner) {
      // Kicsengés az utolsó pillanatokban — a szektor-deltához hasonlóan
      // minden frame-ben újraszámolva (nincs CSS-animáció, ami "megakadhat").
      const fadeStart = INVALID_BANNER_SECONDS - INVALID_FADE_SECONDS;
      invalidLapEl.style.opacity =
        invalidElapsed < fadeStart
          ? '1'
          : String(Math.max(0, 1 - (invalidElapsed - fadeStart) / INVALID_FADE_SECONDS));
    }
    // race.lapSaveFailing: main.js állítja, ha a köridő ranglistára küldése
    // 3+ egymást követő alkalommal elbukott (élő hibajelentés: korábban ez
    // csendben, láthatatlanul történt — a játékos csak a menüben, utólag vette
    // észre, hogy a javított köre "eltűnt"). Egy-két átmeneti hiba még nem
    // jelez itt semmit (a háttérben újrapróbálkozik), csak a TARTÓS probléma.
    bestEl.textContent = fmt(race.bestLapTime) + (race.lapSaveFailing ? ' ⚠' : '');
    bestEl.title = race.lapSaveFailing
      ? 'A köridő mentése a ranglistára egyelőre nem sikerül — a játék a háttérben újrapróbálja.'
      : '';

    // Boost: a hátralévő üzemanyag (s) aránya (BOOST.maxPerLap = tele) — külön,
    // alul középen ülő sávos mérőn (index.html #boostMeter).
    // A `race.boostRemaining`-et a hívó (main.js) írja rá a race-objektumra
    // csak megjelenítés céljából — a sim/car.js drive.boostRemaining a valódi forrás.
    if (boostMeterEl && boostFillEl) {
      const remaining = Number.isFinite(race.boostRemaining) ? race.boostRemaining : BOOST.maxPerLap;
      const frac = Math.max(0, Math.min(1, remaining / BOOST.maxPerLap));
      boostFillEl.style.width = `${(frac * 100).toFixed(1)}%`;
      boostMeterEl.classList.toggle('empty', remaining <= 0.001);
      if (boostValueEl) boostValueEl.textContent = `${remaining.toFixed(1)} s`;
    }

    // Szektor-delta: a legutóbb átszelt checkponton mérve, a legjobb kör
    // UGYANOTT mért idejéhez képest (lásd sim/race.js lastSplitDelta/lastSplitAt)
    // — jelvény-szerű kijelző nyíl-ikonnal, be-/kicsengő animációval
    // (splitAnimStyle), amíg el nem telik SPLIT_DISPLAY_SECONDS.
    const elapsed = race.lastSplitAt != null ? race.time - race.lastSplitAt : Infinity;
    const showSplit = race.phase === 'racing' && race.lastSplitDelta != null && elapsed < SPLIT_DISPLAY_SECONDS;
    if (showSplit) {
      const d = race.lastSplitDelta;
      const faster = d <= 0;
      sectorDeltaEl.innerHTML =
        `<span class="arrow">${faster ? '▼' : '▲'}</span><span>${faster ? '' : '+'}${d.toFixed(2)} s</span>`;
      // race.sectorFieldBest: a hívó (main.js) állítja igazra, ha MP-ben épp MI
      // tartjuk a mezőny (nem csak a saját magunk) legjobb idejét ezen a
      // ponton — ilyenkor lila a zöld helyett (lásd index.html #sectordelta.purple).
      // SP-ben nincs mezőny, akihez mérni, ezért ott ez sosem igaz.
      sectorDeltaEl.className = faster ? (race.sectorFieldBest ? 'purple' : 'faster') : 'slower';
      const { opacity, translateY, scale } = splitAnimStyle(elapsed);
      sectorDeltaEl.style.opacity = String(opacity);
      sectorDeltaEl.style.transform = `translateX(-50%) translateY(${translateY}px) scale(${scale})`;
    } else {
      sectorDeltaEl.style.opacity = '0';
    }

    // Középső overlay: visszaszámlálás → GO! → (verseny közben semmi) → cél-eredmény.
    if (race.phase === 'countdown') {
      cdEl.style.display = 'flex';
      cdEl.style.fontSize = '110px';
      cdEl.textContent = String(Math.ceil(race.countdownLeft));
    } else if (race.phase === 'racing' && race.time < 1) {
      cdEl.style.display = 'flex';
      cdEl.style.fontSize = '110px';
      cdEl.textContent = 'GO!';
    } else if (race.phase === 'finished') {
      cdEl.style.display = 'flex';
      cdEl.style.fontSize = '40px';
      // MP: a célba éréskor a HELYEZÉS a fő üzenet; SP: sima "Cél!".
      const head = race.place ? `🏁 ${placeLabel(race.place)}!` : '🏁 Cél!';
      cdEl.innerHTML =
        `${head}<br>Összidő: ${fmt(race.time)}<br>Legjobb kör: ${fmt(race.bestLapTime)}`;
    } else {
      cdEl.style.display = 'none';
    }
  };
}
