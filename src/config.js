// =============================================================================
//  KÖZPONTI KONFIG — minden hangolható paraméter EGY helyen.
//  A CLAUDE.md szerint az élvezhetőség ~90%-a itt dől el. Vite hot reloaddal
//  menet közben csavarhatsz rajta. Ne szórd szét ezeket a kódban!
// =============================================================================
import { loadCustomLayout } from './trackStorage.js';

// A 3D render méterben dolgozik (1 fizikai méter = 1 Three.js egység), nincs lépték.

// Chase kamera (az autó mögött-fölött) — hangolható. A distance/height/pitchDeg
// mezőket a játékos IS állíthatja élőben (lásd cameraSettings.js + a HUD 📷
// gombja); a beállítás localStorage-ba perzisztál és induláskor visszatöltődik.
export const CAMERA = {
  distance: 11, // m — ennyivel az autó MÖGÖTT (JÁTÉKOS-ÁLLÍTHATÓ)
  height: 5, // m — ennyivel az autó FÖLÖTT (JÁTÉKOS-ÁLLÍTHATÓ)
  pitchDeg: 14, // fok — a kamera LEFELÉ dőlése (JÁTÉKOS-ÁLLÍTHATÓ). A nézési pont
  //               függőleges helyét ebből számoljuk (lásd render3d/camera.js):
  //               0° ≈ vízszintesen előre néz, nagyobb érték = meredekebben lefelé.
  //               A 14°-os alap a korábbi fix (lookAt y=1) nézettel egyezik.
  lookAhead: 5, // m — a kamera ennyivel az autó ELÉ néz (jobb kilátás kanyarban)
  stiffness: 8.0, // 1/s — POZÍCIÓ-követés merevsége (szoros, hogy ne maradjon le)
  yawStiffness: 2.8, // 1/s — FORGÁS-követés merevsége. EZ szabja az oldalirányú lengést:
  //                     kisebb = lomhábban fordul a kocsi mögé (kevesebb oldalmozgás),
  //                     nagyobb = agresszívebben követi a kocsi orrát.
  maxYawLagDeg: 20, // fok — TARTÓS kanyarban ennél jobban nem maradhat le a kamera
  //                   a kocsi iránya mögött (enélkül hosszú kanyarban oldalnézetbe
  //                   ragadna). Kisebb = kanyarban is szinte előre nézel.
  fov: 65, // látószög fokban
  // BOOST-effekt: amíg boostolunk, a látószög enyhén kitágul (klasszikus
  // "sebesség-érzet" trükk versenyjátékokból) — sima be-/kicsengéssel, hogy ne
  // legyen szemet szúró ugrás. Lásd render3d/camera.js updateCamera.
  boostFovBonus: 9, // fok — ennyivel nő a fov teljes boost alatt
  boostFovStiffness: 7, // 1/s — milyen gyorsan simul a cél-fov felé
};

// A játékos által állítható kamera-mezők ALAPÉRTÉKEI — a beállító-panel
// "Alaphelyzet" gombja és az érvényes tartományok ellenőrzése ehhez nyúl.
export const CAMERA_DEFAULTS = {
  distance: CAMERA.distance,
  height: CAMERA.height,
  pitchDeg: CAMERA.pitchDeg,
};

// 3D falak megjelenése (a fizikát nem érinti — az élek a sim/track.js-ben vannak).
export const WALL3D = {
  height: 1.4, // m
  thickness: 0.5, // m
};

// Külső assetek (a felhasználó tölti le CC0 forrásból a public/assets/ mappába).
// Ha egy fájl HIÁNYZIK, a játék a beépített procedurális megjelenésre esik vissza.
// A skála/orientáció értékek a konkrét modellhez igazítandók (a fájl megérkezése után).
export const ASSETS = {
  car: {
    url: '/assets/car.glb',
    colormap: '/assets/car-colormap.png', // a Kenney színatlasz (kézzel töltjük rá)
    scale: 1, // finomhangoló az auto-skála felett (a valós méretre igazít maga)
    rotationY: Math.PI / 2, // a Kenney-autó orra a menetirányba (+x) nézzen
    yOffset: 0, // függőleges finomhangolás, hogy a kerék a talajon legyen
  },
  textures: {
    asphalt: '/assets/textures/asphalt.jpg',
    asphaltRepeat: 6, // hányszor ismétlődjön a textúra a pályán
    curb: '/assets/textures/curb.jpg', // fehér szegély-csík (render3d/trackRibbon.js)
    sky: '/assets/textures/sky.jpg', // égbolt-panoráma (equirektangulár, render3d/scene.js)
    grass: '/assets/textures/grass.jpg', // a Kenney grass.glb-csempék felülrétegzett textúrája
    grassRepeat: 0.3, // hányszor ismétlődjön a textúra egy fű-csempén belül (1 alatt = "ránagyítás", nagyobb léptékű minta)
  },
  sounds: {
    engine: '/assets/sounds/engine.wav', // loopolható motorhang (pitch = sebesség)
    skid: '/assets/sounds/skid.wav', // loopolható gumicsikorgás
    // Boost-hang — NEM loop, egyszeri "kitörés" (lásd CREDITS.md — CC-BY-NC 4.0,
    // az EGYETLEN nem-CC0/sima-CC-BY asset a projektben).
    boost: '/assets/sounds/boost.mp3',
    boostEmpty: '/assets/sounds/boostEmpty.flac', // "nincs üzemanyag" hiba-hang
  },
};

// Választható autók (menü autó-választó). A játékos-index (colorIdx a hálón) EZ a
// lista indexe — így multiplayerben mindenki a másik VÁLASZTOTT autóját látja.
//   model: a GLB útvonala.
//   preview: kis (64×64) kép-ikon a választó-kártyához (lásd main.js
//     renderCarSelectInto) — hogy a felhasználó LÁSSA, nem csak névből találgassa
//     az autót. A Kenney Car Kit hivatalos előnézeti képei (Previews/*.png).
//   color/icon: a névtábla/állás jelölőszíne és ikonja.
//   colormap: HA a modell TEXTÚRÁS (Car Kit) — ekkor a Kenney szín-atlaszt rá
//     kell tenni (lásd ASSETS.car.colormap — a teljes Car Kit EGY közös atlaszt
//     használ, minden modellnél ugyanaz a fájl). A Racing Kit versenyautói
//     TEXTÚRA NÉLKÜLIEK (anyag-baseColor a színük), nekik nincs colormap → a
//     natív színük marad. A kétféle Kit így KEVERHETŐ egy listában (lásd
//     main.js setPlayerCar/ensureMesh).
//
// A teljes Kenney Car Kit (public/assets/carkit/, felhasználó által letöltve és
// kicsomagolva) — minden benne lévő JÁRMŰ (kerék/roncs-darabok/doboz/kúp nélkül)
// választható.
export const CARS = [
  { name: 'Mentőautó', model: '/assets/carkit/ambulance.glb', preview: '/assets/carkit-previews/ambulance.png', color: '#e6e8ec', icon: '🚑', colormap: true },
  { name: 'Szállító furgon', model: '/assets/carkit/delivery.glb', preview: '/assets/carkit-previews/delivery.png', color: '#4caf6b', icon: '🚚', colormap: true },
  { name: 'Nyitott platós furgon', model: '/assets/carkit/delivery-flat.glb', preview: '/assets/carkit-previews/delivery-flat.png', color: '#e08a2a', icon: '🛻', colormap: true },
  { name: 'Tűzoltóautó', model: '/assets/carkit/firetruck.glb', preview: '/assets/carkit-previews/firetruck.png', color: '#e6432f', icon: '🚒', colormap: true },
  { name: 'Kukásautó', model: '/assets/carkit/garbage-truck.glb', preview: '/assets/carkit-previews/garbage-truck.png', color: '#3a9d40', icon: '🗑️', colormap: true },
  { name: 'Sport ferdehátú', model: '/assets/carkit/hatchback-sports.glb', preview: '/assets/carkit-previews/hatchback-sports.png', color: '#54c17a', icon: '🚗', colormap: true },
  { name: 'Gokart (levendula)', model: '/assets/carkit/kart-oobi.glb', preview: '/assets/carkit-previews/kart-oobi.png', color: '#b39ddb', icon: '🏎️', colormap: true },
  { name: 'Gokart (sárga)', model: '/assets/carkit/kart-oodi.glb', preview: '/assets/carkit-previews/kart-oodi.png', color: '#f4c542', icon: '🏎️', colormap: true },
  { name: 'Gokart (türkiz)', model: '/assets/carkit/kart-ooli.glb', preview: '/assets/carkit-previews/kart-ooli.png', color: '#4fd1c5', icon: '🏎️', colormap: true },
  { name: 'Gokart (lila)', model: '/assets/carkit/kart-oopi.glb', preview: '/assets/carkit-previews/kart-oopi.png', color: '#9575cd', icon: '🏎️', colormap: true },
  { name: 'Gokart (kék)', model: '/assets/carkit/kart-oozi.glb', preview: '/assets/carkit-previews/kart-oozi.png', color: '#64b5f6', icon: '🏎️', colormap: true },
  { name: 'Rendőrautó', model: '/assets/carkit/police.glb', preview: '/assets/carkit-previews/police.png', color: '#7e8ce0', icon: '🚓', colormap: true },
  { name: 'Versenyautó', model: '/assets/carkit/race.glb', preview: '/assets/carkit-previews/race.png', color: '#ff4b3e', icon: '🏁', colormap: true },
  { name: 'Futurisztikus versenyautó', model: '/assets/carkit/race-future.glb', preview: '/assets/carkit-previews/race-future.png', color: '#3b5bdb', icon: '🚀', colormap: true },
  { name: 'Szedán', model: '/assets/carkit/sedan.glb', preview: '/assets/carkit-previews/sedan.png', color: '#8f8fae', icon: '🚘', colormap: true },
  { name: 'Sport szedán', model: '/assets/carkit/sedan-sports.glb', preview: '/assets/carkit-previews/sedan-sports.png', color: '#ff6659', icon: '🚗', colormap: true },
  { name: 'Terepjáró', model: '/assets/carkit/suv.glb', preview: '/assets/carkit-previews/suv.png', color: '#6b8f71', icon: '🚙', colormap: true },
  { name: 'Luxus terepjáró', model: '/assets/carkit/suv-luxury.glb', preview: '/assets/carkit-previews/suv-luxury.png', color: '#5c527f', icon: '🚙', colormap: true },
  { name: 'Taxi', model: '/assets/carkit/taxi.glb', preview: '/assets/carkit-previews/taxi.png', color: '#ffd54f', icon: '🚕', colormap: true },
  { name: 'Traktor', model: '/assets/carkit/tractor.glb', preview: '/assets/carkit-previews/tractor.png', color: '#558b4f', icon: '🚜', colormap: true },
  { name: 'Rendőr-traktor', model: '/assets/carkit/tractor-police.glb', preview: '/assets/carkit-previews/tractor-police.png', color: '#9fa8da', icon: '🚔', colormap: true },
  { name: 'Homlokrakodó traktor', model: '/assets/carkit/tractor-shovel.glb', preview: '/assets/carkit-previews/tractor-shovel.png', color: '#6d9e5a', icon: '🚜', colormap: true },
  { name: 'Teherautó', model: '/assets/carkit/truck.glb', preview: '/assets/carkit-previews/truck.png', color: '#7c6fa8', icon: '🚛', colormap: true },
  { name: 'Nyitott platós teherautó', model: '/assets/carkit/truck-flat.glb', preview: '/assets/carkit-previews/truck-flat.png', color: '#5e8f6b', icon: '🚛', colormap: true },
  { name: 'Kisbusz', model: '/assets/carkit/van.glb', preview: '/assets/carkit-previews/van.png', color: '#4a6fdc', icon: '🚐', colormap: true },
];

// Hang (Web Audio API). Valós hangfájl HA van (ASSETS.sounds), különben szintetizált.
export const AUDIO = {
  masterVolume: 0.5,
  engine: {
    baseFreq: 55, // Hz — alapjárati "fordulat" (szintetizált motorhoz)
    freqPerKmh: 1.7, // Hz / km/h — hangmagasság-emelkedés (szintetizált)
    samplePitchBase: 0.7, // valós hanghoz: lejátszási ráta álló helyzetben
    samplePitchPerKmh: 0.011, // valós hanghoz: ráta-növekmény km/h-nként
    idleGain: 0.16, // álló motor zúgása
    throttleGain: 0.42, // gáznál mennyivel hangosabb
  },
  skid: {
    // "Kanyar-terhelés" = |sebesség(m/s) × kanyarodási ráta(rad/s)|. Ez vezérli a csikorgást:
    startLoad: 28, // e fölött kezd csikorogni (éles kanyar / drift)
    fullLoad: 95, // itt teljes hangerő
    maxGain: 0.3,
  },
  // BOOST: szintetizált "turbina/rárohanó szél" hang (magas-áteresztő szűrt zaj
  // + egy enyhén emelkedő oszcillátor a "feltöltődés" érzetéért) — lásd
  // audio.js createSynthBoost. Bekapcsolás/kikapcsolás gyors, de sima (nincs
  // kattanás), a drive.boosting állapotát követve.
  boost: {
    gain: 0.32,
    riseTime: 0.06, // s — a hangerő ilyen gyorsan éri el a célt (be- és ki is)
  },
  // "Nincs boost-üzemanyag" jelzés — egyszeri, rövid hiba-hang, amikor a
  // játékos megpróbál boostolni (gomb+gáz), de a tartály üres. Csak ÚJ
  // próbálkozásonként szólal meg (lásd main.js edge-detektálás), nem
  // ismétlődik folyamatosan, amíg a gombot nyomva tartja.
  boostEmpty: {
    gain: 0.5,
  },
  beepGain: 0.35, // visszaszámláló/GO bip hangereje
};

// Fizikai szimuláció — determinisztikus, fix timestep (szerver-kész).
export const SIM = {
  fixedDt: 1 / 60, // s — a fizika lépésköze (a rendszám ettől független)
  maxSubSteps: 5, // egy frame alatt max ennyi fizika-lépés (spirál elleni védelem)
  velocityIterations: 8,
  positionIterations: 3,
};

// Az autó minden paramétere. Mértékegységek: méter, kilogramm, másodperc.
export const CAR = {
  // Méret (m) — a "hossz" az autó előre iránya (lokális +x).
  length: 4.2,
  width: 2.0,
  density: 60, // kg/m² → ~2 t-s autó nagyságrend; a force-ok ehhez vannak hangolva

  // Hajtás (erő, N). A gyorsulás = erő / tömeg; a tömeg ~504 kg (density * terület).
  // engineForce 7000 → ~14 m/s² gyorsulás (fürge arcade, de nem repít el azonnal).
  engineForce: 7000, // gáz előre
  brakeForce: 12000, // fékerő, amíg előre halad
  reverseForce: 4000, // tolatás ereje álló/hátrameneti helyzetből
  coastBrakeForce: 3000, // cél után: lágy fékezés ereje (kicsi → "lassan" áll meg)

  // Sebességhatárok (m/s) — 1 m/s = 3.6 km/h
  maxForwardSpeed: 39, // ~140 km/h
  maxReverseSpeed: 10, // ~36 km/h

  // Kormányzás + tapadás — KÉTTENGELYES GUMI-MODELL (sim/car.js applyTireFriction).
  // Az autót az ELFORDÍTOTT ELSŐ KEREKEK oldalirányú tapadási impulzusa fordítja
  // (a hátsó tengely körül kanyarodik be, mint a valóságban) — nincs "beállított"
  // forgási ráta. A tapadási határ felett a gumi megcsúszik: elöl alulkormányzottság,
  // hátul (driftnél) kitörő far — mind a fizikából adódik.
  wheelbase: 2.6, // m — tengelytáv; a két tengelypont a tömegközépponttól ±wheelbase/2
  maxSteerAngle: 0.5, // rad (~29°) — a kerekek maximális elfordulása
  steerSpeed: 3.5, // rad/s — milyen gyorsan fordul BE a kormány (teljes kitérés ~0.15 s)
  steerReturnSpeed: 6.0, // rad/s — elengedéskor/ellenkormányzáskor gyorsabb visszaállás
  maxLateralAccel: 18, // m/s² (~1.8g, sportos) — kanyar-tapadási határ (tengelyenként a fele);
  //                      ez adja a minimális fordulókört: r = v²/a (pl. 20 m/s-nél ~22 m)
  lateralGripDrift: 0.28, // drift (Space): a HÁTSÓ tengely tapadás-szorzója — kézifék-effekt
  steerReleaseDamping: 0.9, // (coastToStop) cél utáni kigurulásnál a pörgés csillapítása / lépés

  // Gördülési/légellenállás (a forward sebességgel arányos fékező erő szorzója).
  // Kicsi érték: a csúcssebességet a maxForwardSpeed clamp adja, nem a drag.
  forwardDrag: 0.25,

  // BOOST — a gázerő és a csúcssebesség-határ szorzója, amíg a boost gomb
  // aktív (lásd sim/car.js updateBoost/applyDrive). MÉRVE (realistic preset):
  // 0->100 km/h 1.05s helyett 0.67s, csúcssebesség 216 helyett 248 km/h —
  // érezhetően erősebb, de nem irreális (egy valódi sportautó tartományában
  // marad). Csak GÁZZAL együtt hat (lásd applyDrive — a force csak input.up-nál
  // számít), tehát önmagában, gáz nélkül semmit nem csinál.
  boostForceMultiplier: 1.5,
  boostMaxSpeedMultiplier: 1.15,
};

// Választható autó-fizika előbeállítások (menü választó — a futam indításánál).
// Csak a MOZGÁSSAL kapcsolatos mezőket írják felül (a CAR többi mezője — méret,
// tömeg, tolatás-erő stb. — változatlan marad, lásd applyPhysicsPreset).
//   realistic: a valósághoz közelebbi arányok (nagyobb tengelytáv, mérsékeltebb tapadás).
//   light: könnyített/arcade — kisebb tengelytáv (élesebb fordulás), magas tapadási
//     határ (gyakorlatilag nincs csúszás-plafon), nincs gördülési ellenállás.
export const PHYSICS_PRESETS = {
  realistic: {
    engineForce: 15000,
    brakeForce: 12000,
    maxForwardSpeed: 60,
    forwardDrag: 0.25,
    maxSteerAngle: 0.5,
    steerSpeed: 3.5,
    steerReturnSpeed: 6,
    wheelbase: 2,
    maxLateralAccel: 50,
    lateralGripDrift: 0.28,
  },
  light: {
    engineForce: 8000,
    brakeForce: 12000,
    maxForwardSpeed: 40,
    forwardDrag: 0,
    maxSteerAngle: 0.5,
    steerSpeed: 3.5,
    steerReturnSpeed: 6,
    wheelbase: 1.2,
    maxLateralAccel: 100,
    lateralGripDrift: 0.28,
  },
};
export const DEFAULT_PHYSICS = 'realistic';

// Egy preset nevének validálása (ismeretlen/hiányzó → DEFAULT_PHYSICS). Mindkét
// oldal (kliens ÉS szerver) ezzel dönti el, melyik preset-tel fusson.
export function resolvePhysicsPreset(name) {
  return PHYSICS_PRESETS[name] ? name : DEFAULT_PHYSICS;
}

// A KLIENS oldali (egy lapon egyszerre csak EGY versenyt futtató) globális CAR
// mutálása egy preset-re — így a sim/car.js mindenhol (SP + a saját MP-predikció)
// a választott fizikával fut. Multiplayerben a SZERVER a saját (szobánkénti,
// KÜLÖN objektumba másolt — lásd server/RaceRoom.js) car-paraméterekkel dolgozik,
// mert a Node-folyamat egyszerre TÖBB szobát is kiszolgál, és a globális CAR
// mutálása azok között összeakadna. A kliens ide a szerver 'init' üzenetéből kapja
// vissza a ténylegesen használt preset nevét, hogy a predikció ne térjen el tőle.
export function applyPhysicsPreset(name) {
  const resolved = resolvePhysicsPreset(name);
  Object.assign(CAR, PHYSICS_PRESETS[resolved]);
  return resolved;
}

// A CAR alapértéke induláskor a DEFAULT_PHYSICS preset legyen (egységes forrás —
// a fenti mezőknél ne legyen eltérés a CAR literál és a preset között).
applyPhysicsPreset(DEFAULT_PHYSICS);

// Fű-büntetés: fizikai fal helyett ez tartja az autót a pályán. Azonnali váltás,
// nincs fokozatos átmenet: úton 100%, a fűre lépve azonnal grassThrottle-re esik,
// visszaérve az útra azonnal vissza 100%-ra. Amikor az autó ÁTLÉPI az útszélt (úton
// → fűre), a pillanatnyi sebesség is egyszeri esetben lecsökken entrySpeedFactor-ra.
export const OFFROAD = {
  grassThrottle: 0.1, // a gáz-szorzó a fűben (10%)
  entrySpeedFactor: 0.5, // a fűre lépés pillanatában a sebesség ennyire esik vissza (50%)
};

// Guminyom + porfelhő — tisztán VIZUÁLIS effektek (render3d/carEffects.js), a
// fizikát nem befolyásolják.
//
// A KÜSZÖB TÖRTÉNETE (MÉRT adatokból, nem tippelve — két hibás nekifutás után):
//  1. Először 1.5 m/s volt — TÚL magas, csak a legdurvább driftnél jelent meg
//     bármi (élő visszajelzés: "jöjjön enyhébb forduláskor is").
//  2. Lejjebb vittem 0.6-ra + egy minForwardSpeed=12 sebesség-kaput vezettem be,
//     mert azt hittem, a kormányzás/gyorsítás ÁTMENETI szakaszában (a kormányszög
//     még ramp-el, lásd updateSteerAngle) keletkező, drift NÉLKÜLI |lateralSpeed|-
//     tüske ALACSONY SEBESSÉGHEZ kötött — TÉVESEN: méréssel kiderült, hogy ez a
//     tranziens BÁRMILYEN sebességnél ugyanúgy jelentkezik (a kormány VÁLTOZÁSÁHOZ
//     kötődik, nem a sebességhez), a sebesség-kapu pedig a VALÓDI driftet is
//     elnémította, ha menet közben (pl. kicsúszáskor) a haladási sebesség a kapu
//     alá esett — élő visszajelzés: "nagyobb sebességnél semmit nem hagy, picike
//     kis fordulásoknál meg hagy" — pontosan fordítva a kívánttól.
//  3. A VALÓDI elválasztó jel a CSÚCS NAGYSÁGA, nem a sebesség: a driftmentes
//     tranziens abszolút csúcsa (sok induló-sebességgel, mindhárom fizika-
//     preset-tel mérve) 2.56-2.65 m/s, FÜGGETLENÜL a sebességtől — egy VALÓDI,
//     akár csak 0.25s-os driftkoppintás viszont MINDIG legalább ~9 m/s-ot ér el
//     (rövidebb, ~0.1-0.15s-os koppintásoknál a drift még nem "kap el", de az
//     ilyen villanásnyi driftet a valóságban sem látnánk nyomként). A
//     minLateralSpeed ezért a tranziens csúcsa FÖLÉ, de a legrövidebb értelmes
//     drift alá esik — sebesség-kapu NÉLKÜL, hogy driftkor a sebesség-ingadozás
//     (kicsúszásnál a haladási sebesség csökkenhet/negatívba fordulhat) ne tudja
//     tévesen megszakítani a nyomot.
//
// MÁSODIK KIVÁLTÓ OK — "erőteljes kanyarodás" driftelés NÉLKÜL is: a fenti
// lateralSpeed-alapú jel KIZÁRÓLAG a tapadás ELVESZTÉSÉT (drift) méri — teljes
// tapadású kanyarban ez akkor is nullához közeli marad, ha az autó a sebesség-
// határon egyensúlyoz (mérve: 60 m/s-on, éles kanyarban is |lateralSpeed|~0.16
// m/s). Erre a corneringLoad (=|forwardSpeed×szögsebesség|, sim/car.js — a
// gumicsikorgás hangeffektje is EZT használja) ad jó jelet, mert a kanyarodás
// INTENZITÁSÁVAL skálázódik, tapadástól függetlenül. MÉRVE (kormány-kitérés
// arányában): enyhe (10-30%) kanyar átlaga 2-13, közepes-erős (50%+) 27-46 —
// az AUDIO.skid.startLoad=28 (ahol a csikorgás-hang elindul) pont a "már
// tényleg erőteljes" határon van, ezért ÚJRAHASZNOSÍTVA: a nyom és a hang
// egyszerre kezdődik.
export const EFFECTS = {
  skid: {
    minLateralSpeed: 4.0, // m/s — a driftmentes tranziens csúcsa (2.56-2.65) fölött, bő tartalékkal
    minCorneringLoad: AUDIO.skid.startLoad, // erőteljes (nem feltétlen driftelő) kanyarodás jele
    minForwardSpeed: 2, // m/s — csak azt zárja ki, hogy szinte álló autó hagyjon nyomot
    markSpacing: 0.6, // m — ennyi elmozdulásonként új nyom-szegmens (folytonos csík)
    markWidth: 0.28, // m — kb. egy kerék szélessége
    wheelOffset: 0.6, // m — a hátsó kerekek fél-nyomtávja a középvonaltól
    rearOffset: CAR.wheelbase / 2, // m — a hátsó tengely távolsága a tömegközépponttól
    maxOpacity: 0.55,
    // A nyomoknak a TELJES verseny végéig meg kell maradniuk (élő visszajelzés) —
    // a korábbi 600-as pool ehhez KEVÉS volt: egyetlen, erőteljesen vezetett kör
    // is simán 500+ szegmenst termel (306 m pálya / 0.6 m szegmens-táv × 2 kerék),
    // tehát a régi pool egy KÖRÖN BELÜL körbeért, és a saját nyoma eltűnt a hátunk
    // mögött. A pool körbeforgása FIZIKAILAG olcsó (egy InstancedMesh — egyetlen
    // rajzhívás bármekkora számnál, egy 4×4 mátrix/instance = 64 bájt, tehát
    // 20 000 instance is csak ~1.3 MB), ezért bőkezűen méretezve: egy teljes,
    // több körös, akár többjátékosos versenyt is fedez anélkül, hogy a pool
    // ténylegesen körbeérne (lásd main.js carEffects.reset() — új versenynél
    // egyébként is nullázódik, tehát a pool sosem "örökli" az előző futamot).
    poolSize: 20000,
  },
  dust: {
    minSpeed: 3, // m/s — ennél lassabban/állva nincs porfelhő
    spawnInterval: 0.05, // s — új porszemcse ilyen gyakran, amíg füvön/sóderen halad
    lifetime: 0.7, // s — egy szemcse ennyi ideig él, aztán újrahasznosul
    riseSpeed: 1.4, // m/s — felfelé sodródás
    spread: 1.2, // m/s — véletlen oldal-/hátraszórás mértéke
    startScale: 0.5,
    endScale: 2.4,
    startOpacity: 0.4,
    poolSize: 120, // ~15 aktív szemcse/porzó autónál, több játékosra is elég tartalék
  },
  // BOOST-LÁNG: a kipufogónál felvillanó, gyorsan elhaló izzó szemcsék, amíg a
  // boost aktív (lásd sim/car.js drive.boosting). Additív keveréssel (nem
  // sima átlátszósággal, mint a por) — attól "izzik", nem csak áttetsző.
  flame: {
    // ÉLŐ VISSZAJELZÉS: a méret/fényesség/sűrűség maradjon erőteljes (ez volt
    // a jó), de a láng-CSÓVA legyen rövidebb — ez a `lifetime` (meddig él egy
    // szemcse) és a `speed` (milyen messzire jut el eközben) szorzata, ezért
    // ezt a kettőt csökkentettük, a méretet/fényességet NEM.
    spawnInterval: 0.02, // s — sűrű szórás, hogy folytonos lángnak hasson
    lifetime: 0.16, // s — a korábbi 0.28 helyett: rövidebb csóva
    speed: 3.5, // m/s — a korábbi 5 helyett: kevesebb táv, mire elhal
    spread: 1.6, // m/s — véletlen oldal-/sebesség-szórás
    startScale: 0.55,
    endScale: 1.1,
    startOpacity: 0.9,
    poolSize: 80,
  },
};

// A pálya SZEGMENS-DEFINÍCIÓJA (lásd sim/trackbuilder.js). Egy kurzor végigjárja,
// és ebből születik a fizika (falak), a spawn, a checkpointok ÉS a 3D-modellek.
//
// EGYSZERŰ TÉGLALAP: mind a 4 kanyar AZONOS irányú (turn: 1) → nincs tükrözés,
// minden kanyar-csempe egységesen illeszkedik. (A vegyes/sikános pálya majd, ha
// a Kenney kanyar-illesztés tükrözéssel is pontos.)
const RECT = (turn) => [
  { type: 'straight', n: 5 }, { type: 'corner', turn },
  { type: 'straight', n: 3 }, { type: 'corner', turn },
  { type: 'straight', n: 5 }, { type: 'corner', turn },
  { type: 'straight', n: 3 }, { type: 'corner', turn },
];

// A beépített alap-pálya — a Colyseus szerver is ezt használja tartalékként,
// ha a szobát létrehozó kliens nem küldött érvényes layoutot.
export const DEFAULT_LAYOUT = RECT(1);

// Ha a felhasználó az editor.html pálya-szerkesztőben rajzolt és mentett egy
// pályát, azt localStorage-ból töltjük be a beépített téglalap helyett.
const customLayout = loadCustomLayout();

export const TRACK = {
  tile: 16, // egy csempe / az ÚT szélessége méterben (nagyobb → relatíve kisebb autó)
  curbWidth: 1.8, // rázókő (rumble strip) szélessége — csak kanyarban
  gravelWidth: 18, // nincs többé fizikai fal — ez csak a checkpoint-vonalak félszélességét szabja (track.js CHECKPOINT_HALF_WIDTH)
  start: { x: 0, z: 0, dir: 0 }, // a kurzor kiindulása (a főegyenes eleje, +x felé)
  layout: customLayout || RECT(1), // szerkesztőből mentett pálya, vagy a beépített téglalap
  checkpointCount: 6, // ennyi checkpoint egyenletesen a kör mentén (a 0. a rajt/cél)
};

// A pálya-szerkesztőben (editor.html) elhelyezhető dekoráció-típusok — mind a
// Kenney Racing Kit modelljei (public/assets/track/). Az editor csak a kulcsot,
// az emoji-ikont és a feliratot használja (2D paletta); a 3D modell-elérési utat
// a render3d/decorations.js olvassa be ugyanebből az objektumból.
//
// `layer`: 'ground' vagy 'object' — EGY cellába EGYSZERRE lehet egy talaj- ÉS egy
// objektum-elem (pl. fű + rá helyezett fa), egymástól függetlenül lerakva/törölve.
// `snap: true` — a szerkesztőben ez a típus a MEGLÉVŐ (szintén snap-elhető)
// dekorációk éleihez illeszkedik lerakáskor (lásd editor.js computeSnap): ha a
// kattintás egy másik snap-elemen közel esik valamelyik éléhez, a lerakott elem
// pontosan odaillesztve, AZONOS forgással kerül le — így fal/kerítés/korlát
// folytonos vonalban, épület (garázs/iroda/lelátó) pedig rés/átfedés nélkül,
// egymás mellé rakható. A `footprint` (valós méret, m) a modell tényleges
// Box3-ából számolódik (lásd render3d/decorFootprint.js) — nem hardkódolt.
export const DECORATION_TYPES = {
  rumble: { model: '/assets/track/barrierRed.glb', label: 'Rázókő', icon: '🟥', scale: 1, layer: 'object' },
  wall: { model: '/assets/track/barrierWall.glb', label: 'Fal', icon: '🧱', scale: 1, layer: 'object', snap: true },
  fence: { model: '/assets/track/fenceStraight.glb', label: 'Kerítés', icon: '🚧', scale: 1, layer: 'object', snap: true },
  treeSmall: { model: '/assets/track/treeSmall.glb', label: 'Kis fa', icon: '🌳', scale: 0.6, layer: 'object' },
  treeLarge: { model: '/assets/track/treeLarge.glb', label: 'Nagy fa', icon: '🌲', scale: 0.8, layer: 'object' },
  pitGarage: { model: '/assets/track/pitsGarage.glb', label: 'Garázs', icon: '🏚️', scale: 1, layer: 'object', snap: true },
  pitOffice: { model: '/assets/track/pitsOffice.glb', label: 'Iroda', icon: '🏢', scale: 1, layer: 'object', snap: true },
  grandstand: { model: '/assets/track/grandStand.glb', label: 'Lelátó', icon: '🎪', scale: 1, layer: 'object', snap: true },
  tent: { model: '/assets/track/tent.glb', label: 'Sátor', icon: '⛺', scale: 1, layer: 'object' },
  flag: { model: '/assets/track/flagCheckers.glb', label: 'Zászló', icon: '🏁', scale: 1, layer: 'object' },
  lightPost: { model: '/assets/track/lightPostModern.glb', label: 'Lámpa', icon: '💡', scale: 0.7, layer: 'object' },
  rail: { model: '/assets/track/rail.glb', label: 'Terelőkorlát', icon: '🛡️', scale: 1, layer: 'object', snap: true },
  // `free: true` — nincs rács-igazítás; a szerkesztőben a kattintás PONTOS
  // helyére kerül (nem a legközelebbi cella közepére), így egy cellán belül is
  // tetszőleges pozícióba rakható (lásd editor.js pixelToPoint / free ág).
  pylon: { model: '/assets/track/pylon.glb', label: 'Terelőkúp', icon: '🔺', scale: 1, layer: 'object', free: true },
  // Út FÖLÉ helyezhető fénykapu — ugyanúgy szabadon lerakható bármelyik cellába,
  // mint bármely más objektum-dekoráció; az útra helyezve (és a rotate gombbal az
  // útiránnyal egybeforgatva) a keret pontosan átíveli a burkolatot.
  lightGate: { model: '/assets/track/overheadLights.glb', label: 'Fénykapu (út fölé)', icon: '🚦', scale: 1, layer: 'object' },
};

// Multiplayer hálózat (3. fázis). A kliens ehhez a Colyseus szerverhez csatlakozik.
// Lokális teszt: `npm run server` (localhost:2567) + két böngészőablak.
// Élesben a szerver (server/index.js) UGYANARRÓL az originről szolgálja ki a
// lebuildelt klienst is (express.static), ezért a szerver címe egyszerűen a
// jelenlegi oldal originje — nincs kézzel beírandó URL, bármelyik domainen működik.
export const NET = {
  serverUrl:
    typeof window !== 'undefined' && window.location.hostname !== 'localhost'
      ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
      : 'ws://localhost:2567',
  // 40 Hz (30 helyett): sűrűbb szerver-állapot → az ellenfél-kocsik pontosabb
  // helyen vannak a te gépeden, kevesebb extrapolációs hiba ütközésnél. 2-4
  // játékosnál a sávszélesség elhanyagolható. A korábbi szaggatás oka NEM a
  // 30 Hz volt, hanem a snapshot-időbélyeg hibája (lásd server/RaceRoom.js
  // broadcastSnapshot Date.now()-ra javítva) — ATTÓL FÜGGETLENÜL a magasabb
  // ütem is finomít az élményen, ezért itt is feljebb véve.
  snapshotHz: 40, // a szerver ennyiszer küld állapot-pillanatképet másodpercenként
  // A KLIENS ennyiszer küldi a SAJÁT autó-állapotát (60 > snapshotHz=40). Miért
  // gyorsabban, mint a broadcast: ha a küldés ÜTEME MEGEGYEZIK a broadcastéval
  // (40=40, de nem szinkronban), a két óra "lebeg" egymáshoz képest → némely
  // broadcast UGYANAZT a (még nem frissült) pozíciót viszi, más egyet kihagy →
  // lépcsős, ugráló táv-adat. Sűrűbb küldésnél MINDEN broadcast friss (≤16 ms-os)
  // pozíciót kap, nincs duplázás/kihagyás → simább interpoláció. A sávszél
  // elhanyagolható (2-4 játékos, ~40 bájt/üzenet).
  sendHz: 60,
  // 80 ms (100 helyett): a snapshot-időbélyeg javítása (lásd fent) után a
  // pufferhez már nem kell akkora biztonsági tartalék a szaggatás ellen, így
  // a késleltetés lejjebb vehető — kevésbé a "múltban" renderelünk → amit
  // LÁTSZ, közelebb van ahhoz, ahol az ellenfél TÉNYLEG van (élő hibajelentés:
  // főleg rajtnál feltűnő, amikor mindkét oldal magát látta előrébbnek — ez a
  // saját autó AZONNALI, a többieké interpDelayMs-nyivel késleltetett
  // renderelésének szerkezeti következménye, csökkenteni lehet, kiküszöbölni
  // nem). 40 Hz-nél (~25 ms/snapshot) ez még mindig ~3 snapshot puffer — nem szaggat.
  // 80 → 60 ms: az extrapoláció bevezetése ÓTA (lásd maxExtrapolationMs) a puffer
  // kifogyását már nem fagyás/ugrás követi, hanem sima sebesség-alapú tovább-
  // gördülés, ezért a "biztonsági" puffer csökkenthető. Kevesebb késleltetés →
  // a többi autót közelebb a valós időhöz látod → kisebb a "magamat előrébb
  // látom" érzet (ez a saját=azonnali, mások=késleltetett renderelés
  // következménye — csökkenthető, teljesen megszüntetni nem lehet). 40 Hz-nél
  // 60 ms még mindig ~2,4 snapshotnyi puffer.
  interpDelayMs: 60, // a kliens ennyivel a "múltban" renderel (két snapshot közt simít)
  // EXTRAPOLÁCIÓ (lásd net/mpClient.js sample): ha a renderidő már a legfrissebb
  // snapshoton TÚL van (a puffer kifogyott — hálózati jitter/csomagvesztés), a
  // távoli autót a sebességéből (vx/vy/w) ENNYI ideig gördítjük tovább, ahelyett
  // hogy megfagyna és a következő snapshotnál ugrana. 40 Hz-nél 200 ms ~8
  // kimaradt snapshotot hidal át; ezen túl a fagyasztás biztonságosabb, mint a
  // vad tovább-becslés (kanyarban egyre nő a hiba).
  maxExtrapolationMs: 200,
  maxPlayers: 4,
};

// BOOST-üzemanyag: ennyi másodpercnyi boost jár KÖRÖNKÉNT (a kör elején/a
// verseny rajtjánál újratöltve — lásd sim/car.js refillBoost, main.js a
// raceStep 'lap'/'finish' eseményénél hívja). Nem gyűlik át a következő körre.
export const BOOST = {
  maxPerLap: 3, // s
};

// Verseny-szabályok és checkpointok. A checkpoint egy VONALSZAKASZ a folyosón
// keresztben; az autó mozgás-szakaszának (előző→jelenlegi pozíció) kell metszenie.
// A 0-s index a rajt/cél vonal; a többit SORRENDBEN kell átszelni (1→2→3→0 = kör).
// A sorrend-kényszer miatt visszatolatással nem lehet csalni.
export const RACE = {
  laps: 3,
  countdownSeconds: 3,
  // Hot Lap mód: a rajt/cél vonaltól ENNYI méterrel HÁTRÉBB indul a countdown
  // (lásd sim/trackFactory.js pointBeforeStart) — mire az autó eléri a tényleges
  // vonalat, már lendületben van (guruló rajt), így a mért kör valódi "flying lap".
  hotlapRunupMeters: 90,
  // Kör-érvényesség: ha a TELJES autó elhagyja a pályát (mind a 4 sarok a burkolaton
  // kívül — lásd sim/car.js isFullyOffRoad), az AKTUÁLIS kör érvénytelen lesz, és az
  // ideje nem számít a legjobb körhöz. (Amíg akár egy kerék az úton van, még ér.)
  // Multiplayer: az ELSŐ célba érő után ennyi másodperccel a verseny akkor is
  // lezárul, ha valaki még nem ért célba (ő DNF) — egy AFK játékos ne tartsa
  // örökre nyitva a versenyt.
  finishTimeoutSeconds: 45,
  // Rossz irány jelzés: ha az autó ennyi másodpercen át, legalább ekkora
  // sebességgel a következő checkpointtól ELFELÉ halad, szól a figyelmeztetés.
  wrongWay: {
    minSpeed: 4, // m/s — ez alatt (parkolás, tototyogás) nem riasztunk
    graceSeconds: 0.8, // s — ennyi "elfelé haladás" után kapcsol be
  },
  // Terelőkúpnak ütközés: ha az autó doboza (a CAR.length/width köré ennyi
  // méter ráhagyással) eléri egy 'pylon' dekoráció pozícióját, az AKTUÁLIS kör
  // érvénytelen lesz (ugyanúgy, mint a pályaelhagyásnál) — lásd sim/car.js hitsCone.
  // FONTOS: 1.3 m-es ráhagyással kiderült (élő hibajelentés — Hungaroring pálya),
  // hogy a versenyvonalon álló, PUSZTÁN díszítésnek szánt kúpok is folyamatosan
  // érvénytelenítették a kört, mert a nagyvonalú küszöb már a puszta közelségre
  // is beütött — ezért ez csak a tényleges, közvetlen nekiütközésre szűkítve.
  coneHitRadius: 0.35, // m — kis ráhagyás a kúp saját méretéhez, nem a közelségre
  // AUTÓ-AUTÓ PUHA SZÉTNYOMÁS (multiplayer). A merev Box2D-ütközés helyett: két
  // közeli kocsit egy gyengéd, átfedés-arányos POZÍCIÓ-korrekció told szét. Miért
  // jobb hálózaton: a merev lökést a kliens-predikció nem tudja eltalálni, a szerver
  // ~1 RTT-vel később másképp oldja fel → "kései szerver-lökés" (a felhasználó ezt
  // érezte). A puha, determinisztikus (csak pozícióból számolt) szétnyomást a szerver
  // ÉS a kliens is ugyanúgy számolja → alig van eltérés → nincs kései rántás. A
  // kocsit körrel közelítjük (minDist a középpontok közti küszöb) — arcade-hoz elég.
  carSeparation: {
    minDist: 3.0, // m — e középpont-távolság alatt lép be a szétnyomás
    blend: 0.4, // az átfedés ekkora hányadát oldjuk fel fizika-lépésenként
    // 0.08→0.3: a korábbi cap túl gyenge volt a menetsebességhez képest (~40 m/s
    // = 0.67 m/lépés záródás), ezért "át lehetett menni". 0.3 m/lépés (~18 m/s
    // szétnyomás) érezhetően megtartja a kocsikat, de még nem "pattint el".
    maxStep: 0.3, // m — a lépésenkénti maximális eltolás
  },
  // A checkpointok a pályából generálódnak (sim/track.js), a checkpointCount alapján.
};
