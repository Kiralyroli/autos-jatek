// =============================================================================
//  PÁLYA-KULCS — a pálya GEOMETRIÁJÁHOZ (nem a nevéhez!) kötött stabil azonosító.
//  Az örök ranglista (leaderboard) ezzel köti össze a köridőket a pontos pályával:
//  átnevezés/duplikálás nem érinti, de két EGYFORMA (layout-szerint azonos) pálya
//  ugyanazt a kulcsot kapja, akárhányszor is mentették el külön néven.
//
//  Környezet-független (böngésző ÉS Node/szerver) — a trackFactory.js szomszédja.
// =============================================================================

// A layout KANONIKUS szöveges alakja — NEM JSON.stringify (az object-kulcs sorrendtől
// függene), hanem egy fix mezősorrendű, egyértelmű reprezentáció szegmensenként.
function layoutFingerprint(layout) {
  return (Array.isArray(layout) ? layout : [])
    .map((s) => `${s.type}:${s.n ?? ''}:${s.turn ?? ''}:${s.size ?? ''}`)
    .join('|');
}

// Rövid, determinisztikus hash (FNV-1a, 32 bit, hex) a layout-fingerprintből.
export function hashLayout(layout) {
  const str = layoutFingerprint(layout);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
