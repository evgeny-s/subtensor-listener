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

/**
 * Drives one listener definition: backfills a recent window on start, then
 * follows finalized heads. Backfill, live, and post-reconnect gap-fill all go
 * through the same drain loop, capped at the backfill window so a long outage
 * never triggers an unbounded catch-up.
 */
export class ChainEventListener {
  private readonly logger: Logger;
  private readonly dedup = new DedupCache();
  private api!: ApiPromise;
  private unsubscribe?: () => void;
  private detachReconnect?: () => void;

  private lastProcessed = -1;
  private targetHead = -1;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly def: ListenerDefinition,
    private readonly connection: ChainConnectionService,
    private readonly scanner: BlockScanner,
    private readonly notifier: WebhookNotifier,
    private readonly backfillBlocks: number,
  ) {
    this.logger = new Logger(`Listener:${def.network}`);
  }

  async start(): Promise<void> {
    this.api = await this.connection.getConnection(this.def.endpoints);
    await this.api.isReady;

    const finalized = await this.scanner.finalizedNumber(this.api);
    // Seed lastProcessed so the first drain covers exactly the backfill window.
    this.lastProcessed = Math.max(-1, finalized - this.backfillBlocks);
    this.logger.log(
      `Backfilling blocks ${this.lastProcessed + 1}..${finalized}, then following finalized heads.`,
    );
    this.bump(finalized);

    this.unsubscribe = await this.api.rpc.chain.subscribeFinalizedHeads(
      (header) => this.bump(header.number.toNumber()),
    );

    // On reconnect, jump the target to the current finalized head; the drain
    // loop fills the gap (capped at the backfill window).
    this.detachReconnect = this.connection.onReconnect(
      this.def.endpoints,
      () => {
        void this.scanner
          .finalizedNumber(this.api)
          .then((head) => this.bump(head))
          .catch((err) =>
            this.logger.error(`Gap-fill failed: ${(err as Error).message}`),
          );
      },
    );
  }

  stop(): void {
    this.stopped = true;
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
        if (!this.dedup.addIfNew(key)) continue;
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
    return {
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

/** Dedup key: a given event at a given position in a given block, per listener. */
export function dedupKey(network: string, match: MatchedEvent): string {
  return `${network}|${match.blockNumber}|${match.pallet}.${match.event}|${match.eventIndex}`;
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
