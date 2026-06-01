import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfig } from './config/app.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Strip unknown properties and coerce DTOs across all routes.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Run OnApplicationShutdown hooks on SIGTERM/SIGINT so websocket providers
  // disconnect cleanly and head subscriptions are torn down.
  app.enableShutdownHooks();

  const config = app.get(AppConfig);
  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `subtensor-listener listening on :${config.port}`,
  );
}

void bootstrap();
