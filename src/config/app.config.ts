import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Typed accessor over the non-listener (global) env. Everything has a dev
 * default so a fresh checkout boots, but production should set them explicitly.
 */
@Injectable()
export class AppConfig {
  constructor(private readonly config: ConfigService) {}

  /** HTTP port. Health probes live here. Defaults to 3020. */
  get port(): number {
    return this.config.get<number>('PORT') ?? 3020;
  }

  /**
   * How far back to scan on startup (and after a reconnect gap) so an event
   * that fired just before we connected isn't missed. Expressed in minutes;
   * converted to a block count via `blockTimeSeconds`.
   */
  get backfillMinutes(): number {
    return this.numberFromEnv('BACKFILL_MINUTES', 10);
  }

  /** Assumed block time used to turn `backfillMinutes` into a block count. */
  get blockTimeSeconds(): number {
    return this.numberFromEnv('BLOCK_TIME_SECONDS', 12);
  }

  /** Derived: maximum number of finalized blocks to backfill. */
  get backfillBlocks(): number {
    return Math.max(
      1,
      Math.ceil((this.backfillMinutes * 60) / this.blockTimeSeconds),
    );
  }

  private numberFromEnv(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || `${raw}`.trim() === '') {
      return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
