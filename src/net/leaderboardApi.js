// =============================================================================
//  ÖRÖK RANGLISTA — kliens oldali REST-hívások (server/leaderboardStore.js).
//  Ugyanaz az API_BASE-számítás, mint net/trackApi.js-ben.
// =============================================================================
import { NET } from '../config.js';

const API_BASE = NET.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');

async function req(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* nem JSON — marad a státuszkód */
    }
    throw new Error(msg);
  }
  return res.json();
}

// Egy (trackKey, physics) alatti köridők, gyorsaság szerint: [{ playerName, lapTime, achievedAt }].
export async function apiGetLeaderboard(trackKey, physics) {
  const data = await req(`/api/leaderboard/${encodeURIComponent(trackKey)}/${encodeURIComponent(physics)}`);
  return Array.isArray(data.entries) ? data.entries : [];
}

// Köridő beküldése (csak akkor ír felül, ha jobb — lásd leaderboardStore.recordLap).
export async function apiSubmitLap({ trackKey, trackName, physics, playerName, lapTime }) {
  return req('/api/leaderboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackKey, trackName, physics, playerName, lapTime }),
  });
}

// Egy játékos köridejének törlése (dev mód).
export async function apiDeleteLeaderboardEntry(trackKey, physics, playerName) {
  return req(
    `/api/leaderboard/${encodeURIComponent(trackKey)}/${encodeURIComponent(physics)}/${encodeURIComponent(playerName)}`,
    { method: 'DELETE' }
  );
}

// A teljes tábla törlése egy (trackKey, physics) kombinációhoz (dev mód).
export async function apiClearLeaderboard(trackKey, physics) {
  return req(`/api/leaderboard/${encodeURIComponent(trackKey)}/${encodeURIComponent(physics)}`, {
    method: 'DELETE',
  });
}
