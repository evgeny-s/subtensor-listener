import { Global, Module } from '@nestjs/common';
import { AppConfig } from './app.config';
import { ListenersConfig } from './listeners.config';

/**
 * Global config providers. Marked `@Global` so `AppConfig`/`ListenersConfig`
 * can be injected anywhere without re-importing.
 */
@Global()
@Module({
  providers: [AppConfig, ListenersConfig],
  exports: [AppConfig, ListenersConfig],
})
export class AppConfigModule {}
