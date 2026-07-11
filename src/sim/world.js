// Planck.js világ + determinisztikus fix-timestep léptető.
// Ebben a fájlban NINCS Phaser — a szerver (Node) is le tudja futtatni ugyanígy.
import { World, Vec2 } from 'planck';
import { SIM } from '../config.js';

// Top-down játék → nincs gravitáció.
export function createWorld() {
  return new World({ gravity: Vec2(0, 0) });
}

// Akkumulátoros fix-timestep léptető. A megjelenítés frame-ideje ingadozhat,
// de a fizika mindig SIM.fixedDt lépésekben halad → determinisztikus, és a
// 4. fázisban a szerver ugyanezt a léptetést tudja futtatni.
//
//   beforeStep(dt): a fizika-lépés ELŐTT fut (itt tesszük az inputot/erőket a testekre)
//   afterStep():    minden fizika-lépés UTÁN fut (itt rögzítjük az állapotot interpolációhoz)
//
// Visszatérési érték: alpha ∈ [0, 1) — a "maradék" idő a legutolsó fizikai lépés óta,
// fixedDt-re normálva. Ezzel a rendering interpolálni tud a legutolsó két állapot közt,
// így a mozgás sima marad akkor is, ha a képfrissítés nem esik egybe a fizika ütemével.
export function createStepper() {
  let accumulator = 0;

  return function step(world, frameDtSeconds, beforeStep, afterStep) {
    // Túl nagy frame-ugrást (pl. tabváltás) levágunk, hogy ne pörögjön el.
    accumulator += Math.min(frameDtSeconds, SIM.fixedDt * SIM.maxSubSteps);

    let sub = 0;
    while (accumulator >= SIM.fixedDt && sub < SIM.maxSubSteps) {
      beforeStep(SIM.fixedDt);
      world.step(SIM.fixedDt, SIM.velocityIterations, SIM.positionIterations);
      if (afterStep) afterStep();
      accumulator -= SIM.fixedDt;
      sub++;
    }

    return accumulator / SIM.fixedDt;
  };
}
