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
// Két formátum lehetséges (lásd trackFactory.js isSplineLayout — itt szándékosan
// külön, apró duplikált ellenőrzés, hogy ez a modul importok nélkül maradjon):
// a régi (rács/szegmens) minden eleme {type,...}, az új (szabadvonalas) csak
// {x,z} kontrollpontokból áll.
function layoutFingerprint(layout) {
  const arr = Array.isArray(layout) ? layout : [];
  if (arr.length > 0 && arr[0] && typeof arr[0].x === 'number' && arr[0].type === undefined) {
    // Szabadvonalas: a kontrollpontok koordinátái (kerekítve, hogy a lebegőpontos
    // zaj ne adjon más kulcsot ugyanarra a pályára).
    return arr.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join('|');
  }
  return arr.map((s) => `${s.type}:${s.n ?? ''}:${s.turn ?? ''}:${s.size ?? ''}`).join('|');
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
