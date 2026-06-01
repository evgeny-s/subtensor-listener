import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { SubtensorModule } from '../subtensor/subtensor.module';
import { HealthController } from './health.controller';
import { RpcHealthIndicator } from './rpc.health-indicator';

@Module({
  imports: [TerminusModule, SubtensorModule],
  controllers: [HealthController],
  providers: [RpcHealthIndicator],
})
export class HealthModule {}
