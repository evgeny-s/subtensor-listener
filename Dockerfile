# syntax=docker/dockerfile:1.7
#
# Slim production image for the subtensor-listener service. Targets Kubernetes:
# runs as non-root and exposes :3020 for the health probes.
#   docker build -t subtensor-listener .

ARG NODE_VERSION=22-alpine

# ---- deps: full install (incl. dev) so the builder can run `nest build` ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile TS -> dist ----
FROM deps AS builder
WORKDIR /app
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- runner: prod-only deps + compiled output ----
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 3020
USER node
CMD ["node", "dist/main.js"]
