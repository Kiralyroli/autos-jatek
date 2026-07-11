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
