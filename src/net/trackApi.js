// =============================================================================
//  GLOBÁLIS PÁLYA-KATALÓGUS — kliens oldali REST-hívások a szerverhez.
//
//  A pályák a szerveren élnek (server/trackStore.js), így minden gépről/böngészőből
//  elérhetők. A közös kérés-réteg (hibakezelés, admin-hitelesítés) a httpApi.js-ben
//  van — az OLVASÁS bárkinek megy, a MENTÉS/TÖRLÉS admin-tokent igényel (a pálya
//  mentése NÉVRE upsertel, tehát enélkül bárki felülírhatná mások pályáját).
// =============================================================================
import { apiRequest, apiAdminRequest } from './httpApi.js';

// A pálya-katalógus metaadat-listája: [{ id, name, segments, decorations, ... }].
export async function apiListTracks() {
  const data = await apiRequest('/api/tracks');
  return Array.isArray(data.tracks) ? data.tracks : [];
}

// Egy pálya TELJES adata: { id, name, layout, decorations }.
export async function apiGetTrack(id) {
  return apiRequest(`/api/tracks/${encodeURIComponent(id)}`);
}

// Pálya mentése/felülírása (névre upsert). Visszaadja: { id, name }.
// Az editorPath/editorDecorations a szerkesztő WYSIWYG-nézete (opcionális) — a
// játék nem használja, csak a szerkesztő újranyitásakor áll vissza pontosan.
export async function apiSaveTrack({ name, layout, decorations, pitLane, editorPath, editorDecorations }) {
  return apiAdminRequest('/api/tracks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, layout, decorations, pitLane, editorPath, editorDecorations }),
  });
}

// Pálya törlése id alapján.
export async function apiDeleteTrack(id) {
  return apiAdminRequest(`/api/tracks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
