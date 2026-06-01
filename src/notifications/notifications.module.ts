import { Module } from '@nestjs/common';
import { WebhookNotifier } from './webhook.notifier';

@Module({
  providers: [WebhookNotifier],
  exports: [WebhookNotifier],
})
export class NotificationsModule {}
