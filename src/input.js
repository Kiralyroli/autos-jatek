// Billentyűzet → semleges input-objektum, sima DOM eseményekkel (framework-mentes).
// Fontos: a kliens EZT az objektumot fogja a szervernek küldeni (3-4. fázis),
// ezért tartsuk minimálisnak és rendering-függetlennek.

// "Nincs input" — pl. visszaszámlálás alatt ezt kapja az autó a billentyűk helyett.
export const NEUTRAL_INPUT = Object.freeze({
  up: false,
  down: false,
  left: false,
  right: false,
  drift: false,
});

// --- Input ⇄ bitmaszk (hálózati küldéshez) ---
// A multiplayerben minden kliens elküldi a SAJÁT inputját is a pozíció mellett
// (lásd main.js mpSendState), hogy a többiek gépe az autóját a VALÓDI fizikán
// tudja továbbszimulálni (net/remoteCars.js) — így a távoli autó igazi ívet ír
// le, nem egyenes vonalban "csúszik". Egyetlen kis egész szám, hogy a 60 Hz-es
// küldés se terhelje a sávot.
const BIT_UP = 1;
const BIT_DOWN = 2;
const BIT_LEFT = 4;
const BIT_RIGHT = 8;
const BIT_DRIFT = 16;

export function encodeInput(i) {
  return (
    (i.up ? BIT_UP : 0) |
    (i.down ? BIT_DOWN : 0) |
    (i.left ? BIT_LEFT : 0) |
    (i.right ? BIT_RIGHT : 0) |
    (i.drift ? BIT_DRIFT : 0)
  );
}

export function decodeInput(m) {
  const b = Number.isFinite(m) ? m : 0;
  return {
    up: (b & BIT_UP) !== 0,
    down: (b & BIT_DOWN) !== 0,
    left: (b & BIT_LEFT) !== 0,
    right: (b & BIT_RIGHT) !== 0,
    drift: (b & BIT_DRIFT) !== 0,
  };
}

const KEYMAP = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['Space'],
};

// Feliratkozik a billentyű-eseményekre, és egy readInput() függvényt ad vissza,
// ami az aktuális állapot pillanatképét adja.
export function createKeyboard(target = window) {
  const down = new Set();

  target.addEventListener('keydown', (e) => {
    down.add(e.code);
    // A Space ne görgesse az oldalt, a nyilak se.
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
  target.addEventListener('keyup', (e) => down.delete(e.code));
  // Fókuszvesztéskor (tabváltás) minden billentyűt elengedettnek veszünk,
  // különben "beragadna" a gáz.
  window.addEventListener('blur', () => down.clear());

  const has = (codes) => codes.some((c) => down.has(c));

  return function readInput() {
    return {
      up: has(KEYMAP.up),
      down: has(KEYMAP.down),
      left: has(KEYMAP.left),
      right: has(KEYMAP.right),
      drift: has(KEYMAP.drift),
    };
  };
}
