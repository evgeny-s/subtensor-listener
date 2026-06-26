import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { ListenersModule } from './listeners/listeners.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SubtensorModule } from './subtensor/subtensor.module';
import { TestModule } from './test-endpoint/test.module';

/**
 * Root module. The service is stateless (no DB, no auth): everything is driven
 * by env. Listeners follow new (best) chain heads and push notifications via a
 * generic webhook; health probes expose RPC connectivity; a secret-guarded test
 * endpoint replays specific blocks through the live pipeline.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AppConfigModule,
    SubtensorModule,
    NotificationsModule,
    ListenersModule,
    TestModule,
    HealthModule,
  ],
})
export class AppModule {}
