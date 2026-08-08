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

// --- BOOST: szintetizált "turbina" hang — magas-áteresztő szűrt zaj (rárohanó
// szél) + egy lassan emelkedő fűrészfog-oszcillátor (a "feltöltődés" érzete,
// mint egy spooling-up sugárhajtómű). Ugyanaz a setGain/dispose interfész,
// mint a csikorgásnál (createSynthSkid) — az audio.update() egyszerű ki/be
// kapcsolóként kezeli (lásd AUDIO.boost.riseTime a sima be-/kicsengésért).
function createSynthBoost(ctx, out) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 900;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noise.connect(noiseFilter).connect(noiseGain).connect(out);
  noise.start();

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 90;
  const oscGain = ctx.createGain();
  oscGain.gain.value = 0;
  osc.connect(oscGain).connect(out);
  osc.start();

  return {
    setActive(on) {
      const t = ctx.currentTime;
      const rise = AUDIO.boost.riseTime;
      noiseGain.gain.setTargetAtTime(on ? AUDIO.boost.gain : 0, t, rise);
      oscGain.gain.setTargetAtTime(on ? AUDIO.boost.gain * 0.5 : 0, t, rise);
      // "Felpörgés": bekapcsoláskor a frekvencia gyorsan felszalad ~280 Hz-re,
      // amíg aktív; kikapcsolva visszaesik alapjáratra.
      const targetFreq = on ? 280 : 90;
      osc.frequency.setTargetAtTime(targetFreq, t, on ? 0.12 : 0.2);
    },
    dispose() {
      noise.stop();
      osc.stop();
      noiseGain.disconnect();
      oscGain.disconnect();
    },
  };
}

// --- BOOST: valós felvétel — EGYSZERI "kitörés" hang (motor-begyújtás/nitro-
// lövellés), NEM loop (szemben az engine/skid mintákkal). Az AudioBufferSourceNode
// csak EGYSZER indítható, ezért minden boost-bekapcsoláskor ÚJAT hozunk létre és
// az elejéről indítjuk — így minden aktiválás friss "begyújtás"-nak hangzik, nem
// egy folytonos loop kellős közepéből folytatódik. Elengedéskor gyors, kattanás-
// mentes elhalkulással állítjuk le (nem egyből stop() — az durva vágást adna).
function createSampleBoost(ctx, out, buffer) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(out);
  let source = null;
  let active = false;

  function hardStop(node) {
    try {
      node.stop();
    } catch {
      /* már megállt/soha nem indult — nem kritikus */
    }
    node.disconnect();
  }

  return {
    setActive(on) {
      if (on === active) return; // csak ÁLLAPOTVÁLTÁSKOR reagál, nem minden frame-ben
      active = on;
      const t = ctx.currentTime;
      const rise = AUDIO.boost.riseTime;
      if (on) {
        source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.start(t);
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(AUDIO.boost.gain, t + rise);
      } else if (source) {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + rise);
        const toStop = source;
        source = null;
        setTimeout(() => hardStop(toStop), rise * 1000 + 30);
      }
    },
    dispose() {
      if (source) hardStop(source);
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
  let boost = createSynthBoost(ctx, master);
  // "Nincs üzemanyag" hiba-hang — NINCS szintetizált tartalék (apró, nem
  // kritikus UX-elem): amíg nem töltődött be, playBoostEmpty() csendben
  // kihagyja (lásd lent). Ugyanez a kerékcsere-hangnál (playPitStop) —
  // amíg nincs betöltve `pitStop.mp3`, egyszerűen néma marad.
  let boostEmptyBuffer = null;
  let pitStopBuffer = null;

  (async () => {
    const [engBuf, skidBuf, boostBuf, boostEmptyBuf, pitStopBuf] = await Promise.all([
      loadSound(ctx, ASSETS.sounds.engine),
      loadSound(ctx, ASSETS.sounds.skid),
      loadSound(ctx, ASSETS.sounds.boost),
      loadSound(ctx, ASSETS.sounds.boostEmpty),
      loadSound(ctx, ASSETS.sounds.pitStop),
    ]);
    if (engBuf) {
      engine.dispose();
      engine = createSampleEngine(ctx, master, engBuf);
    }
    if (skidBuf) {
      skid.dispose();
      skid = createSampleSkid(ctx, master, skidBuf);
    }
    if (boostBuf) {
      boost.dispose();
      boost = createSampleBoost(ctx, master, boostBuf);
    }
    boostEmptyBuffer = boostEmptyBuf;
    pitStopBuffer = pitStopBuf;
  })();

  // Egyszeri lejátszás — a boost() (createSampleBoost) NEM erre épül, mert az
  // folytonos (be/ki), ez viszont mindig a végéig lejátszandó "kattanás".
  function playBoostEmpty() {
    if (!boostEmptyBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = boostEmptyBuffer;
    const g = ctx.createGain();
    g.gain.value = AUDIO.boostEmpty.gain;
    src.connect(g).connect(master);
    src.start();
  }

  // Egyszeri lejátszás, amikor a boxban ÁLLVA a mérés ELINDUL (main.js hívja,
  // amikor a pitStopTimer 0-ból pozitívba vált) — UGYANAZ a minta, mint playBoostEmpty.
  function playPitStop() {
    if (!pitStopBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = pitStopBuffer;
    const g = ctx.createGain();
    g.gain.value = AUDIO.pitStop.gain;
    src.connect(g).connect(master);
    src.start();
  }

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

  function update({ speedKmh, throttle, corneringLoad, boosting }) {
    engine.update(speedKmh, throttle);
    const { startLoad, fullLoad, maxGain } = AUDIO.skid;
    const t = Math.max(0, Math.min(1, (corneringLoad - startLoad) / (fullLoad - startLoad)));
    skid.setGain(t * maxGain);
    boost.setActive(!!boosting);
  }

  return { beep, update, playBoostEmpty, playPitStop, ctx, master };
}
