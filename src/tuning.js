// =============================================================================
//  AUTÓ-HANGOLÓ PANEL (dev mód) — élő csúszkák a CAR fizikai paramétereihez.
//
//  A csúszkák KÖZVETLENÜL a config.js CAR objektumát mutálják, a sim minden
//  lépésben onnan olvas → a változás azonnal érződik vezetés közben.
//
//  Mentés: localStorage-ba (dev-munkamenetek közt megmarad). A "másolás" gomb a
//  jelenlegi értékeket JSON-ként vágólapra teszi — így a végleges hangolás
//  beégethető a config.js-be (az élesíti a szerveren/multiplayerben is).
//
//  FONTOS: multiplayerben a helyi CAR-eltérés predikció-hibát okozna (a szerver
//  az alap értékekkel szimulál), ezért MP indulásakor visszaállunk az alapra
//  (resetCarToDefaults) és a panel elrejtődik — lásd main.js.
// =============================================================================
import { CAR } from './config.js';

const STORE_KEY = 'autos-jatek:carTuning';

// Az EREDETI (config.js-beli) értékek — a reset és az MP-visszaállás alapja.
const DEFAULTS = Object.freeze({ ...CAR });

// A hangolható mezők: kulcs a CAR-ban, felirat, tartomány, lépésköz.
const FIELDS = [
  { key: 'engineForce', label: 'Motorerő (N)', min: 2000, max: 15000, step: 250 },
  { key: 'brakeForce', label: 'Fékerő (N)', min: 4000, max: 25000, step: 500 },
  { key: 'maxForwardSpeed', label: 'Végsebesség (m/s)', min: 20, max: 60, step: 1 },
  { key: 'forwardDrag', label: 'Gördülési ellenállás', min: 0, max: 1, step: 0.02 },
  { key: 'maxSteerAngle', label: 'Kormányszög (rad)', min: 0.2, max: 1.2, step: 0.02 },
  { key: 'steerSpeed', label: 'Kormány be (rad/s)', min: 1, max: 20, step: 0.25 },
  { key: 'steerReturnSpeed', label: 'Kormány vissza (rad/s)', min: 1, max: 25, step: 0.25 },
  { key: 'wheelbase', label: 'Tengelytáv (m)', min: 1.2, max: 4.5, step: 0.1 },
  // A tapadási határ 100 felé húzva gyakorlatilag kikapcsol → a bicikli-modell
  // (kormányszög/tengelytáv) szabja a fordulást minden sebességen = a régi,
  // arcade-élességű érzés. A régi fix 3.2 rad/s ~ 90 m/s²-nek felelt meg 100 km/h-nál.
  { key: 'maxLateralAccel', label: 'Tapadási határ (m/s²)', min: 6, max: 100, step: 1 },
  { key: 'lateralGripDrift', label: 'Drift hátsó tapadás (szorzó)', min: 0.05, max: 0.8, step: 0.01 },
];

// A jelenlegi CAR-ból a hangolható mezők kigyűjtése (mentéshez/másoláshoz).
function currentValues() {
  const out = {};
  for (const f of FIELDS) out[f.key] = CAR[f.key];
  return out;
}

// Mentett hangolás alkalmazása a CAR-ra (indításkor, dev módban). Csak ismert
// kulcsokat és véges számokat veszünk át.
export function loadCarTuning() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const f of FIELDS) {
      if (Number.isFinite(saved[f.key])) CAR[f.key] = saved[f.key];
    }
  } catch {
    /* hibás mentés — marad az alap */
  }
}

// Vissza az eredeti config-értékekre (a mentést NEM törli — az a reset gomb dolga).
export function resetCarToDefaults() {
  Object.assign(CAR, DEFAULTS);
}

// A panel felépítése. Visszaad egy {show, hide} vezérlőt.
export function createTuningPanel() {
  const root = document.createElement('div');
  root.id = 'tuning';
  root.style.cssText = `
    position: fixed; right: 12px; bottom: 12px; z-index: 30;
    font-family: system-ui, sans-serif; font-size: 12px; color: #e8eaef;
    display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  `;

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = '🔧 Autó-hangolás';
  toggleBtn.style.cssText = `
    padding: 8px 12px; border: none; border-radius: 8px; cursor: pointer;
    background: #3a5a8f; color: #fff; font-weight: 600; font-size: 13px;
  `;

  const panel = document.createElement('div');
  panel.style.cssText = `
    display: none; flex-direction: column; gap: 4px; width: 290px;
    background: rgba(18, 20, 27, 0.92); border: 1px solid #33363f;
    border-radius: 10px; padding: 12px; max-height: 70vh; overflow-y: auto;
  `;

  const valueEls = new Map(); // key -> {slider, valEl}

  function fmt(v) {
    return Math.abs(v) >= 100 ? String(Math.round(v)) : String(+v.toFixed(2));
  }

  for (const f of FIELDS) {
    const row = document.createElement('div');
    const head = document.createElement('div');
    head.style.cssText = 'display:flex; justify-content:space-between; margin-top:4px;';
    const lab = document.createElement('span');
    lab.textContent = f.label;
    lab.style.color = '#a8adb8';
    const val = document.createElement('b');
    val.textContent = fmt(CAR[f.key]);
    head.appendChild(lab);
    head.appendChild(val);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = f.min;
    slider.max = f.max;
    slider.step = f.step;
    slider.value = CAR[f.key];
    slider.style.cssText = 'width:100%; accent-color:#3a9d40; cursor:pointer;';
    slider.addEventListener('input', () => {
      CAR[f.key] = parseFloat(slider.value);
      val.textContent = fmt(CAR[f.key]);
    });
    // FONTOS: fókuszban a csúszka elkapná a nyíl-billentyűket (amikkel vezetsz!)
    // — állítás után azonnal elengedjük a fókuszt.
    slider.addEventListener('change', () => slider.blur());

    row.appendChild(head);
    row.appendChild(slider);
    panel.appendChild(row);
    valueEls.set(f.key, { slider, val, fmt });
  }

  function refreshSliders() {
    for (const f of FIELDS) {
      const e = valueEls.get(f.key);
      e.slider.value = CAR[f.key];
      e.val.textContent = fmt(CAR[f.key]);
    }
  }

  const status = document.createElement('div');
  status.style.cssText = 'min-height:14px; color:#d9a03f; text-align:center; margin-top:6px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:6px; margin-top:8px;';
  const mkBtn = (label, bg) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `flex:1; padding:7px 4px; border:none; border-radius:7px; cursor:pointer; background:${bg}; color:#fff; font-weight:600;`;
    return b;
  };
  const saveBtn = mkBtn('💾 Mentés', '#2e7d32');
  const copyBtn = mkBtn('📋 Másolás', '#3a5a8f');
  const resetBtn = mkBtn('↩️ Alap', '#7d2e2e');

  saveBtn.addEventListener('click', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify(currentValues()));
    status.textContent = '✅ Elmentve (ebben a böngészőben).';
    setTimeout(() => (status.textContent = ''), 2500);
  });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(currentValues(), null, 2));
      status.textContent = '📋 Vágólapra másolva (JSON).';
    } catch {
      status.textContent = '⚠️ Vágólap nem elérhető.';
    }
    setTimeout(() => (status.textContent = ''), 2500);
  });
  resetBtn.addEventListener('click', () => {
    resetCarToDefaults();
    localStorage.removeItem(STORE_KEY);
    refreshSliders();
    status.textContent = '↩️ Alapértékek visszaállítva.';
    setTimeout(() => (status.textContent = ''), 2500);
  });

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(copyBtn);
  btnRow.appendChild(resetBtn);
  panel.appendChild(btnRow);
  panel.appendChild(status);

  toggleBtn.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'flex';
    refreshSliders();
  });

  root.appendChild(panel);
  root.appendChild(toggleBtn);
  document.body.appendChild(root);

  return {
    show() {
      root.style.display = 'flex';
    },
    hide() {
      root.style.display = 'none';
      panel.style.display = 'none';
    },
  };
}
