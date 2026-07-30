// Chase kamera: az autó mögött-fölött lebeg, simított követéssel.
// A paraméterek a config.js CAMERA blokkjában hangolhatók.
//
// Az oldalirányú lengés kulcsa: a kamera FORGÁSÁT (yaw) külön, lassabban simítjuk,
// mint a pozícióját. A kocsi hirtelen elfordulása így nem rántja oldalra a kamerát
// a "distance" hosszú karon — a kamera saját, simított szöge fordul lomhán utána,
// és a pozíció + nézési pont is EBBŐL a simított szögből épül (együtt fordul a rig).
import * as THREE from 'three';
import { CAMERA } from '../config.js';
import { lerpAngle, angleDelta } from '../utils.js';

export function createChaseCamera(camera) {
  const camPos = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  let yaw = null; // a kamera saját, simított iránya (nem a kocsié!)
  let fov = camera.fov; // a JELENLEGI (simított) látószög — boostnál kitágul

  // carX/carZ: az autó pozíciója a talajsíkon; angle: a fizikai (2D) szög;
  // boosting: épp aktív-e a boost (lásd sim/car.js drive.boosting) — enyhén
  // kitágítja a látószöget, klasszikus "sebesség-érzet" trükk.
  return function updateCamera(carX, carZ, angle, dt, boosting = false) {
    if (yaw === null) yaw = angle;

    // A látószög sima be-/kicsengéssel követi a boost állapotát — SOSEM ugrik,
    // a manuális kamera-beállítás (cameraSettings.js) bármikor felülírhatja
    // CAMERA.fov-ot, ezért mindig AHHOZ képest adjuk a bónuszt, nem egy
    // beégetett konstanshoz.
    const targetFov = CAMERA.fov + (boosting ? CAMERA.boostFovBonus : 0);
    const tf = 1 - Math.exp(-CAMERA.boostFovStiffness * dt);
    fov += (targetFov - fov) * tf;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // A kamera iránya lomhán fordul a kocsi tényleges szöge felé.
    const ty = 1 - Math.exp(-CAMERA.yawStiffness * dt);
    yaw = lerpAngle(yaw, angle, ty);

    // Lemaradás-korlát: tartós kanyarban a lomha követés állandósult lemaradása
    // akár 80°+ is lenne (oldalnézet!). Ha a különbség túllépi a maxYawLagDeg-et,
    // a kamerát "utánahúzzuk" a korlátig — puha marad, de sosem ragad oldalra.
    const maxLag = (CAMERA.maxYawLagDeg * Math.PI) / 180;
    const lag = angleDelta(yaw, angle); // mennyivel jár a kocsi a kamera előtt
    if (lag > maxLag) yaw = angle - maxLag;
    else if (lag < -maxLag) yaw = angle + maxLag;

    const fx = Math.cos(yaw);
    const fz = Math.sin(yaw);

    // Cél-pozíció: az autó MÖGÖTT a simított irány mentén, és FÖLÖTTE.
    desired.set(
      carX - fx * CAMERA.distance,
      CAMERA.height,
      carZ - fz * CAMERA.distance
    );

    // A pozíció szorosan követi a célt (a simítás lényegét már a yaw adja).
    const tp = 1 - Math.exp(-CAMERA.stiffness * dt);
    if (camPos.lengthSq() === 0) camPos.copy(desired);
    else camPos.lerp(desired, tp);

    camera.position.copy(camPos);
    // A nézési pont VÍZSZINTESEN a simított irányból (a látómező nem csapkod
    // kanyarban), FÜGGŐLEGESEN pedig a beállított LEFELÉ DŐLÉSBŐL (pitchDeg)
    // számolva: a kamera aktuális magasságából (camPos.y) annyival lejjebb
    // nézünk, hogy a látóirány pontosan pitchDeg fokkal a vízszintes alatt
    // legyen a lookAt-ig tartó vízszintes távolságon. Így a dőlés a
    // magasságtól/távolságtól FÜGGETLENÜL állítható.
    const horizDist = CAMERA.distance + CAMERA.lookAhead; // kamera→nézési pont vízszintes táv
    const lookY = camPos.y - horizDist * Math.tan((CAMERA.pitchDeg * Math.PI) / 180);
    lookAt.set(carX + fx * CAMERA.lookAhead, lookY, carZ + fz * CAMERA.lookAhead);
    camera.lookAt(lookAt);
  };
}
