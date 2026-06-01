import { Injectable, Logger } from '@nestjs/common';
import type { ApiPromise } from '@polkadot/api';
import type { EventFilter } from '../config/listener.definition';

/** The slice of a block-scoped api decoration we actually use. */
interface BlockApi {
  query: {
    system: {
      events: () => Promise<
        ArrayLike<{ event: { section: string; method: string } }> & {
          forEach: (
            cb: (
              record: { event: { section: string; method: string } },
              index: number,
            ) => void,
          ) => void;
        }
      >;
    };
    timestamp: { now: () => Promise<{ toNumber: () => number }> };
  };
}

/** A chain event that matched a listener's filter, with block context. */
export interface MatchedEvent {
  pallet: string;
  event: string;
  blockNumber: number;
  blockHash: string;
  /** Block timestamp in ms (from the timestamp pallet), or null if unavailable. */
  timestampMs: number | null;
  /** Position of the event within the block's event list (used for dedup). */
  eventIndex: number;
  /** Runtime spec version at the parent block, or null if it couldn't be read. */
  specVersionFrom: number | null;
  /** Runtime spec version at this block, or null if it couldn't be read. */
  specVersionTo: number | null;
}

@Injectable()
export class BlockScanner {
  private readonly logger = new Logger(BlockScanner.name);

  /** Latest finalized block number. */
  async finalizedNumber(api: ApiPromise): Promise<number> {
    const hash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(hash);
    return header.number.toNumber();
  }

  /**
   * Scans a single block for events matching any of `filters`. Returns one
   * {@link MatchedEvent} per matching event record.
   */
  async scanBlock(
    api: ApiPromise,
    blockNumber: number,
    filters: EventFilter[],
  ): Promise<MatchedEvent[]> {
    const blockHash = (
      await api.rpc.chain.getBlockHash(blockNumber)
    ).toString();
    const apiAt = (await api.at(blockHash)) as unknown as BlockApi;
    const records = await apiAt.query.system.events();

    const matches: MatchedEvent[] = [];
    records.forEach((record, eventIndex) => {
      const { section, method } = record.event;
      if (!isMatch(filters, section, method)) return;
      matches.push({
        pallet: section,
        event: method,
        blockNumber,
        blockHash,
        timestampMs: null,
        eventIndex,
        specVersionFrom: null,
        specVersionTo: null,
      });
    });

    if (matches.length === 0) return matches;

    // Only pay for the enrichment RPC calls when something actually matched.
    const [timestampMs, specVersions] = await Promise.all([
      this.readTimestamp(apiAt),
      this.readSpecVersions(api, blockHash),
    ]);
    for (const m of matches) {
      m.timestampMs = timestampMs;
      m.specVersionFrom = specVersions.from;
      m.specVersionTo = specVersions.to;
    }
    return matches;
  }

  private async readTimestamp(apiAt: BlockApi): Promise<number | null> {
    try {
      const now = await apiAt.query.timestamp.now();
      return now.toNumber();
    } catch {
      return null;
    }
  }

  /**
   * Reads the runtime spec version at the block and at its parent. On a pruned
   * node the parent state may be unavailable — in that case we return what we
   * can and leave the rest null rather than failing the whole scan.
   */
  private async readSpecVersions(
    api: ApiPromise,
    blockHash: string,
  ): Promise<{ from: number | null; to: number | null }> {
    let to: number | null = null;
    let from: number | null = null;
    try {
      const header = await api.rpc.chain.getHeader(blockHash);
      const parentHash = header.parentHash.toString();
      const [current, parent] = await Promise.allSettled([
        api.rpc.state.getRuntimeVersion(blockHash),
        api.rpc.state.getRuntimeVersion(parentHash),
      ]);
      if (current.status === 'fulfilled') {
        to = current.value.specVersion.toNumber();
      }
      if (parent.status === 'fulfilled') {
        from = parent.value.specVersion.toNumber();
      }
    } catch (err) {
      this.logger.warn(
        `Could not read runtime version at ${blockHash}: ${(err as Error).message}`,
      );
    }
    return { from, to };
  }
}

/** Case-sensitive match of an event's pallet+method against the filters. */
export function isMatch(
  filters: EventFilter[],
  section: string,
  method: string,
): boolean {
  return filters.some((f) => f.pallet === section && f.event === method);
}
