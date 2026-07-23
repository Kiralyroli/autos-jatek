// HUD — a verseny-állapot MEGJELENÍTÉSE a DOM-ban. Csak olvas a race state-ből,
// soha nem írja; a játék igazsága a sim/race.js-ben van.
import { RACE } from './config.js';

// Ennyi másodpercig látszik a szektor-delta egy checkpont átszelése után —
// ebből az első/utolsó SPLIT_ANIM_SECONDS a be-/kicsengő animációé.
const SPLIT_DISPLAY_SECONDS = 2.5;
const SPLIT_ANIM_SECONDS = 0.22;

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

export function createHud(onRestart) {
  const raceInfoEl = document.getElementById('raceinfo');
  const lapEl = document.getElementById('lap');
  const timeEl = document.getElementById('laptime');
  const bestEl = document.getElementById('bestlap');
  const cdEl = document.getElementById('countdown');
  const wrongWayEl = document.getElementById('wrongway');
  const invalidLapEl = document.getElementById('invalidlap');
  const restartEl = document.getElementById('restart');
  const sectorDeltaEl = document.getElementById('sectordelta');

  if (onRestart) restartEl.addEventListener('click', onRestart);

  return function updateHud(race) {
    raceInfoEl.style.display = 'flex'; // updateHud csak játék közben fut
    wrongWayEl.style.display =
      race.phase === 'racing' && race.wrongWay ? 'flex' : 'none';
    // A cél utáni "Új verseny" gombot MP-ben a végeredmény-panel váltja ki (main.js).
    restartEl.style.display =
      race.phase === 'finished' && !race.hideRestart ? 'block' : 'none';

    lapEl.textContent = `${race.lap}/${race.totalLaps || RACE.laps}`;
    const current =
      race.phase === 'racing' ? race.time - race.lapStartTime : race.lastLapTime;
    // Érvénytelen kör (letért a pályáról): a köridőt pirosan, ⚠-vel jelezzük, és
    // egy infó-szalag is megjelenik — ez a kör nem számít a legjobbhoz.
    const invalidLap = race.phase === 'racing' && race.lapValid === false;
    timeEl.textContent = (invalidLap ? '⚠ ' : '') + fmt(current);
    timeEl.style.color = invalidLap ? '#ff6b4a' : '';
    invalidLapEl.style.display = invalidLap ? 'flex' : 'none';
    bestEl.textContent = fmt(race.bestLapTime);

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
      sectorDeltaEl.className = faster ? 'faster' : 'slower';
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
