import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsDefined, IsOptional, IsString } from 'class-validator';
import { ListenersManager } from '../listeners/listeners.manager';
import { TestSecretGuard } from './test-secret.guard';

class ReplayDto {
  /** Block number (e.g. 1234567) or block hash (0x…). */
  @IsDefined()
  block!: number | string;

  /** Which listener to replay against, by `network` label. Omit for all. */
  @IsOptional()
  @IsString()
  network?: string;

  /**
   * When true, render the message but do NOT deliver it to the webhook.
   * Defaults to false — i.e. behaves exactly like the live pipeline and sends.
   */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/**
 * Secret-guarded test harness: replays a specific block through the live
 * pipeline (scan → match → enrich → render → deliver) so the whole flow can be
 * verified against a known block without waiting for a real runtime upgrade.
 */
@Controller('test')
@UseGuards(TestSecretGuard)
export class TestController {
  constructor(private readonly listeners: ListenersManager) {}

  @Post('replay')
  async replay(@Body() dto: ReplayDto) {
    const results = await this.listeners.replay(
      dto.block,
      dto.dryRun ?? false,
      dto.network,
    );
    return { dryRun: dto.dryRun ?? false, results };
  }
}
