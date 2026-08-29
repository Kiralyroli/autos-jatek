# =============================================================================
#  DOCKERFILE — Fly.io-hoz (vagy bármilyen más konténer-alapú hosting-hoz).
#
#  KÉTFÁZISÚ build:
#   1) "builder" — TELJES npm install (devDependencies is, mert a Vite kell a
#      klienshez), lebuildeli a klienst (`npm run build` → dist/).
#   2) futtatott image — csak a PRODUKCIÓS függőségek + a szerver-kód (server/,
#      src/ — a Colyseus-szoba/verseny-logika ugyanazokat a sim/ modulokat
#      importálja, amiket a kliens is, lásd CLAUDE.md) + a builder dist/-je.
#      A Vite/devDependencies NEM kerül bele — kisebb, gyorsabban induló image.
#
#  A `node server/index.js` UGYANAZ a parancs, mint helyben — lásd CLAUDE.md
#  "Deploy / Railway" gotcha: a start-script maradjon sima Node-hívás, semmilyen
#  újabb Node-funkció ne legyen KÖTELEZŐ az induláshoz.
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

# Csak a manifestek előbb — a Docker layer-cache így NEM futtatja újra az
# npm install-t minden forráskód-változásnál, csak ha a függőségek változnak.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Futtatott image ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY src ./src
COPY --from=builder /app/dist ./dist

# A Fly.io fly.toml-jában [http_service].internal_port ezzel egyezzen (lásd ott).
EXPOSE 2567

CMD ["node", "server/index.js"]
