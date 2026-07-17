// HUD — a verseny-állapot MEGJELENÍTÉSE a DOM-ban. Csak olvas a race state-ből,
// soha nem írja; a játék igazsága a sim/race.js-ben van.
import { RACE } from './config.js';

// Másodperc → "1:03.45" vagy "23.45 s" formátum.
function fmt(seconds) {
  if (seconds === null || seconds === undefined) return '–';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)} s`;
}

export function createHud(onRestart) {
  const lapEl = document.getElementById('lap');
  const timeEl = document.getElementById('laptime');
  const bestEl = document.getElementById('bestlap');
  const cdEl = document.getElementById('countdown');
  const wrongWayEl = document.getElementById('wrongway');
  const restartEl = document.getElementById('restart');

  if (onRestart) restartEl.addEventListener('click', onRestart);

  return function updateHud(race) {
    wrongWayEl.style.display =
      race.phase === 'racing' && race.wrongWay ? 'flex' : 'none';
    restartEl.style.display = race.phase === 'finished' ? 'block' : 'none';
    lapEl.textContent = `Kör: ${race.lap}/${race.totalLaps || RACE.laps}`;
    const current =
      race.phase === 'racing' ? race.time - race.lapStartTime : race.lastLapTime;
    timeEl.textContent = `Köridő: ${fmt(current)}`;
    bestEl.textContent = `Legjobb: ${fmt(race.bestLapTime)}`;

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
      cdEl.style.fontSize = '44px';
      cdEl.innerHTML =
        `🏁 Cél!<br>Összidő: ${fmt(race.time)}<br>Legjobb kör: ${fmt(race.bestLapTime)}`;
    } else {
      cdEl.style.display = 'none';
    }
  };
}
