// =============================================================================
//  HANG — Web Audio API. Ha van valós hangfájl (ASSETS.sounds), azt loopoljuk;
//  különben SZINTETIZÁLT hang (oszcillátor/zaj). A game loop nem tud a különbségről:
//  minden hangforrás közös interfészt ad (update / setGain / dispose).
//
//  Böngésző-szabály: az AudioContext csak VALÓDI felhasználói gesztus után indul,
//  ezért az első billentyű/kattintás feloldja (resume).
// =============================================================================
import { AUDIO, ASSETS } from './config.js';

// Egy hangfájl betöltése és dekódolása. Siker: AudioBuffer, hiba/hiány: null.
// A url gyökér-relatív ('/assets/...') — BASE_URL-lel prefixelve, hogy GitHub
// Pages al-útvonalán (/autos-jatek/) is a helyes helyre mutasson (lásd
// render3d/assets.js withBase ugyanerről).
async function loadSound(ctx, url) {
  try {
    const res = await fetch(import.meta.env.BASE_URL.replace(/\/$/, '') + url);
    if (!res.ok) return null;
    return await ctx.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// --- MOTOR: szintetizált (fűrészfog + aluláteresztő) ---
function createSynthEngine(ctx, out) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = AUDIO.engine.baseFreq;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 900;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(filter).connect(gain).connect(out);
  osc.start();
  return {
    update(speedKmh, throttle) {
      const t = ctx.currentTime;
      osc.frequency.setTargetAtTime(AUDIO.engine.baseFreq + speedKmh * AUDIO.engine.freqPerKmh, t, 0.05);
      gain.gain.setTargetAtTime(AUDIO.engine.idleGain + (throttle ? AUDIO.engine.throttleGain : 0), t, 0.06);
    },
    dispose() {
      osc.stop();
      gain.disconnect();
    },
  };
}

// --- MOTOR: valós felvétel loopolva, sebességgel pitch-elve ---
function createSampleEngine(ctx, out, buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(out);
  src.start();
  return {
    update(speedKmh, throttle) {
      const t = ctx.currentTime;
      const rate = AUDIO.engine.samplePitchBase + speedKmh * AUDIO.engine.samplePitchPerKmh;
      src.playbackRate.setTargetAtTime(rate, t, 0.05);
      gain.gain.setTargetAtTime(AUDIO.engine.idleGain + (throttle ? AUDIO.engine.throttleGain : 0), t, 0.06);
    },
    dispose() {
      src.stop();
      gain.disconnect();
    },
  };
}

// --- CSIKORGÁS: szintetizált (sávszűrt fehérzaj) ---
function createSynthSkid(ctx, out) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1600;
  filter.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(out);
  src.start();
  return {
    setGain(g) {
      gain.gain.setTargetAtTime(g, ctx.currentTime, 0.04);
    },
    dispose() {
      src.stop();
      gain.disconnect();
    },
  };
}

// --- CSIKORGÁS: valós felvétel loopolva ---
function createSampleSkid(ctx, out, buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(out);
  src.start();
  return {
    setGain(g) {
      gain.gain.setTargetAtTime(g, ctx.currentTime, 0.04);
    },
    dispose() {
      src.stop();
      gain.disconnect();
    },
  };
}

export function createAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = AUDIO.masterVolume;
  master.connect(ctx.destination);

  // Kezdetben szintetizált (azonnal működik); a valós hangok betöltés után cserélik.
  let engine = createSynthEngine(ctx, master);
  let skid = createSynthSkid(ctx, master);

  (async () => {
    const [engBuf, skidBuf] = await Promise.all([
      loadSound(ctx, ASSETS.sounds.engine),
      loadSound(ctx, ASSETS.sounds.skid),
    ]);
    if (engBuf) {
      engine.dispose();
      engine = createSampleEngine(ctx, master, engBuf);
    }
    if (skidBuf) {
      skid.dispose();
      skid = createSampleSkid(ctx, master, skidBuf);
    }
  })();

  let muted = false;
  const resume = () => {
    if (ctx.state === 'suspended') ctx.resume();
  };
  ['keydown', 'pointerdown'].forEach((e) => window.addEventListener(e, resume));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') {
      muted = !muted;
      master.gain.setTargetAtTime(muted ? 0 : AUDIO.masterVolume, ctx.currentTime, 0.02);
    }
  });

  function beep(freq, duration = 0.18, type = 'square') {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(AUDIO.beepGain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + duration + 0.03);
  }

  function update({ speedKmh, throttle, corneringLoad }) {
    engine.update(speedKmh, throttle);
    const { startLoad, fullLoad, maxGain } = AUDIO.skid;
    const t = Math.max(0, Math.min(1, (corneringLoad - startLoad) / (fullLoad - startLoad)));
    skid.setGain(t * maxGain);
  }

  return { beep, update, ctx, master };
}
