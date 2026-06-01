import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubtensorModule } from '../subtensor/subtensor.module';
import { ListenersManager } from './listeners.manager';

@Module({
  imports: [SubtensorModule, NotificationsModule],
  providers: [ListenersManager],
  exports: [ListenersManager],
})
export class ListenersModule {}
