// =============================================================================
//  ÉRINTŐS VEZÉRLÉS — mobil/touch eszközökön a billentyűzet mellett/helyett.
//  Ugyanazt a semleges input-alakot adja, mint input.js readInput()-ja
//  (up/down/left/right/drift/boost), hogy main.js egyszerűen ÖSSZE tudja
//  olvasztani (OR) a kettőt — egy eszközön akár mindkettő egyszerre is
//  használható.
//
//  KÉT DÖNTÉS, ami a mobil-élményt megkülönbözteti a sima "gombok" megoldástól:
//
//  1) BOOST = GÁZ + BOOST. Élő visszajelzés: a boost volt a legnehezebben
//     használható, mert KÜLÖN gombként a gáz MELLETT kellett volna nyomni —
//     egy hüvelykujjal ez gyakorlatilag lehetetlen, kettővel meg elveszik a
//     kormányzás. Mostantól a boost-gomb ÖNMAGÁBAN teljes gázt IS ad (lásd
//     readInput lent), így egyetlen ujjal, a gázról feljebb csúszva elérhető.
//
//  2) ZÓNA-ALAPÚ ujjkövetés a gombonkénti listenerek helyett. A gyökér-elemen
//     figyelünk, és a pointer KOORDINÁTÁJÁBÓL döntjük el, melyik gomb fölött
//     van — ezért az ujj ÁTCSÚSZTATHATÓ egyik gombról a másikra (gáz → boost)
//     anélkül, hogy fel kellene emelni. A korábbi, gombonkénti
//     pointerdown/up + setPointerCapture ezt NEM tudta: a capture a lenyomás
//     gombjához kötötte az ujjat, a szomszéd gomb néma maradt.
// =============================================================================

// Touch-eszköz heurisztika: az ELSŐDLEGES vezérlés ujj-e? A korábbi
// `navigator.maxTouchPoints > 0` HIBÁS volt: az érintőképernyős laptopok is
// jelentenek érintő-pontokat, így ott is felugrott a mobil-vezérlés, pedig
// egérrel/billentyűzettel használják őket. A `(hover: none) and
// (pointer: coarse)` média-lekérdezés viszont az ELSŐDLEGES mutatóeszközt
// nézi: csak akkor igaz, ha az nem tud lebegni (nincs egér-hover) ÉS
// pontatlan (ujj) — vagyis valódi, érintés-elsődleges eszköz (telefon/tablet).
// Egy egeres (akár érintőképernyős) gépen `hover: hover` + `pointer: fine`,
// ezért ott helyesen HAMIS → marad a billentyűzetes vezérlés.
export function isTouchDevice() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

// Teljes képernyő kérése (Fullscreen API) — a verseny-indító gombok (Egyjátékos/
// Szoba létrehozása/Csatlakozás) kattintás-eseményéből hívjuk, MÉG a user-gesztus
// SZINKRON részéből, mert a böngésző csak közvetlenül egy felhasználói
// interakcióból engedi a kérést. Androidon (Chrome) ez azonnal eltünteti a
// böngésző-sávot. iOS Safari-n (iPhone) a Fullscreen API NEM támogatott — ott
// ez csendben nem csinál semmit; ott csak a "Kezdőképernyőhöz adás" ad valódi
// teljes képernyőt (lásd index.html web-manifest + apple-mobile-web-app-*
// meta tagek). Nem kritikus funkció — minden hiba/elutasítás csendben elnyelve.
export function requestFullscreen() {
  if (document.fullscreenElement) return;
  const el = document.documentElement;
  try {
    const req = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
    if (req && typeof req.catch === 'function') req.catch(() => {});
  } catch {
    /* nem kritikus — a játék teljes képernyő nélkül is működik */
  }
}

export function createTouchControls() {
  // A GOMBOK nyers állapota (amit az ujjak épp nyomnak). A `readInput()` ebből
  // származtatja a játék-inputot — ott kapja meg a boost a gáz-hatást is.
  const state = { up: false, down: false, left: false, right: false, drift: false, boost: false };

  const root = document.createElement('div');
  root.id = 'touchControls';
  // Elrendezés (fekvő telefon): BAL hüvelyk = kormány, JOBB hüvelyk = pedálok.
  // A jobb oldali 2×2 rácsban a BOOST pontosan a GÁZ FÖLÖTT ül (azonos
  // szélességgel), hogy az ujj egyenesen felfelé csúsztatva elérje.
  root.innerHTML = `
    <div class="tc-group tc-group-left">
      <button type="button" class="tc-btn tc-steer" data-key="left" aria-label="Balra">◀</button>
      <button type="button" class="tc-btn tc-steer" data-key="right" aria-label="Jobbra">▶</button>
    </div>
    <div class="tc-group tc-group-right">
      <div class="tc-row">
        <button type="button" class="tc-btn tc-drift" data-key="drift" aria-label="Drift">DRIFT</button>
        <button type="button" class="tc-btn tc-boost" data-key="boost" aria-label="Boost (gázzal együtt)">
          <span class="tc-fuel"></span><span class="tc-label">🔥 BOOST</span>
        </button>
      </div>
      <div class="tc-row">
        <button type="button" class="tc-btn tc-brake" data-key="down" aria-label="Fék/tolatás">▼</button>
        <button type="button" class="tc-btn tc-gas" data-key="up" aria-label="Gyorsítás">▲</button>
      </div>
      <div class="tc-hint" aria-hidden="true">
        <span class="tc-hint-arrow">⌃</span>
        <span class="tc-hint-arrow">⌃</span>
        <span class="tc-hint-arrow">⌃</span>
      </div>
    </div>
  `;

  document.body.appendChild(root);
  // A CSS ennek jelenlétéhez köti a mobil-elrendezést (lásd index.html) —
  // pl. a billentyű-jelmagyarázat elrejtését és a HUD-elemek átrendezését,
  // hogy ne fedjék egymást a képernyő alján lévő gombokkal.
  document.body.classList.add('has-touch-controls');

  const buttons = Array.from(root.querySelectorAll('.tc-btn'));
  const boostBtn = root.querySelector('.tc-boost');

  // "HÚZD FEL A BOOSTRA" tanító-nyilak. A gázról a boostra való ÁTCSÚSZTATÁS a
  // mobil-vezérlés legfontosabb, de leginkább REJTETT képessége — több, egymás
  // után felfelé úszó nyíl mutatja a gáz és a boost közti utat.
  //
  // MINDEN FUTAM ELEJÉN újra megjelenik (a `show()`-ból indul, ami versenyenként
  // egyszer fut) — szándékosan NINCS "egyszer megtanulta, soha többé" tárolás.
  // A futamon BELÜL viszont eltűnik, amint a játékos ténylegesen boostolt
  // (fölösleges tovább mutatni), illetve HINT_SECONDS után magától, hogy ne
  // animáljon végig a verseny alatt a szeme sarkában.
  const HINT_SECONDS = 14;
  const hintEl = root.querySelector('.tc-hint');
  let hintTimer = null;
  function stopHint() {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (hintEl) hintEl.classList.remove('on');
  }
  function startHint() {
    if (!hintEl) return;
    hintEl.classList.add('on');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(stopHint, HINT_SECONDS * 1000);
  }

  // A gombok képernyő-téglalapjai, gyorsítótárazva — a pointermove percenként
  // több százszor is lefut, ott már NEM hívunk getBoundingClientRect-et.
  // Újraszámolás: lenyomáskor (ritka), illetve átméretezés/tájolás-váltáskor.
  let rects = [];
  function refreshRects() {
    rects = buttons.map((el) => ({ el, key: el.dataset.key, r: el.getBoundingClientRect() }));
  }
  refreshRects();
  window.addEventListener('resize', refreshRects);
  window.addEventListener('orientationchange', refreshRects);

  // A gombok közti RÉSEK áthidalása: nem szigorú "benne van-e a téglalapban"
  // tesztet végzünk, hanem a legKÖZELEBBI gombot választjuk, ha a távolság a
  // toleranciát nem lépi túl (a téglalapon BELÜL a távolság 0, tehát az mindig
  // nyer). Enélkül a gáz → boost átcsúsztatás közben a 10 px-es vizuális rés
  // fölött egy pillanatra MINDEN gomb elengedettnek látszana — vagyis a gáz
  // megszakadna épp a boost aktiválása közben.
  const HIT_TOLERANCE = 8; // px
  function hitTest(x, y) {
    let bestKey = null;
    let bestDist = Infinity;
    for (const b of rects) {
      const r = b.r;
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        bestKey = b.key;
      }
    }
    return bestDist <= HIT_TOLERANCE ? bestKey : null;
  }

  // pointerId → épp NYOMOTT gomb kulcsa (vagy null, ha az ujj lecsúszott a
  // gombokról, de még a képernyőn van). Több ujj egyszerre is lehet.
  const active = new Map();

  function syncState() {
    for (const k of Object.keys(state)) state[k] = false;
    for (const key of active.values()) if (key) state[key] = true;
    for (const b of rects) b.el.classList.toggle('active', state[b.key]);
    // A tanító-nyilak eltűnnek, amint a játékos EBBEN a futamban boostolt —
    // mindegy, hogy rányomtak vagy a gázról CSÚSZTATTÁK rá (ezért itt, a közös
    // állapot-szinkronban figyeljük, nem a pointerdown-ban).
    if (state.boost) stopHint();
  }

  root.addEventListener(
    'pointerdown',
    (e) => {
      const btn = e.target.closest?.('.tc-btn');
      if (!btn) return;
      e.preventDefault();
      refreshRects(); // a lenyomás ritka — itt még megengedhető a méréssel járó költség
      // A capture-t a LENYOMOTT gombra tesszük, hogy a további pointermove/up
      // biztosan hozzá (és onnan ide, a gyökérre buborékolva) érkezzen akkor is,
      // ha az ujj közben lecsúszik róla. A tényleges "melyik gomb" döntést
      // viszont MINDIG a koordináta adja (hitTest), nem a capture célpontja —
      // ettől működik az átcsúsztatás.
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* nem kritikus — a koordináta-alapú követés e nélkül is működik */
      }
      active.set(e.pointerId, hitTest(e.clientX, e.clientY));
      syncState();
    },
    { passive: false }
  );

  root.addEventListener(
    'pointermove',
    (e) => {
      if (!active.has(e.pointerId)) return;
      e.preventDefault();
      const key = hitTest(e.clientX, e.clientY);
      if (key !== active.get(e.pointerId)) {
        active.set(e.pointerId, key);
        syncState();
      }
    },
    { passive: false }
  );

  const endPointer = (e) => {
    if (!active.has(e.pointerId)) return;
    active.delete(e.pointerId);
    syncState();
  };
  root.addEventListener('pointerup', endPointer);
  root.addEventListener('pointercancel', endPointer);
  // Kontextusmenü/hosszan-nyomás (pl. iOS szöveg-kijelölés) letiltása.
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    // Új objektum minden hívásra — a hívó (main.js) biztonságosan tovább
    // olvaszthatja anélkül, hogy a belső state-et véletlenül módosítaná.
    // A BOOST teljes GÁZT is ad (lásd a fájl fejlécének 1. pontját).
    readInput: () => ({
      up: state.up || state.boost,
      down: state.down,
      left: state.left,
      right: state.right,
      drift: state.drift,
      boost: state.boost,
    }),
    // A boost-üzemanyag (0..1) KÖZVETLENÜL a boost-gombon jelenik meg (kifogyó
    // háttér-csík + kimerülten halvány gomb) — mobilon így nem kell egy külön
    // HUD-elemre pillantani a hüvelykujj alól (a külön #boostMeter touchon
    // ezért el is rejtődik, lásd index.html).
    setBoostFuel(frac) {
      if (!boostBtn) return;
      // 3 tizedesre kerekítve: képkockánként hívjuk, a 16 jegyű lebegőpontos
      // érték csak felesleges stílus-újraszámolást okozna, láthatóan semmit
      // nem adna hozzá.
      const f = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 1000;
      boostBtn.style.setProperty('--fuel', String(f));
      boostBtn.classList.toggle('empty', f <= 0.001);
    },
    show() {
      root.style.display = 'flex';
      refreshRects(); // a megjelenítés MOST adja meg a valódi méreteket
      startHint(); // gáz → boost átcsúsztatás tanító-nyilai (minden futam elején)
    },
    hide() {
      root.style.display = 'none';
      // Ha épp nyomva volt egy gomb, amikor elrejtettük (pl. célba érés
      // közben), ne maradjon "beragadva" a gáz/kormány a háttérben.
      active.clear();
      syncState();
      stopHint(); // a versenyen kívül ne fusson tovább az animáció/időzítő
    },
  };
}
