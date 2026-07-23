// =============================================================================
//  ÉRINTŐS VEZÉRLÉS — mobil/touch eszközökön a billentyűzet mellett/helyett.
//  Ugyanazt a semleges input-alakot adja, mint input.js readInput()-ja
//  (up/down/left/right/drift), hogy main.js egyszerűen ÖSSZE tudja olvasztani
//  (OR) a kettőt — egy eszközön akár mindkettő egyszerre is használható.
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

export function createTouchControls() {
  const state = { up: false, down: false, left: false, right: false, drift: false };

  const root = document.createElement('div');
  root.id = 'touchControls';
  root.innerHTML = `
    <div class="tc-group tc-group-left">
      <button type="button" class="tc-btn tc-steer" data-key="left" aria-label="Balra">◀</button>
      <button type="button" class="tc-btn tc-steer" data-key="right" aria-label="Jobbra">▶</button>
    </div>
    <div class="tc-group tc-group-right">
      <button type="button" class="tc-btn tc-drift" data-key="drift" aria-label="Drift">DRIFT</button>
      <div class="tc-pedals">
        <button type="button" class="tc-btn tc-brake" data-key="down" aria-label="Fék/tolatás">▼</button>
        <button type="button" class="tc-btn tc-gas" data-key="up" aria-label="Gyorsítás">▲</button>
      </div>
    </div>
  `;

  // Pointer Events (nem touchstart/end) — egyszerre kezeli az egeret ÉS az
  // ujjakat, és setPointerCapture-rel akkor is megbízhatóan felenged, ha az
  // ujj lecsúszik a gombról (nem csak pontos touchend-nél a gomb fölött).
  root.querySelectorAll('.tc-btn').forEach((btn) => {
    const key = btn.dataset.key;
    const press = (e) => {
      e.preventDefault();
      // A pointer-capture azt biztosítja, hogy a felengedés (pointerup) akkor is
      // ehhez a gombhoz érkezzen, ha az ujj közben lecsúszott róla — DE csak
      // "kiegészítés": ha valamiért nem sikerül (pl. a pointerId már nem aktív),
      // az input-állapotot AKKOR IS be kell állítani, különben a gomb néma marad.
      // Ezért try/catch-ben van, és a state/osztály tőle FÜGGETLENÜL frissül.
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* nem kritikus — a lenti állapot-frissítés a lényeg */
      }
      state[key] = true;
      btn.classList.add('active');
    };
    const release = (e) => {
      e.preventDefault();
      state[key] = false;
      btn.classList.remove('active');
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    // Kontextusmenü/hosszan-nyomás (pl. iOS szöveg-kijelölés) letiltása a gombon.
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  document.body.appendChild(root);
  // A CSS ennek jelenlétéhez köti a mobil-elrendezést (lásd index.html) —
  // pl. a billentyű-jelmagyarázat elrejtését és a HUD-elemek átrendezését,
  // hogy ne fedjék egymást a képernyő alján lévő gombokkal.
  document.body.classList.add('has-touch-controls');

  return {
    // Új objektum minden hívásra — a hívó (main.js) biztonságosan tovább
    // olvaszthatja anélkül, hogy a belső state-et véletlenül módosítaná.
    readInput: () => ({ ...state }),
    show() {
      root.style.display = 'flex';
    },
    hide() {
      root.style.display = 'none';
      // Ha épp nyomva volt egy gomb, amikor elrejtettük (pl. célba érés
      // közben), ne maradjon "beragadva" a gáz/kormány a háttérben.
      state.up = state.down = state.left = state.right = state.drift = false;
    },
  };
}
