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
  /** Last observed runtime spec version (to detect upgrades). */
  specVersion?: number;
  /** Tears down the runtime-version subscription for the current provider. */
  versionUnsub?: () => void;
  /** Pending init-retry timers, cleared on shutdown so they can't leak. */
  retryTimers: Set<ReturnType<typeof setTimeout>>;
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
 *
 * **Runtime upgrades.** A `specVersion` change does *not* drop the socket, but
 * `@polkadot/api` reacts to it by reloading the live connection's metadata via
 * the legacy `state_getMetadata` RPC — which is frozen at metadata **V14**.
 * That silently downgrades the connection (V16 → V14) and corrupts its registry
 * state, so decoding blocks around the upgrade boundary starts failing
 * (`Unable to decode storage system.events …`) until the process restarts.
 * To avoid that, we watch the runtime version ourselves and, on any change,
 * **recreate the connection from scratch** (fresh provider + `ApiPromise.create`,
 * which re-negotiates clean V16 metadata) and fire the reconnect handlers so
 * listeners re-attach to the new api and gap-fill the boundary.
 */
@Injectable()
export class ChainConnectionService implements OnApplicationShutdown {
  private readonly logger = new Logger(ChainConnectionService.name);
  private readonly pool = new Map<string, PoolEntry>();
  private shuttingDown = false;

  /**
   * Returns the shared {@link ApiPromise} for an endpoint set, creating the
   * connection on first use. Awaits `isReady` before resolving.
   */
  async getConnection(endpoints: string[]): Promise<ApiPromise> {
    if (this.shuttingDown) {
      throw new Error('ChainConnectionService is shutting down');
    }
    return this.ensureEntry(endpoints).apiPromise;
  }

  /**
   * Registers a callback fired whenever the connection for `endpoints` is
   * re-established after a drop *or recreated after a runtime upgrade*. Returns
   * an unsubscribe function.
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

    const entry: PoolEntry = {
      endpoints,
      // Filled in synchronously by openConnection below.
      provider: undefined as unknown as WsProvider,
      apiPromise: undefined as unknown as Promise<ApiPromise>,
      connected: false,
      hadConnection: false,
      reconnectHandlers: new Set(),
      retryTimers: new Set(),
    };
    this.openConnection(entry);
    this.pool.set(key, entry);
    return entry;
  }

  /**
   * Opens a brand-new provider + api for an entry and wires its lifecycle.
   * Used for the initial connect, to replace a connection after a runtime
   * upgrade, and to retry a failed init. Handlers capture their own provider
   * and no-op once the entry has moved on to a newer one, so a torn-down
   * connection can't mutate the live entry. Deliberately does **not** reset
   * `entry.connected`: on a recreate the chain is still reachable, so we keep
   * the prior status until the new provider's own events update it — avoiding a
   * spurious health-readiness DOWN flap on every runtime upgrade.
   */
  private openConnection(entry: PoolEntry): void {
    const provider = new WsProvider(entry.endpoints, RECONNECT_MS);
    entry.provider = provider;
    const apiPromise = ApiPromise.create({ provider, noInitWarn: true });
    entry.apiPromise = apiPromise;

    const isCurrent = () => entry.provider === provider;

    provider.on('connected', () => {
      if (!isCurrent()) return;
      entry.connected = true;
      if (entry.hadConnection) {
        this.logger.warn(
          `Reconnected to ${entry.endpoints[0]} — running gap-fill.`,
        );
        this.fireReconnect(entry);
      } else {
        this.logger.log(`Connected to ${entry.endpoints[0]}.`);
      }
      entry.hadConnection = true;
    });

    provider.on('disconnected', () => {
      if (!isCurrent()) return;
      entry.connected = false;
      this.logger.warn(`Disconnected from ${entry.endpoints[0]}.`);
    });

    provider.on('error', () => {
      if (!isCurrent()) return;
      entry.connected = false;
    });

    // Watch for runtime upgrades on this connection and recreate it on change.
    void apiPromise
      .then(async (api) => {
        if (!isCurrent()) return;
        await api.isReady;
        if (!isCurrent()) return;
        const unsub = await api.rpc.state.subscribeRuntimeVersion((rv) => {
          if (!isCurrent()) return;
          const next = rv.specVersion.toNumber();
          const prev = entry.specVersion;
          entry.specVersion = next;
          if (prev !== undefined && next !== prev) {
            this.logger.warn(
              `Runtime upgrade on ${entry.endpoints[0]} (spec ${prev} → ${next}); ` +
                `recreating connection to drop downgraded metadata.`,
            );
            this.recreate(entry);
          }
        });
        if (!isCurrent()) {
          unsub();
          return;
        }
        entry.versionUnsub = unsub;
      })
      .catch((err) => {
        // Either ApiPromise.create rejected, or wiring the version watcher
        // failed. Either way this connection is unusable; retry from scratch
        // after a delay (a tight loop would hammer a down node). Without this
        // the rejected apiPromise would be cached on the entry forever.
        if (!isCurrent() || this.shuttingDown) return;
        this.logger.error(
          `Connection to ${entry.endpoints[0]} failed to initialize ` +
            `(${(err as Error).message}); reconnecting in ${RECONNECT_MS}ms.`,
        );
        const timer = setTimeout(() => {
          entry.retryTimers.delete(timer);
          if (isCurrent() && !this.shuttingDown) this.recreate(entry);
        }, RECONNECT_MS);
        entry.retryTimers.add(timer);
      });
  }

  /**
   * Replaces an entry's connection with a fresh one (new provider + api),
   * then tears down the old one. The fresh `ApiPromise.create` re-negotiates
   * V16 metadata via the version-aware path, undoing the upgrade-time V14
   * downgrade. The new connection's `connected` event fires the reconnect
   * handlers (hadConnection is already true), so listeners re-attach.
   */
  private recreate(entry: PoolEntry): void {
    const oldProvider = entry.provider;
    const oldApiPromise = entry.apiPromise;
    const oldVersionUnsub = entry.versionUnsub;

    // Reset upgrade tracking; the fresh connection records its own baseline.
    entry.specVersion = undefined;
    entry.versionUnsub = undefined;
    this.openConnection(entry); // swaps entry.provider / entry.apiPromise

    // Tear down the stale connection (its provider is now orphaned). Its event
    // handlers no-op via isCurrent(), so this can't disturb the live entry.
    try {
      oldVersionUnsub?.();
    } catch {
      /* best-effort */
    }
    void disposeConnection(oldApiPromise, oldProvider);
  }

  private fireReconnect(entry: PoolEntry): void {
    for (const handler of entry.reconnectHandlers) {
      try {
        handler();
      } catch (err) {
        this.logger.error(
          `Reconnect handler failed: ${(err as Error).message}`,
        );
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      Array.from(this.pool.values()).map(async (entry) => {
        for (const timer of entry.retryTimers) clearTimeout(timer);
        entry.retryTimers.clear();
        try {
          entry.versionUnsub?.();
        } catch {
          /* best-effort on shutdown */
        }
        await disposeConnection(entry.apiPromise, entry.provider);
      }),
    );
    this.pool.clear();
  }
}

/**
 * Best-effort teardown of a connection: disconnect the api, falling back to the
 * provider directly if the api never resolved (e.g. a rejected create) — which
 * otherwise leaves the WsProvider's auto-reconnect timer running.
 */
async function disposeConnection(
  apiPromise: Promise<ApiPromise>,
  provider: WsProvider,
): Promise<void> {
  try {
    const api = await apiPromise;
    await api.disconnect();
  } catch {
    try {
      await provider.disconnect();
    } catch {
      /* best-effort */
    }
  }
}

/** Canonical pool key for a set of endpoints (order-sensitive: primary first). */
function keyOf(endpoints: string[]): string {
  return JSON.stringify(endpoints);
}
