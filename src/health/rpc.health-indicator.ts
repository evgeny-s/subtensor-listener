import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { ListenersConfig } from '../config/listeners.config';
import { ChainConnectionService } from '../subtensor/chain-connection.service';

/**
 * Readiness signal tied to RPC connectivity. The check goes RED if any pooled
 * connection is down (or if listeners are configured but none has connected
 * yet), with a per-connection breakdown in the response for diagnostics.
 */
@Injectable()
export class RpcHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly connection: ChainConnectionService,
    private readonly config: ListenersConfig,
  ) {}

  check(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const statuses = this.connection.statuses();
    const expectsConnections = this.config.listeners.length > 0;
    const anyDown = statuses.some((s) => !s.connected);

    const details = {
      expected: expectsConnections,
      connections: statuses.map((s) => ({
        endpoint: s.endpoints[0],
        endpoints: s.endpoints,
        connected: s.connected,
      })),
    };

    const healthy = !expectsConnections || (statuses.length > 0 && !anyDown);

    return healthy ? indicator.up(details) : indicator.down(details);
  }
}
