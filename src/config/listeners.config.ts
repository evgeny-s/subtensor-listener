import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListenerDefinition } from './listener.definition';

/**
 * Parses and validates the `LISTENERS` env var (a JSON array of
 * {@link ListenerDefinition}). Fails fast at startup on malformed config so a
 * bad deploy never silently runs with zero/partial listeners.
 */
@Injectable()
export class ListenersConfig {
  private readonly logger = new Logger(ListenersConfig.name);
  private readonly definitions: ListenerDefinition[];

  constructor(private readonly config: ConfigService) {
    this.definitions = this.parse();
  }

  get listeners(): ListenerDefinition[] {
    return this.definitions;
  }

  private parse(): ListenerDefinition[] {
    const raw = this.config.get<string>('LISTENERS');
    if (!raw || raw.trim() === '') {
      this.logger.warn(
        'LISTENERS is empty — the service will start but watch nothing.',
      );
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `LISTENERS is not valid JSON: ${(err as Error).message}. ` +
          `Expected a JSON array of listener definitions.`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error(
        'LISTENERS must be a JSON array of listener definitions.',
      );
    }

    const instances = plainToInstance(ListenerDefinition, parsed);
    const errors = instances.flatMap((instance, index) =>
      validateSync(instance, { whitelist: true }).map(
        (e) => `listeners[${index}].${e.property}: ${describe(e.constraints)}`,
      ),
    );

    if (errors.length > 0) {
      throw new Error(`Invalid LISTENERS config:\n - ${errors.join('\n - ')}`);
    }

    this.logger.log(
      `Loaded ${instances.length} listener(s): ${instances
        .map((l) => l.network)
        .join(', ')}`,
    );
    return instances;
  }
}

function describe(constraints: Record<string, string> | undefined): string {
  if (!constraints) return 'invalid';
  return Object.values(constraints).join('; ');
}
