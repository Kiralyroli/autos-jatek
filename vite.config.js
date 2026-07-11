import { defineConfig } from 'vite';

// Fázis 1: tiszta statikus kliens. A gyökér az index.html.
// A dev-szerver alapból localhost:5173, hot reloaddal.
export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
});
