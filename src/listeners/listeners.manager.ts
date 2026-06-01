import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../config/app.config';
import { ListenersConfig } from '../config/listeners.config';
import { WebhookNotifier } from '../notifications/webhook.notifier';
import { BlockScanner } from '../subtensor/block-scanner.service';
import { ChainConnectionService } from '../subtensor/chain-connection.service';
import { ChainEventListener, type ReplayResult } from './chain-event-listener';

/**
 * Builds one {@link ChainEventListener} per configured definition, starts them
 * on application bootstrap, and routes test replays to the right listener(s).
 */
@Injectable()
export class ListenersManager
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ListenersManager.name);
  private readonly listeners = new Map<string, ChainEventListener>();

  constructor(
    private readonly config: ListenersConfig,
    private readonly appConfig: AppConfig,
    private readonly connection: ChainConnectionService,
    private readonly scanner: BlockScanner,
    private readonly notifier: WebhookNotifier,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const defs = this.config.listeners;
    if (defs.length === 0) {
      this.logger.warn('No listeners configured — nothing to watch.');
      return;
    }
    for (const def of defs) {
      const listener = new ChainEventListener(
        def,
        this.connection,
        this.scanner,
        this.notifier,
        this.appConfig.backfillBlocks,
      );
      this.listeners.set(def.network, listener);
    }
    // Start concurrently; a failure in one shouldn't block the others.
    await Promise.all(
      Array.from(this.listeners.entries()).map(([network, listener]) =>
        listener.start().catch((err) => {
          this.logger.error(
            `Listener "${network}" failed to start: ${(err as Error).message}`,
          );
        }),
      ),
    );
  }

  onApplicationShutdown(): void {
    for (const listener of this.listeners.values()) listener.stop();
    this.listeners.clear();
  }

  /** Lists configured listener names (for the test endpoint / diagnostics). */
  networks(): string[] {
    return this.config.listeners.map((l) => l.network);
  }

  /**
   * Replays a block through the live pipeline for one network (or all, if
   * `network` is omitted). Used by the secret-guarded test endpoint.
   */
  async replay(
    blockRef: number | string,
    dryRun: boolean,
    network?: string,
  ): Promise<ReplayResult[]> {
    const targets = this.resolveTargets(network);
    return Promise.all(targets.map((l) => l.replay(blockRef, dryRun)));
  }

  private resolveTargets(network?: string): ChainEventListener[] {
    if (this.listeners.size === 0) {
      throw new Error('No listeners are configured.');
    }
    if (!network) return Array.from(this.listeners.values());
    const listener = this.listeners.get(network);
    if (!listener) {
      throw new Error(
        `Unknown network "${network}". Configured: ${this.networks().join(', ')}.`,
      );
    }
    return [listener];
  }
}
