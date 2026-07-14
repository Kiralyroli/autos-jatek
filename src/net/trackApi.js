// =============================================================================
//  GLOBÁLIS PÁLYA-KATALÓGUS — kliens oldali REST-hívások a szerverhez.
//
//  A pályák a szerveren élnek (server/trackStore.js), így minden gépről/böngészőből
//  elérhetők. A szerver címét a NET.serverUrl-ből származtatjuk: ws→http, wss→https.
//  Élesben ez ugyanaz az origin, ahonnan a kliens jön (Railway), fejlesztésben a
//  külön Colyseus szerver (localhost:2567).
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

// A pálya-katalógus metaadat-listája: [{ id, name, segments, decorations, ... }].
export async function apiListTracks() {
  const data = await req('/api/tracks');
  return Array.isArray(data.tracks) ? data.tracks : [];
}

// Egy pálya TELJES adata: { id, name, layout, decorations }.
export async function apiGetTrack(id) {
  return req(`/api/tracks/${encodeURIComponent(id)}`);
}

// Pálya mentése/felülírása (névre upsert). Visszaadja: { id, name }.
export async function apiSaveTrack({ name, layout, decorations }) {
  return req('/api/tracks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, layout, decorations }),
  });
}

// Pálya törlése id alapján.
export async function apiDeleteTrack(id) {
  return req(`/api/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
