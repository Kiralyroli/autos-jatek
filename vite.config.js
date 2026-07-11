import { defineConfig } from 'vite';
import { resolve } from 'path';

// Fázis 1: tiszta statikus kliens. Két HTML belépési pont: a játék (index.html)
// és a pálya-szerkesztő (editor.html) — mindkettőt fel kell venni a build inputba,
// különben a production build csak az index.html-t építené le.
// A `base` a GitHub Pages project-site útvonalához igazít
// (https://<user>.github.io/autos-jatek/) — csak a production buildet érinti,
// a dev-szervert nem.
export default defineConfig(({ command }) => ({
  // A base CSAK build-nél GitHub Pages-utat (project site: /autos-jatek/), dev
  // közben marad a gyökér — a dev-szerver URL-jei (localhost:5173/index.html)
  // így nem változnak. A kód a hardkódolt '/assets/...' útvonalakat mindenhol az
  // import.meta.env.BASE_URL-lel prefixeli (lásd render3d/assets.js withBase),
  // ez adja mindkét módban a helyes, tényleges elérési utat.
  base: command === 'build' ? '/autos-jatek/' : '/',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        editor: resolve(__dirname, 'editor.html'),
      },
    },
  },
}));
