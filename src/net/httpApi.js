// =============================================================================
//  KÖZÖS REST-RÉTEG a szerver felé (pálya-katalógus + örök ranglista).
//
//  Egy helyen: a szerver címének származtatása, a hibakezelés, és az
//  ADMIN-HITELESÍTÉS. A romboló végpontokat (pálya mentés/törlés, ranglista
//  törlés) a szerver admin-tokenhez köti (server/security.js requireAdmin) —
//  a token a dev módhoz tartozik (src/devmode.js). Ha hiányzik vagy rossz, a
//  szerver 401-et ad; ilyenkor EGYSZER bekérjük és újrapróbáljuk, hogy ne egy
//  néma hibaüzenettel álljon meg a szerkesztő.
// =============================================================================
import { NET } from '../config.js';
import { adminHeaders, setAdminToken } from '../devmode.js';

const API_BASE = NET.serverUrl.replace(/^ws(s?):\/\//, 'http$1://');

async function rawRequest(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* nem JSON — marad a státuszkód */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Sima (hitelesítés nélküli) kérés — olvasás és köridő-beküldés.
export function apiRequest(path, opts) {
  return rawRequest(path, opts);
}

// Admin-jogot igénylő kérés. 401 esetén bekéri a tokent, és újrapróbálja.
export async function apiAdminRequest(path, opts = {}) {
  const withAuth = (extra) => ({
    ...opts,
    headers: { ...(opts.headers || {}), ...adminHeaders(), ...extra },
  });
  try {
    return await rawRequest(path, withAuth());
  } catch (e) {
    if (e.status !== 401) throw e;
    const entered = window.prompt(
      'Admin-token szükséges ehhez a művelethez.\n' +
        '(A szerveren beállított ADMIN_TOKEN értéke — lásd CLAUDE.md, Biztonság.)'
    );
    if (!entered) throw e;
    setAdminToken(entered);
    return rawRequest(path, withAuth());
  }
}
