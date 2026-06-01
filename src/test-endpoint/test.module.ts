import { Module } from '@nestjs/common';
import { ListenersModule } from '../listeners/listeners.module';
import { TestController } from './test.controller';
import { TestSecretGuard } from './test-secret.guard';

@Module({
  imports: [ListenersModule],
  controllers: [TestController],
  providers: [TestSecretGuard],
})
export class TestModule {}
