// =============================================================================
//  BIZTONSÁGI RÉTEG — admin-hitelesítés, forgalomkorlátozás, védelmi fejlécek, CORS.
//
//  MIÉRT KELL: a REST API (server/index.js) a nyílt interneten fut (Railway). A
//  "dev mód" (src/devmode.js) CSAK a KLIENS felületét kapcsolja — egy localStorage
//  flag, amit bárki átállít, és a `fetch`/`curl` amúgy is megkerüli. Tehát minden
//  romboló műveletet (pálya/ranglista törlés, pálya felülírás) a SZERVERNEK kell
//  védenie, különben bárki, aki ismeri a domaint, egy paranccsal kitörli az összes
//  pályát és köridőt.
//
//  Modell (nincs felhasználó-kezelés, nem is kell ide):
//   - LOOPBACK (a szervergépről, 127.0.0.1) → mindig szabad. Ez a saját géped;
//     aki idáig eljut, az már a gépen van. Így a lokális fejlesztés config nélkül megy.
//   - Távolról → `ADMIN_TOKEN` env-változó kell, és a kérésnek fel kell mutatnia
//     (`Authorization: Bearer …` vagy `X-Admin-Token`). Ha nincs beállítva token,
//     a romboló végpontok TELJESEN tiltottak (fail-closed) — így egy elfelejtett
//     környezeti változó nem NYITVA hagyja, hanem ZÁRVA a rendszert.
// =============================================================================
import { createHash, timingSafeEqual } from 'crypto';

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

// Konstans idejű összehasonlítás. A SHA-256 digest-eken hasonlítunk, nem a nyers
// stringeken: a timingSafeEqual eltérő hosszra kivételt dob, a hossz-ellenőrzés
// pedig önmagában kiszivárogtatná a token hosszát. A digest mindig 32 bájt.
function constantTimeEquals(a, b) {
  return timingSafeEqual(
    createHash('sha256').update(String(a)).digest(),
    createHash('sha256').update(String(b)).digest()
  );
}

// A NYERS TCP-partner címe — szándékosan NEM a `req.ip`. A req.ip a
// `trust proxy` beállítás miatt az X-Forwarded-For fejlécből származik, amit a
// kliens (részben) maga ír; a socket tényleges partnere viszont nem hamisítható.
// Reverse proxy mögött (Railway) a partner a proxy belső címe, sosem loopback —
// ezért ez a kapu élesben biztosan nem nyílik ki véletlenül.
function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function presentedToken(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  return (req.get('x-admin-token') || '').trim();
}

// Middleware: romboló/adminisztratív végpontok kapuja.
export function requireAdmin(req, res, next) {
  if (isLoopback(req)) return next();
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: 'Adminisztratív műveletek távolról letiltva (nincs ADMIN_TOKEN beállítva a szerveren).',
    });
  }
  const token = presentedToken(req);
  if (!token || !constantTimeEquals(token, ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Érvénytelen vagy hiányzó admin-token.' });
  }
  next();
}

export const adminTokenConfigured = () => ADMIN_TOKEN.length > 0;

// =============================================================================
//  FORGALOMKORLÁTOZÁS (rate limit) — IP + végpont-csoportonként, fix ablakkal.
//
//  Külső csomag nélkül, szándékosan: pár tucat sor, teljesen átlátható, és nem
//  növeli a függőségi (supply-chain) felületet. Egy Node-folyamat egy szervert
//  szolgál ki, ezért a memóriabeli számláló elég — nem kell megosztott tároló.
// =============================================================================
const buckets = new Map(); // "csoport:ip" → { count, resetAt }
const MAX_TRACKED = 20000; // memória-plafon (IPv6-ból sok cím jöhet)

function prune(now) {
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  // Ha a lejártak takarítása után is túl sok van, a legkorábban lejárókat dobjuk.
  if (buckets.size > MAX_TRACKED) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < sorted.length - MAX_TRACKED; i++) buckets.delete(sorted[i][0]);
  }
}
setInterval(() => prune(Date.now()), 60_000).unref?.();

// `limit` kérés `windowMs` ablakonként, IP-nként. A `name` külön "vödröt" ad, így
// pl. az olvasás bőkezű lehet, az írás szigorú, anélkül hogy egymást fogyasztanák.
export function rateLimit({ name, limit, windowMs, message }) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    if (buckets.size > MAX_TRACKED) prune(now);
    const key = `${name}:${req.ip}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Túl sok kérés — próbáld később.' });
    }
    next();
  };
}

// =============================================================================
//  VÉDELMI FEJLÉCEK
//
//  A CSP a tárolt XSS elleni MÁSODIK védvonal (az első a kimenet escape-elése a
//  kliensen, lásd src/main.js escapeHtml): még ha egy `<img onerror=…>` be is
//  kerülne egy pálya-névbe, a `script-src 'self'` megakadályozza a lefutását.
//  A build (dist/index.html) egyetlen külső modul-scriptet tölt és NINCS benne
//  inline <script>, ezért a szigorú script-src nem tör el semmit; a beágyazott
//  <style> blokk miatt viszont a style-src-nél kell 'unsafe-inline'.
//  A GLTFLoader blob: URL-eket készít a modellek textúráihoz → img/media blob:.
//  A Colyseus WebSocket azonos originre megy, amit a CSP3 szerint a 'self' fed.
// =============================================================================
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  // `blob:` KELL a fetch-hez is, nem csak az img-src-hez: a GLB-kbe ÁGYAZOTT
  // textúrákat a Three.js a THREE.ImageBitmapLoader-rel tölti, az pedig
  // `fetch()`-csel nyitja meg a saját maga készített blob: URL-t — a fetch-et
  // viszont a connect-src szabályozza, nem az img-src. Enélkül élesben
  // "THREE.GLTFLoader: Couldn't load texture blob:…" hibával a textúrázott
  // dekorációk (kerítés-háló, garázs-molinó) TEXTÚRA NÉLKÜL, tömör fehér
  // felületként jelentek meg — a geometria hibátlan volt, ezért nézett ki
  // úgy, mintha "csak az alap modell" töltődne be. A blob: URL saját
  // eredetű és csak a lapon belül él, kifelé nem nyit csatornát.
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff'); // ne találgasson MIME-típust
  res.setHeader('X-Frame-Options', 'DENY'); // clickjacking (régi böngészőkhöz)
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.removeHeader('X-Powered-By'); // ne hirdessük a stacket
  next();
}

// =============================================================================
//  CORS — engedélyezett originek listája (korábban: `cors()` = MINDENKI).
//
//  FONTOS, hogy mit véd és mit nem: a CORS a BÖNGÉSZŐben futó, IDEGEN oldalról
//  indított kéréseket blokkolja (a JSON POST és minden DELETE preflightot vált ki,
//  amit egy nem engedélyezett origin nem tud átvinni) — tehát azt akadályozza meg,
//  hogy egy tetszőleges weboldal a LÁTOGATÓD böngészőjével piszkálja az API-t.
//  A `curl`-lel közvetlenül küldött kérés ellen a CORS SEMMIT nem ér — az ellen a
//  requireAdmin + rate limit + validáció véd.
//
//  Élesben a kliens ugyanarról az originről jön (express.static), tehát Origin
//  fejléc nélküli/azonos originű kérés a normális eset. A Vite dev-szerver
//  (localhost:5173) külön originről szól a :2567-re — ezt engedjük.
//  További originek: ALLOWED_ORIGINS="https://a.example,https://b.example".
// =============================================================================
const EXTRA_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function isLocalDevOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

export const corsOptions = {
  origin(origin, cb) {
    // Nincs Origin fejléc → azonos originű navigáció, curl, natív kliens.
    // Ezeknél a CORS fogalmilag nem értelmezett; a hozzáférést a végpontok
    // saját kapui (requireAdmin) döntik el, nem ez.
    if (!origin) return cb(null, true);
    if (isLocalDevOrigin(origin) || EXTRA_ORIGINS.has(origin)) return cb(null, true);
    // Nem hiba, csak NEM teszünk engedélyező fejlécet → a böngésző elzárja.
    cb(null, false);
  },
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
  maxAge: 600,
};
