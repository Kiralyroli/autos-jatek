// =============================================================================
//  .env BETÖLTÉS — verzió-független, függőség nélkül.
//
//  MIÉRT NEM a `node --env-file` flag: az csak Node 20.6+ (a `--env-file-if-exists`
//  pedig 22.9+) alatt létezik. ÉLES HIBA VOLT belőle: a Railway ennél régebbi
//  Node-ot futtatott, és a `node: bad option: --env-file-if-exists=.env` miatt a
//  konténer indulás után azonnal elszállt, végtelen újraindulási ciklusban.
//  Ez a modul minden Node-verzión működik, és ha nincs .env fájl, csendben kihagyja.
//
//  A MÁR BEÁLLÍTOTT változókat SOSEM írja felül: éles környezetben (Railway,
//  systemd) a platform injektálja a valódi értékeket, azok mindig erősebbek egy
//  véletlenül ottfelejtett .env fájlnál.
//
//  FONTOS — ezt a modult az `index.js` LEGELSŐ importjaként kell behúzni. Az ESM a
//  importokat mélységi sorrendben, a forrásbeli sorrend szerint értékeli ki, a
//  security.js/trackStore.js pedig MODUL-SZINTEN (betöltéskor) olvassa a
//  process.env-et — ha ez a betöltés később futna, azok már az üres értéket látnák.
// =============================================================================
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (existsSync(ENV_FILE)) {
  try {
    for (const rawLine of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Idézőjelek levétele (ha az érték szóközt/speciális karaktert tartalmaz).
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    console.log('📄 .env betöltve.');
  } catch (e) {
    console.error('.env olvasási hiba (kihagyva):', e.message);
  }
}
