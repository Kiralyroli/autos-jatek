// =============================================================================
//  KAROSSZÉRIA-DŐLÉS (body roll/pitch) — tisztán VIZUÁLIS, a fizikát (Planck
//  body) nem érinti. A kocsi 3D-modelljét (carMesh) kanyarban oldalra, gáz/fék
//  alatt előre/hátra biccenti — a hangolható értékek: config.js LEAN.
//
//  A carMesh.rotation.y-t a hívó (main.js) minden képkockában közvetlenül a
//  fizikai szögből állítja (rotation.y = -angle) — ez a modul a MARADÉK két
//  Euler-komponenst (x = pitch, z = roll) írja, a Three.js alapértelmezett
//  'XYZ' sorrendje miatt a kettő nem zavarja egymást.
// =============================================================================
import { LEAN } from '../config.js';

export function createCarLean() {
  let roll = 0;
  let pitch = 0;

  // `mesh`: a kocsi Three.js gyökere (carMesh vagy egy távoli autó group-ja).
  // `speed`: haladási sebesség (m/s, előjeles — lásd sim/car.js forwardSpeed).
  // `steerAngle`: az AKTUÁLIS kormányszög (rad — drive.steer).
  // `accelerating`/`braking`: bool (input.up / ténylegesen fékező input.down).
  return function update(mesh, speed, steerAngle, accelerating, braking, dt) {
    const speedFactor = Math.min(1, Math.abs(speed) / LEAN.speedRef);
    const rollTarget = -steerAngle * LEAN.rollPerRad * speedFactor;
    const pitchTarget = accelerating ? -LEAN.pitchAccel : braking ? LEAN.pitchBrake : 0;

    const t = 1 - Math.exp(-LEAN.stiffness * dt);
    roll += (rollTarget - roll) * t;
    pitch += (pitchTarget - pitch) * t;

    mesh.rotation.z = roll;
    mesh.rotation.x = pitch;
  };
}
