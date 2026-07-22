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
const codeToRoomId = new Map();

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 jegyű: 1000-9999
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
