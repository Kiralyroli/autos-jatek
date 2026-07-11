# Assetek — bevásárlólista és mappa-konvenció

A játék ezeket a fájlokat **automatikusan felismeri**, ha pontosan ezeken a neveken/helyeken
vannak. Ha egy fájl hiányzik, a játék a beépített procedurális megjelenésre/hangra esik vissza
(nem törik el). Csak **CC0 / public domain** (kereskedelmileg is szabad) assetet használj!

```
public/assets/
├── car.glb                 # 3D autó-modell (low-poly)
├── textures/
│   ├── asphalt.jpg         # aszfalt (a pálya burkolata)
│   └── grass.jpg           # fű (a talaj)
└── sounds/
    ├── engine.mp3          # loopolható motorhang
    └── skid.mp3            # loopolható gumicsikorgás
```

## Ajánlott jogtiszta (CC0) források

### Autó-modell → `car.glb`
- **Kenney – Car Kit**: https://kenney.nl/assets/car-kit (CC0)
  - Töltsd le a csomagot, válassz egy autót a `Models/GLB format/` mappából
    (pl. `sedan.glb`, `race.glb`, `raceFuture.glb`), és **nevezd át `car.glb`-re**,
    ide: `public/assets/car.glb`.

### Textúrák → `textures/asphalt.jpg`, `textures/grass.jpg`
- **ambientCG**: https://ambientcg.com (CC0) — pl. „Asphalt", „Grass" → a `Color` map JPG-je.
- **Poly Haven**: https://polyhaven.com/textures (CC0).
  - Elég a szín- (albedo/diffuse) térkép; nevezd `asphalt.jpg` / `grass.jpg`-re.
  - A tileable (ismétlődő) változat a jó.

### Hangok → `sounds/engine.mp3`, `sounds/skid.mp3`
- **Freesound**: https://freesound.org (szűrő: License = „Creative Commons 0").
  - `engine.mp3`: egyenletes, loopolható motor-alapjárat/zúgás.
  - `skid.mp3`: gumicsikorgás / kerékcsúszás loop.
- **Kenney – audio**: https://kenney.nl/assets?q=audio (CC0).

## Miután beraktad
Szólj, és finomhangolom az autó **méretét/orientációját** (a `config.js` `ASSETS.car`
`scale`/`rotationY`/`yOffset` mezőivel) és a hang-loopokat a konkrét fájlokhoz.
```
