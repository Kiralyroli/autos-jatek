// Közös matek-segédek (sim- és render-oldalon is használhatók).

// Lineáris interpoláció.
export const lerp = (a, b, t) => a + (b - a) * t;

// Előjeles legrövidebb szögkülönbség: b − a, [−π, π] tartományba normálva.
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Szög-interpoláció a legrövidebb úton (kezeli a ±π körüli átfordulást).
export function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}
