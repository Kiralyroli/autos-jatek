// =============================================================================
//  MULTIPLAYER JÁTÉKSZERVER (3. fázis) — Colyseus + a közös sim-réteg.
//
//  Indítás: `npm run server` (localhost:2567). A kliens (Vite, localhost:5173)
//  WebSocketen csatlakozik; a matchmaking HTTP-hívásaihoz kell a CORS.
// =============================================================================
import { createServer } from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// A colyseus/express/cors CJS csomagok — Node ESM-ből createRequire-rel megbízható.
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const express = require('express');
const cors = require('cors');

import { RaceRoom } from './RaceRoom.js';

const PORT = Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('race', RaceRoom);

httpServer.listen(PORT, () => {
  console.log(`🏁 Autós játék multiplayer szerver fut: ws://localhost:${PORT}`);
});
