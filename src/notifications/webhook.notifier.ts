import { Injectable, Logger } from '@nestjs/common';

/** Where to deliver a rendered message. */
export interface WebhookTarget {
  url: string;
  /** JSON key the message text is sent under (defaults to `text`). */
  field?: string;
}

/**
 * Posts a rendered message to a generic webhook (a Slack workflow webhook,
 * BetterStack, Discord, etc. — anything that accepts a JSON POST). Delivery is
 * best-effort: a failure is logged and swallowed so a flaky webhook never
 * crashes the listener. Honours one retry on HTTP 429 (`Retry-After`).
 */
@Injectable()
export class WebhookNotifier {
  private readonly logger = new Logger(WebhookNotifier.name);

  async send(target: WebhookTarget, text: string): Promise<boolean> {
    const field = target.field ?? 'text';
    const body = JSON.stringify({ [field]: text });

    try {
      const res = await this.post(target.url, body);
      if (res.status === 429) {
        const wait = retryAfterMs(res.headers.get('retry-after'));
        this.logger.warn(`Webhook rate-limited; retrying in ${wait}ms.`);
        await delay(wait);
        const retry = await this.post(target.url, body);
        return this.evaluate(retry.status);
      }
      return this.evaluate(res.status);
    } catch (err) {
      this.logger.error(`Webhook POST failed: ${(err as Error).message}`);
      return false;
    }
  }

  private post(url: string, body: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  private evaluate(status: number): boolean {
    const ok = status >= 200 && status < 300;
    if (!ok) this.logger.error(`Webhook returned HTTP ${status}.`);
    return ok;
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 30_000)
    : 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
