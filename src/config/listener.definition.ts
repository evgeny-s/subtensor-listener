import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * A single chain event to watch, identified by its pallet (section) and
 * method. For a runtime upgrade this is `system` / `CodeUpdated`.
 */
export class EventFilter {
  @IsString()
  @MinLength(1)
  pallet!: string;

  @IsString()
  @MinLength(1)
  event!: string;
}

/**
 * One listener instance, fully described by env (the service is stateless).
 * The `LISTENERS` env var is a JSON array of these.
 */
export class ListenerDefinition {
  /** Human-readable label surfaced in notifications, e.g. "Finney Mainnet". */
  @IsString()
  @MinLength(1)
  network!: string;

  /**
   * One or more RPC websocket endpoints. The first is primary; the rest are
   * failovers that the WsProvider rotates to on disconnect.
   */
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  endpoints!: string[];

  /** Events that trigger a notification. At least one. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EventFilter)
  events!: EventFilter[];

  /** Target webhook URL (Slack workflow webhook, BetterStack, etc.). */
  @IsUrl({ require_tld: false })
  webhookUrl!: string;

  /**
   * JSON key the rendered message is posted under. Defaults to `text` (matches
   * a Slack workflow variable named `text`). Override if your webhook expects a
   * different key.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  webhookField?: string;

  /**
   * Optional override of the default message template. Supports `{{placeholder}}`
   * tokens drawn from the notification payload (see message-template.ts).
   */
  @IsOptional()
  @IsString()
  messageTemplate?: string;

  /**
   * Optional block-explorer URL template, interpolated with `{{blockNumber}}` /
   * `{{blockHash}}`. The rendered URL is exposed as `{{explorerUrl}}` and added
   * to the default message. Use a RAW URL (no markdown) — Slack auto-links it so
   * it opens in the browser on click. Example:
   *   "https://polkadot.js.org/apps/?rpc=wss://…#/explorer/query/{{blockHash}}"
   */
  @IsOptional()
  @IsString()
  explorerUrl?: string;
}
