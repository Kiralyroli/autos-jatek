// =============================================================================
//  ÖRÖK RANGLISTA — kliens oldali REST-hívások (server/leaderboardStore.js).
//  A közös kérés-réteg (hibakezelés, admin-hitelesítés) a httpApi.js-ben van.
//
//  Az olvasás és a KÖRIDŐ-BEKÜLDÉS bárkinek megy (minden játékosnak be kell tudnia
//  küldeni a körét, és nincs felhasználó-kezelés) — ott a szerver oldali védelem a
//  forgalomkorlátozás + a fizikai hihetőség-ellenőrzés (server/lapValidation.js).
//  A TÖRLÉS admin-tokent igényel.
// =============================================================================
import { apiRequest, apiAdminRequest } from './httpApi.js';

// Egy (trackKey, physics) alatti köridők, gyorsaság szerint: [{ playerName, lapTime, achievedAt }].
export async function apiGetLeaderboard(trackKey, physics) {
  const data = await apiRequest(
    `/api/leaderboard/${encodeURIComponent(trackKey)}/${encodeURIComponent(physics)}`
  );
  return Array.isArray(data.entries) ? data.entries : [];
}

// Köridő beküldése (csak akkor ír felül, ha jobb — lásd leaderboardStore.recordLap).
// `keepalive: true`: ÉLŐ HIBAJELENTÉS — a javított köridő gyakran "eltűnt",
// mert a beküldés egy sima fetch() volt, amit a böngésző MEGSZAKÍT, ha az oldal
// épp akkor navigál el/töltődik újra (pl. a "← Főmenü" gomb window.location.
// reload()-ja) — a JAVÍTOTT kör pont az utolsó pillanatban (a versenyt/kört
// épp befejezve, gyors kilépéssel) veszett el a leggyakrabban. A `keepalive`
// a fetch specifikációja szerint túléli az oldal-elhagyást (ugyanaz a
// mechanizmus, mint a navigator.sendBeacon), a kis JSON törzs (64 KB alatt)
// bőven belefér a keepalive-kérések méretkorlátjába.
export async function apiSubmitLap({ trackKey, trackName, physics, playerName, lapTime }) {
  return apiRequest('/api/leaderboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackKey, trackName, physics, playerName, lapTime }),
    keepalive: true,
  });
}

// Egy játékos köridejének törlése (dev mód + admin-token).
export async function apiDeleteLeaderboardEntry(trackKey, physics, playerName) {
  return apiAdminRequest(
    `/api/leaderboard/${encodeURIComponent(trackKey)}/${encodeURIComponent(physics)}/${encodeURIComponent(playerName)}`,
    { method: 'DELETE' }
  );
}

// A teljes tábla törlése egy (trackKey, physics) kombinációhoz (dev mód + admin-token).
export async function apiClearLeaderboard(trackKey, physics) {
  return apiAdminRequest(
    `/api/leaderboard/${encodeURIComponent(trackKey)}/${encodeURIComponent(physics)}`,
    { method: 'DELETE' }
  );
}
