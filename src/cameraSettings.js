// =============================================================================
//  KAMERA-BEÁLLÍTÓ — a játékos élőben állíthatja a chase kamera TÁVOLSÁGÁT,
//  MAGASSÁGÁT és LEFELÉ DŐLÉSÉT (szög). A csúszkák közvetlenül a config.js
//  CAMERA objektumát mutálják, amit a render3d/camera.js minden képkockában
//  olvas — így a hatás AZONNAL látszik verseny közben. A beállítás
//  localStorage-ba perzisztál, és induláskor visszatöltődik.
//
//  Mobil ÉS desktop: a panel egy oldalt megjelenő, kompakt overlay (a kocsi a
//  kép közepén marad, így vezetés-nézetből is látszik az állítás hatása); a
//  csúszkák nagy fogantyúval, touch-barát méretben.
// =============================================================================
import { CAMERA, CAMERA_DEFAULTS } from './config.js';

const STORAGE_KEY = 'autos-jatek:camera';

// Az állítható mezők tartományai (a csúszka min/max/lépés + a betöltött
// értékek érvényesség-ellenőrzése — hibás/kézzel írt localStorage ellen).
const FIELDS = {
  distance: { min: 3, max: 22, step: 0.5, label: 'Távolság', unit: 'm' },
  height: { min: 2, max: 16, step: 0.5, label: 'Magasság', unit: 'm' },
  pitchDeg: { min: 0, max: 55, step: 1, label: 'Szög (dőlés)', unit: '°' },
};

const clampField = (key, v) => {
  const f = FIELDS[key];
  if (!Number.isFinite(v)) return CAMERA_DEFAULTS[key];
  return Math.max(f.min, Math.min(f.max, v));
};

// Perzisztált beállítás betöltése a CAMERA-ba (induláskor, main.js hívja).
export function applyStoredCamera() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    for (const key of Object.keys(FIELDS)) {
      if (s[key] !== undefined) CAMERA[key] = clampField(key, s[key]);
    }
  } catch {
    /* hibás/hiányzó — marad a config alapértéke */
  }
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ distance: CAMERA.distance, height: CAMERA.height, pitchDeg: CAMERA.pitchDeg })
    );
  } catch {
    /* pl. privát mód / tele tároló — nem kritikus */
  }
}

// Létrehozza a 📷 gombot + a csúszkás panelt, bekötve a DOM-ba. Visszaad egy
// vezérlőt: show()/hide() a gomb láthatóságához (verseny közben látszik).
export function createCameraSettings() {
  const btn = document.createElement('button');
  btn.id = 'btnCamera';
  btn.type = 'button';
  btn.title = 'Kamera beállítása';
  btn.textContent = '📷';

  const panel = document.createElement('div');
  panel.id = 'cameraPanel';

  const rows = Object.entries(FIELDS)
    .map(
      ([key, f]) => `
      <label class="camRow">
        <span class="camLabel">${f.label} <b data-val="${key}"></b></span>
        <input type="range" data-key="${key}" min="${f.min}" max="${f.max}" step="${f.step}" />
      </label>`
    )
    .join('');

  panel.innerHTML = `
    <h3>📷 Kamera</h3>
    ${rows}
    <div class="camBtns">
      <button type="button" id="btnCameraReset">Alaphelyzet</button>
      <button type="button" id="btnCameraClose" class="primary">Kész</button>
    </div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const sliders = panel.querySelectorAll('input[type="range"]');
  const valEls = {};
  panel.querySelectorAll('[data-val]').forEach((el) => (valEls[el.dataset.val] = el));

  // A csúszkák + a mellettük lévő érték-kijelzők szinkronizálása a CAMERA-ból.
  function syncFromCamera() {
    sliders.forEach((sl) => {
      const key = sl.dataset.key;
      sl.value = String(CAMERA[key]);
      valEls[key].textContent = `${CAMERA[key]}${FIELDS[key].unit}`;
    });
  }

  sliders.forEach((sl) => {
    sl.addEventListener('input', () => {
      const key = sl.dataset.key;
      CAMERA[key] = clampField(key, parseFloat(sl.value));
      valEls[key].textContent = `${CAMERA[key]}${FIELDS[key].unit}`;
      persist();
    });
  });

  panel.querySelector('#btnCameraReset').addEventListener('click', () => {
    Object.assign(CAMERA, CAMERA_DEFAULTS);
    syncFromCamera();
    persist();
  });

  const open = () => {
    syncFromCamera();
    panel.classList.add('open');
  };
  const close = () => panel.classList.remove('open');
  btn.addEventListener('click', () => (panel.classList.contains('open') ? close() : open()));
  panel.querySelector('#btnCameraClose').addEventListener('click', close);

  return {
    show() {
      btn.style.display = 'flex';
    },
    hide() {
      btn.style.display = 'none';
      close();
    },
  };
}
