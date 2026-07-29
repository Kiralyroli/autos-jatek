// =============================================================================
//  DEV MÓD — fejlesztői funkciók kapuja (pálya-szerkesztő, autó-hangoló panel).
//
//  Bekapcsolás:  http://localhost:5173/?dev=1   (megjegyzi localStorage-ban)
//  Kikapcsolás:  ?dev=0
//
//  FONTOS — ez CSAK A FELÜLETET kapcsolja, NEM jogosultság! Egy localStorage-flag,
//  amit bárki átállít a konzolból, és a `fetch`/`curl` amúgy is megkerüli. Ezért a
//  romboló műveleteket (pálya mentés/törlés, ranglista törlés) a SZERVER védi
//  (server/security.js requireAdmin) — a lenti admin-token az, ami valóban számít.
//
//  CSAK kliens-oldali modul (window-t használ) — a szerver sosem importálja.
// =============================================================================
const DEV_KEY = 'autos-jatek:devMode';
const TOKEN_KEY = 'autos-jatek:adminToken';

const params = new URLSearchParams(window.location.search);
const param = params.get('dev');
if (param === '1') localStorage.setItem(DEV_KEY, '1');
if (param === '0') {
  localStorage.removeItem(DEV_KEY);
  localStorage.removeItem(TOKEN_KEY); // dev mód ki → a token se maradjon a gépen
}

// Az admin-token URL-ből is átadható egyszer (?adminToken=…), hogy ne kelljen
// kézzel a konzolba írni. AZONNAL kitöröljük a címsorból (history.replaceState),
// hogy ne ragadjon bent az előzményekben / meg ne osztódjon egy link másolásával.
const urlToken = params.get('adminToken');
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  params.delete('adminToken');
  const q = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : ''));
}

export function isDevMode() {
  return localStorage.getItem(DEV_KEY) === '1';
}

export function getAdminToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setAdminToken(token) {
  const t = String(token || '').trim();
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

// A szerver az `Authorization: Bearer …`-t és az `X-Admin-Token`-t is elfogadja
// (lásd server/security.js presentedToken) — a Bearer a szokásosabb alak.
export function adminHeaders() {
  const t = getAdminToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
