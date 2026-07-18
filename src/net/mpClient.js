// =============================================================================
//  MULTIPLAYER KLIENS-RÉTEG — Colyseus kapcsolat + snapshot-puffer.
//
//  A szerver az "igazság": mi csak inputot küldünk ('input' üzenet), és a
//  'snapshot' pillanatképekből renderelünk. A simításhoz a klienst szándékosan
//  NET.interpDelayMs-nyivel a múltban tartjuk, és a két környező snapshot közt
//  lineárisan interpolálunk (entity interpolation — Gambetta-cikksorozat).
// =============================================================================
import { Client } from 'colyseus.js';
import { NET } from '../config.js';
import { lerp, lerpAngle } from '../utils.js';

// Csatlakozás + szoba létrehozás/belépés. Visszatérés: a Colyseus room objektum.
export async function createRoom({ name, layout, decorations, laps, carIdx, physics, trackName }) {
  const client = new Client(NET.serverUrl);
  return client.create('race', { name, layout, decorations, laps, carIdx, physics, trackName });
}

export async function joinRoom(code, { name, carIdx }) {
  const client = new Client(NET.serverUrl);
  return client.joinById(code.trim(), { name, carIdx });
}

// Snapshot-puffer: a pillanatképeket a SZERVER szimulációs időbélyegével (data.t)
// rendezzük, és a renderelés a "becsült szerver-most − interpDelay" időpontra kér
// interpolált állapotot. FONTOS: nem a fogadás helyi idejével dolgozunk — a hálózati
// csomagok löketekben érkezhetnek (két, sim-időben 50ms-ra lévő snapshot akár 2ms
// különbséggel), ami a fogadási-idős idővonalat összenyomná/megnyújtaná → szaggatás.
// A helyi és a szerver-óra közti eltolást EMA-val simítva becsüljük.
export function createSnapshotBuffer() {
  const snaps = []; // { t: szerver-sim-idő (ms), data }
  let clockOffset = null; // performance.now() − szerver-idő becslés (EMA-simított)

  function push(data) {
    const off = performance.now() - data.t;
    clockOffset = clockOffset === null ? off : clockOffset * 0.9 + off * 0.1;
    snaps.push({ t: data.t, data });
    if (snaps.length > 30) snaps.shift();
  }

  // A renderidőre eső két snapshot közt interpolált játékos-állapotok.
  // Visszatérés: { phase, countdownLeft, players: Map<id, {x,y,angle,...}> } vagy null.
  function sample() {
    if (snaps.length === 0) return null;
    // Szerver-idővonalon járunk: becsült szerver-most, mínusz az interp-késleltetés.
    const rt = performance.now() - clockOffset - NET.interpDelayMs;

    // A legfrissebb, rt-nél NEM újabb snapshot indexe.
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].t > rt) i--;
    const s0 = snaps[i];
    const s1 = snaps[Math.min(i + 1, snaps.length - 1)];
    const span = s1.t - s0.t;
    const t = span > 1 ? Math.min(1, Math.max(0, (rt - s0.t) / span)) : 1;

    const players = {};
    for (const [id, p1] of Object.entries(s1.data.players)) {
      const p0 = s0.data.players[id] || p1;
      players[id] = {
        ...p1, // név/kör/idők a frissebből (nem interpolálandó adatok)
        x: lerp(p0.x, p1.x, t),
        y: lerp(p0.y, p1.y, t),
        angle: lerpAngle(p0.angle, p1.angle, t),
      };
    }
    return {
      phase: s1.data.phase,
      countdownLeft: s1.data.countdownLeft,
      raceTime: s1.data.raceTime,
      players,
    };
  }

  return { push, sample, get latest() { return snaps[snaps.length - 1]?.data || null; } };
}

// Input-küldő: csak változáskor küld, plusz ritka "heartbeat" (elveszett csomag ellen).
export function createInputSender(room) {
  let last = '';
  let lastSentAt = 0;
  return function sendInput(input) {
    const key = `${+input.up}${+input.down}${+input.left}${+input.right}${+input.drift}`;
    const now = performance.now();
    if (key !== last || now - lastSentAt > 200) {
      room.send('input', input);
      last = key;
      lastSentAt = now;
    }
  };
}
