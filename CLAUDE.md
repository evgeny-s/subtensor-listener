# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## Working agreements (MUST follow)

- **No Claude attribution.** Do NOT add a `Co-Authored-By: Claude` trailer to
  commits. Do NOT mention Claude / Claude Code / AI anywhere in commit messages,
  PR titles, or PR descriptions. The history should read as the author's own.
- **Checks before every commit.** Always run, in order, and only commit if all
  pass:
  ```bash
  npm run format      # prettier --write
  npm test            # jest
  npm run build       # nest build
  ```
  (`npm run lint` is also part of CI; run it if you touched lint-sensitive code.)
- Never commit secrets. `.env` is gitignored; real webhook URLs and
  `TEST_API_SECRET` live only in env, never in the repo.

## What this is

A **stateless** NestJS service that listens to Subtensor (Bittensor) chain
events and pushes a notification to a generic webhook (e.g. a Slack workflow
webhook). The first use case is detecting runtime upgrades via the
`system.CodeUpdated` event, but listeners are generic (`pallet` + `event`) and
configured entirely through env, so new watches are added without code changes.

No database, no auth, no admin UI — everything is driven by the `LISTENERS` env
array.

## Architecture

- `src/config` — `AppConfig` (port, backfill window) and `ListenersConfig`
  (parses + validates the `LISTENERS` JSON array, fails fast on bad config).
- `src/subtensor` — `ChainConnectionService` (pooled `@polkadot/api`
  connections, shared per endpoint set, auto-reconnect) and `BlockScanner`
  (matches events in a block, enriches with `specVersion` old→new + timestamp).
- `src/listeners` — `ChainEventListener` (per definition: backfill the recent
  window, then follow **new (best)** heads; in-memory dedup; reconnect gap-fill)
  and `ListenersManager` (lifecycle + test replay routing).
- `src/notifications` — generic `{{token}}` template rendering + `WebhookNotifier`
  (best-effort POST, one retry on 429).
- `src/health` — `/health/live` (liveness) and `/health/ready` (RED if any RPC
  connection is down; per-connection detail in the body). Maps to k8s probes.
- `src/test-endpoint` — secret-guarded `POST /test/replay` to run a specific
  block (number or hash) through the live pipeline.

## Key design decisions

- **New (best) heads** — alerts fire as soon as the event lands in a block,
  without waiting ~2 blocks for finalization.
- **Stateless dedup** — in-memory only, keyed by event type + arguments with a
  5-block window (hardcoded, not env-tunable), so a reorg re-including the
  same event in a nearby block doesn't re-alert. A restart may re-alert an
  event still inside the backfill window. Accepted (no DB / no persistent
  disk).
- **Backfill window** capped (default 10 min); reconnect gap-fill is capped to
  the same window so a long outage never triggers an unbounded catch-up.
- **Generic webhook transport** — decoupled from Slack; the message is rendered
  server-side and POSTed under a configurable JSON key (default `text`).

## Local dev

```bash
cp .env.example .env   # then edit LISTENERS / webhook URL
npm install
npm run start:dev
```

## Test endpoint

```bash
curl -X POST http://localhost:3020/test/replay \
  -H 'Content-Type: application/json' \
  -H "x-api-secret: $TEST_API_SECRET" \
  -d '{"block": 1234567, "network": "Finney Mainnet", "dryRun": true}'
```
`block` accepts a number or a `0x` hash. `dryRun: true` renders without
delivering; omit it (or set false) to send for real, exactly like live mode.
