import { Logger } from '@nestjs/common';
import type { ApiPromise } from '@polkadot/api';
import type { ListenerDefinition } from '../config/listener.definition';
import {
  DEFAULT_TEMPLATE,
  renderMessage,
  type TemplateVars,
} from '../notifications/message-template';
import type { WebhookNotifier } from '../notifications/webhook.notifier';
import {
  BlockScanner,
  type MatchedEvent,
} from '../subtensor/block-scanner.service';
import type { ChainConnectionService } from '../subtensor/chain-connection.service';
import { DedupCache } from './dedup-cache';

/** Per-event summary returned by a replay (test) run. */
export interface ReplayedEvent {
  pallet: string;
  event: string;
  blockNumber: number;
  specVersionChange: string;
  timestamp: string;
  message: string;
  /** Whether the notification was actually delivered (false on dry-run). */
  sent: boolean;
}

export interface ReplayResult {
  network: string;
  blockNumber: number;
  blockHash: string;
  matched: number;
  events: ReplayedEvent[];
}

/** How many blocks to scan concurrently while backfilling a range. */
const SCAN_CONCURRENCY = 5;

/** Backoff before retrying a reattach that failed transiently. */
const REATTACH_RETRY_MS = 2500;

/**
 * Drives one listener definition: backfills a recent window on start, then
 * follows new (best) heads so alerts fire as soon as an event lands in a
 * block, without waiting for finalization. Backfill, live, and post-reconnect
 * gap-fill all go through the same drain loop, capped at the backfill window
 * so a long outage never triggers an unbounded catch-up.
 */
export class ChainEventListener {
  private readonly logger: Logger;
  private readonly eventLabel: string;
  private readonly dedup = new DedupCache();
  private api!: ApiPromise;
  private unsubscribe?: () => void;
  private detachReconnect?: () => void;

  private lastProcessed = -1;
  private targetHead = -1;
  private draining = false;
  private stopped = false;

  /** Serializes reattach() so racing reconnect signals can't leak head subs. */
  private reattaching = false;
  private reattachQueued = false;
  /** Pending reattach retry after a transient failure (cleared on stop). */
  private reattachRetry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly def: ListenerDefinition,
    private readonly connection: ChainConnectionService,
    private readonly scanner: BlockScanner,
    private readonly notifier: WebhookNotifier,
    private readonly backfillBlocks: number,
  ) {
    this.logger = new Logger(`Listener:${def.network}`);
    this.eventLabel = def.events
      .map((e) => `${e.pallet}.${e.event}`)
      .join(', ');
  }

  async start(): Promise<void> {
    this.api = await this.connection.getConnection(this.def.endpoints);
    await this.api.isReady;

    const best = await this.scanner.bestNumber(this.api);
    // Seed lastProcessed so the first drain covers exactly the backfill window.
    this.lastProcessed = Math.max(-1, best - this.backfillBlocks);
    this.logger.log(
      `Backfilling blocks ${this.lastProcessed + 1}..${best}, then following new heads.`,
    );
    this.bump(best);

    await this.subscribeHeads();

    // On reconnect *or* connection recreation (after a runtime upgrade), the
    // pooled api may be a brand-new instance — re-acquire it, re-subscribe, and
    // gap-fill. Re-processing the boundary block on the fresh (clean-metadata)
    // connection is what makes the alert survive an upgrade; dedup prevents a
    // double-alert if the live pass already delivered it.
    this.detachReconnect = this.connection.onReconnect(
      this.def.endpoints,
      () => void this.reattach(),
    );
  }

  /**
   * (Re-)subscribes to new (best) heads on the current {@link api}, replacing
   * any prior subscription. A reorg re-including the event in a nearby block is
   * absorbed by the dedup window (same event + arguments within
   * DEDUP_WINDOW_BLOCKS).
   */
  private async subscribeHeads(): Promise<void> {
    const next = await this.api.rpc.chain.subscribeNewHeads((header) => {
      const n = header.number.toNumber();
      // Heartbeat: one line per block so the logs show the service is
      // alive and keeping up, even when nothing matches.
      this.logger.log(`Block #${n} — watching ${this.eventLabel}`);
      this.bump(n);
    });
    // Tear down the old subscription only once the new one is live, so a
    // failed subscribe can't leave us with no head feed.
    const prev = this.unsubscribe;
    this.unsubscribe = next;
    prev?.();
  }

  /**
   * Re-binds to the (possibly recreated) pooled connection. Serialized so
   * overlapping reconnect signals can't leak head subscriptions; a signal that
   * arrives mid-flight is coalesced into one trailing run.
   */
  private async reattach(): Promise<void> {
    if (this.reattaching) {
      this.reattachQueued = true;
      return;
    }
    this.reattaching = true;
    try {
      do {
        this.reattachQueued = false;
        try {
          await this.reattachOnce();
        } catch (err) {
          if (this.stopped) return;
          this.logger.error(
            `Re-attach failed: ${(err as Error).message}; retrying shortly.`,
          );
          this.scheduleReattachRetry();
        }
      } while (this.reattachQueued && !this.stopped);
    } finally {
      this.reattaching = false;
    }
  }

  /**
   * One reattach pass. If the pooled api is unchanged (a plain socket
   * reconnect) the head subscription still flows, so we only gap-fill. If it's
   * a fresh instance (post-upgrade recreation) we rebind: re-subscribe heads
   * and **rewind** so the upgrade-boundary block — which may have failed to
   * decode on the old downgraded connection — is re-scanned on the clean one.
   * Dedup suppresses any alert already delivered for the re-scanned blocks.
   */
  private async reattachOnce(): Promise<void> {
    if (this.stopped) return;
    const api = await this.connection.getConnection(this.def.endpoints);
    if (this.stopped) return;

    if (api === this.api) {
      const head = await this.scanner.bestNumber(api);
      if (this.stopped) return;
      this.bump(head);
      return;
    }

    this.api = api;
    const [, head] = await Promise.all([
      this.subscribeHeads(),
      this.scanner.bestNumber(api),
    ]);
    if (this.stopped) {
      this.unsubscribe?.();
      return;
    }
    // Rewind to re-cover the recent window (incl. the upgrade boundary).
    this.lastProcessed = Math.min(
      this.lastProcessed,
      Math.max(-1, head - this.backfillBlocks),
    );
    this.bump(head);
  }

  private scheduleReattachRetry(): void {
    if (this.reattachRetry || this.stopped) return;
    this.reattachRetry = setTimeout(() => {
      this.reattachRetry = undefined;
      if (!this.stopped) void this.reattach();
    }, REATTACH_RETRY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.reattachRetry) clearTimeout(this.reattachRetry);
    this.unsubscribe?.();
    this.detachReconnect?.();
  }

  /**
   * Re-runs the live pipeline against a single block (by number or 0x-hash),
   * bypassing dedup. With `dryRun` it renders but does not deliver.
   */
  async replay(
    blockRef: number | string,
    dryRun: boolean,
  ): Promise<ReplayResult> {
    const api = await this.connection.getConnection(this.def.endpoints);
    await api.isReady;

    const blockNumber = await this.resolveBlockNumber(api, blockRef);
    const matches = await this.scanner.scanBlock(
      api,
      blockNumber,
      this.def.events,
    );

    const events: ReplayedEvent[] = [];
    for (const match of matches) {
      const summary = await this.handleMatch(match, { send: !dryRun });
      events.push(summary);
    }

    return {
      network: this.def.network,
      blockNumber,
      blockHash: matches[0]?.blockHash ?? (await this.hashOf(api, blockNumber)),
      matched: matches.length,
      events,
    };
  }

  private bump(head: number): void {
    if (this.stopped) return;
    if (head > this.targetHead) this.targetHead = head;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.lastProcessed < this.targetHead) {
        const to = this.targetHead;
        let from = this.lastProcessed + 1;
        const minFrom = to - this.backfillBlocks + 1;
        if (from < minFrom) {
          this.logger.warn(
            `Skipping blocks ${from}..${minFrom - 1} (beyond ${this.backfillBlocks}-block backfill window).`,
          );
          from = minFrom;
        }
        from = Math.max(from, 0);
        await this.processRange(from, to);
        this.lastProcessed = to;
      }
    } catch (err) {
      this.logger.error(`Drain error: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async processRange(from: number, to: number): Promise<void> {
    for (let start = from; start <= to; start += SCAN_CONCURRENCY) {
      const end = Math.min(start + SCAN_CONCURRENCY - 1, to);
      const numbers: number[] = [];
      for (let n = start; n <= end; n++) numbers.push(n);
      await Promise.all(numbers.map((n) => this.processBlock(n)));
    }
  }

  private async processBlock(blockNumber: number): Promise<void> {
    try {
      const matches = await this.scanner.scanBlock(
        this.api,
        blockNumber,
        this.def.events,
      );
      for (const match of matches) {
        const key = dedupKey(this.def.network, match);
        if (!this.dedup.shouldAlert(key, blockNumber)) continue;
        this.logger.log(
          `Matched ${match.pallet}.${match.event} in block ${blockNumber}.`,
        );
        await this.handleMatch(match, { send: true });
      }
    } catch (err) {
      this.logger.error(
        `Failed to process block ${blockNumber}: ${(err as Error).message}`,
      );
    }
  }

  /** Builds vars, renders the message, and (optionally) delivers it. */
  private async handleMatch(
    match: MatchedEvent,
    opts: { send: boolean },
  ): Promise<ReplayedEvent> {
    const vars = this.buildVars(match);
    const template = this.def.messageTemplate ?? DEFAULT_TEMPLATE;
    const message = renderMessage(template, vars);

    let sent = false;
    if (opts.send) {
      sent = await this.notifier.send(
        { url: this.def.webhookUrl, field: this.def.webhookField },
        message,
      );
    }

    return {
      pallet: match.pallet,
      event: match.event,
      blockNumber: match.blockNumber,
      specVersionChange: vars.specVersionChange,
      timestamp: vars.timestamp,
      message,
      sent,
    };
  }

  private buildVars(match: MatchedEvent): TemplateVars {
    const vars: TemplateVars = {
      network: this.def.network,
      pallet: match.pallet,
      event: match.event,
      blockNumber: String(match.blockNumber),
      blockHash: match.blockHash,
      blockHashShort: shortHash(match.blockHash),
      specVersionFrom: match.specVersionFrom?.toString() ?? '',
      specVersionTo: match.specVersionTo?.toString() ?? '',
      specVersionChange: specVersionChange(match),
      timestamp: formatTimestamp(match.timestampMs),
      timestampUtc: formatTimestampUtc(match.timestampMs),
    };
    // Interpolate the explorer URL template (if configured) against the vars
    // above, so {{explorerUrl}} resolves to a clickable, raw block link.
    vars.explorerUrl = this.def.explorerUrl
      ? renderMessage(this.def.explorerUrl, vars)
      : '';
    return vars;
  }

  private async resolveBlockNumber(
    api: ApiPromise,
    blockRef: number | string,
  ): Promise<number> {
    if (typeof blockRef === 'number') return blockRef;
    const trimmed = blockRef.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      const header = await api.rpc.chain.getHeader(trimmed);
      return header.number.toNumber();
    }
    const asNumber = Number(trimmed);
    if (!Number.isInteger(asNumber) || asNumber < 0) {
      throw new Error(`Invalid block reference: ${blockRef}`);
    }
    return asNumber;
  }

  private async hashOf(api: ApiPromise, blockNumber: number): Promise<string> {
    return (await api.rpc.chain.getBlockHash(blockNumber)).toString();
  }
}

/**
 * Dedup key: the event type plus its arguments, per listener. Deliberately
 * excludes the block number and event index — the {@link DedupCache} window
 * handles proximity, so a reorg that moves the event to a nearby block doesn't
 * re-alert, while the same event with different arguments alerts separately.
 */
export function dedupKey(network: string, match: MatchedEvent): string {
  return `${network}|${match.pallet}.${match.event}|${match.data}`;
}

/** Human-readable spec-version transition for the message. */
export function specVersionChange(match: MatchedEvent): string {
  const { specVersionFrom: from, specVersionTo: to } = match;
  if (from !== null && to !== null) {
    return from === to ? `unchanged (${to})` : `${from} → ${to}`;
  }
  if (to !== null) return `${to}`;
  return 'unknown';
}

function formatTimestamp(ms: number | null): string {
  if (ms === null) return 'unknown';
  return new Date(ms).toISOString();
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Human-readable UTC time, e.g. "28 May 2026 15:54 UTC". */
function formatTimestampUtc(ms: number | null): string {
  if (ms === null) return 'unknown';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/** Abbreviates a long 0x hash to `0x1234abcd…wxyz5678` for compact display. */
function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}
