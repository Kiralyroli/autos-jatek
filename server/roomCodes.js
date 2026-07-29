// =============================================================================
//  RÖVID, SZÁMOKBÓL ÁLLÓ CSATLAKOZÁSI KÓDOK.
//
//  A Colyseus belső roomId hosszú és vegyes karakteres (pl. "MgyWGmM2_") — ezt
//  nehéz szóban/SMS-ben átadni. Ehelyett egy 4 jegyű, csak számjegyekből álló
//  kódot generálunk szobánként, és ezt mondja be egymásnak a felhasználó; a
//  kliens ebből a szerver egy HTTP-hívással (lásd server/index.js
//  GET /api/room-code/:code) fejti vissza a tényleges roomId-t, amivel aztán
//  a Colyseus joinById-t hívja (lásd src/net/mpClient.js).
//
//  In-memory Map — egy Node-folyamat egy játékszervernyi szobát szolgál ki,
//  nem kell perzisztálni (a szoba úgyis megszűnik szerver-újraindításkor).
// =============================================================================
import { randomInt } from 'crypto';

const codeToRoomId = new Map();

// KRIPTOGRÁFIAI véletlen (nem Math.random): a Math.random kimenete a belső
// állapotból kikövetkeztethető, így néhány megfigyelt kód után a KÖVETKEZŐK
// megjósolhatók lennének — egy privát szoba kódja pedig maga a belépő.
// A kódtér így is csak 9000 elemű (a szóbeli átadhatóság kedvéért), ezért a
// nyers próbálgatás ellen a feloldó végpont forgalomkorlátozott
// (lásd server/index.js /api/room-code rate limit).
function randomCode() {
  return String(randomInt(1000, 10000)); // 4 jegyű: 1000-9999
}

// Új kód generálása és regisztrálása egy roomId-hoz (ütközés esetén újrapróbál).
export function registerJoinCode(roomId) {
  let code;
  do {
    code = randomCode();
  } while (codeToRoomId.has(code));
  codeToRoomId.set(code, roomId);
  return code;
}

export function resolveJoinCode(code) {
  return codeToRoomId.get(String(code).trim()) || null;
}

export function unregisterJoinCode(code) {
  codeToRoomId.delete(code);
}
