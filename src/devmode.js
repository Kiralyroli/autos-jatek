// =============================================================================
//  DEV MÓD — fejlesztői funkciók kapuja (pálya-szerkesztő, autó-hangoló panel).
//
//  Bekapcsolás:  http://localhost:5173/?dev=1   (megjegyzi localStorage-ban)
//  Kikapcsolás:  ?dev=0
//
//  CSAK kliens-oldali modul (window-t használ) — a szerver sosem importálja.
// =============================================================================
const DEV_KEY = 'autos-jatek:devMode';

const param = new URLSearchParams(window.location.search).get('dev');
if (param === '1') localStorage.setItem(DEV_KEY, '1');
if (param === '0') localStorage.removeItem(DEV_KEY);

export function isDevMode() {
  return localStorage.getItem(DEV_KEY) === '1';
}
