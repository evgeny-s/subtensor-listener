# subtensor-listener

Stateless NestJS service that watches Subtensor (Bittensor) chain events and
pushes notifications to a generic webhook (e.g. a Slack workflow webhook).

First use case: alert on **runtime upgrades** (`system.CodeUpdated`, applied via
multisig). Listeners are generic (`pallet` + `event`) and fully env-configured,
so new watches need no code changes.

## How it works

- Connects to one or more RPC endpoints per listener (`@polkadot/api`), shared
  per endpoint set, with auto-reconnect across the failover list.
- Backfills a recent window (default 10 min) on startup, then follows
  **finalized** heads (no reorg false-positives).
- On a match, enriches with `specVersion` (old→new), block hash and timestamp,
  renders a message from a template, and POSTs it to the listener's webhook.
- In-memory dedup avoids re-alerting within a process lifetime (the service is
  stateless — no DB).

## Configuration

All via env — see [`.env.example`](./.env.example). The core is the `LISTENERS`
JSON array:

```jsonc
[
  {
    "network": "Finney Mainnet",
    "endpoints": ["wss://entrypoint-finney.opentensor.ai:443"],
    "events": [{ "pallet": "system", "event": "CodeUpdated" }],
    "webhookUrl": "https://hooks.slack.com/triggers/…",
    "webhookField": "text",            // optional, default "text"
    "messageTemplate": "…"             // optional override
  }
]
```

## Run

```bash
cp .env.example .env
npm install
npm run start:dev          # dev (watch)
npm run build && npm run start:prod
```

Docker (targets Kubernetes, non-root, port 3020):

```bash
docker build -t subtensor-listener .
docker run --rm -p 3020:3020 --env-file .env subtensor-listener
```

## Health

- `GET /health/live` — liveness (process is up).
- `GET /health/ready` — readiness; **RED if any RPC connection is down**, with a
  per-connection breakdown. Wire these to k8s liveness/readiness probes.

## Test a specific block

A secret-guarded endpoint replays any block through the live pipeline:

```bash
curl -X POST http://localhost:3020/test/replay \
  -H 'Content-Type: application/json' \
  -H "x-api-secret: $TEST_API_SECRET" \
  -d '{"block": "0x…or block number", "network": "Finney Mainnet", "dryRun": true}'
```

Set `TEST_API_SECRET` to enable it (unset = disabled, returns 403).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Dev server (watch) |
| `npm run build` | Compile to `dist/` |
| `npm test` | Unit tests |
| `npm run format` / `check-format` | Prettier write / check |
| `npm run lint` | ESLint |
