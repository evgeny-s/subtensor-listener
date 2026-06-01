import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ApiPromise, WsProvider } from '@polkadot/api';

/** Snapshot of one pooled connection, surfaced to the health check. */
export interface ConnectionStatus {
  endpoints: string[];
  connected: boolean;
}

interface PoolEntry {
  endpoints: string[];
  provider: WsProvider;
  apiPromise: Promise<ApiPromise>;
  connected: boolean;
  /** Whether we've ever been connected (to distinguish first connect vs reconnect). */
  hadConnection: boolean;
  reconnectHandlers: Set<() => void>;
}

const RECONNECT_MS = 2500;

/**
 * Owns the websocket connections to the chain. Listeners that share the same
 * endpoint set share one {@link ApiPromise} (keyed by the endpoints array), so
 * N listeners on the same RPC don't open N sockets.
 *
 * The underlying {@link WsProvider} auto-reconnects (and rotates across the
 * endpoint array). On a *reconnect* (not the initial connect) we fire the
 * registered handlers so a listener can gap-backfill the blocks it missed.
 */
@Injectable()
export class ChainConnectionService implements OnApplicationShutdown {
  private readonly logger = new Logger(ChainConnectionService.name);
  private readonly pool = new Map<string, PoolEntry>();

  /**
   * Returns the shared {@link ApiPromise} for an endpoint set, creating the
   * connection on first use. Awaits `isReady` before resolving.
   */
  async getConnection(endpoints: string[]): Promise<ApiPromise> {
    const entry = this.ensureEntry(endpoints);
    return entry.apiPromise;
  }

  /**
   * Registers a callback fired whenever the connection for `endpoints` is
   * re-established after a drop. Returns an unsubscribe function.
   */
  onReconnect(endpoints: string[], handler: () => void): () => void {
    const entry = this.ensureEntry(endpoints);
    entry.reconnectHandlers.add(handler);
    return () => entry.reconnectHandlers.delete(handler);
  }

  /** Per-connection status for the health check. */
  statuses(): ConnectionStatus[] {
    return Array.from(this.pool.values()).map((e) => ({
      endpoints: e.endpoints,
      connected: e.connected,
    }));
  }

  /** True only if every pooled connection is currently up. */
  allConnected(): boolean {
    const all = Array.from(this.pool.values());
    return all.length > 0 && all.every((e) => e.connected);
  }

  private ensureEntry(endpoints: string[]): PoolEntry {
    const key = keyOf(endpoints);
    const existing = this.pool.get(key);
    if (existing) return existing;

    const provider = new WsProvider(endpoints, RECONNECT_MS);
    const entry: PoolEntry = {
      endpoints,
      provider,
      connected: false,
      hadConnection: false,
      reconnectHandlers: new Set(),
      apiPromise: ApiPromise.create({ provider, noInitWarn: true }),
    };

    provider.on('connected', () => {
      entry.connected = true;
      if (entry.hadConnection) {
        this.logger.warn(`Reconnected to ${endpoints[0]} — running gap-fill.`);
        for (const handler of entry.reconnectHandlers) {
          try {
            handler();
          } catch (err) {
            this.logger.error(
              `Reconnect handler failed: ${(err as Error).message}`,
            );
          }
        }
      } else {
        this.logger.log(`Connected to ${endpoints[0]}.`);
      }
      entry.hadConnection = true;
    });

    provider.on('disconnected', () => {
      entry.connected = false;
      this.logger.warn(`Disconnected from ${endpoints[0]}.`);
    });

    provider.on('error', () => {
      entry.connected = false;
    });

    this.pool.set(key, entry);
    return entry;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.pool.values()).map(async (entry) => {
        try {
          const api = await entry.apiPromise;
          await api.disconnect();
        } catch {
          /* best-effort on shutdown */
        }
      }),
    );
    this.pool.clear();
  }
}

/** Canonical pool key for a set of endpoints (order-sensitive: primary first). */
function keyOf(endpoints: string[]): string {
  return JSON.stringify(endpoints);
}
