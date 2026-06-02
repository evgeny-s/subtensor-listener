# syntax=docker/dockerfile:1.7
#
# Slim production image for the subtensor-listener service. Targets Kubernetes:
# runs as non-root and exposes :3020 for the health probes.
#   docker build -t subtensor-listener .

# ── Stage 1: Install deps + compile TypeScript ───────────────────
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src/ src/

RUN npm run build

# ── Stage 2: Slim runtime ────────────────────────────────────────
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383

WORKDIR /app

# Prod-only deps — the dev toolchain (nest cli, ts, jest) stays in the builder.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist/ dist/

USER node

ENV NODE_ENV=production
EXPOSE 3020

CMD ["node", "dist/main.js"]
