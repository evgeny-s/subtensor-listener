/**
 * Bounded in-memory set of already-notified event keys. The service is
 * stateless, so this only dedups within a single process lifetime: it prevents
 * the backfill window from overlapping the live subscription (and re-alerting),
 * but a process restart may re-alert an event still inside the backfill window.
 * That trade-off is intentional (no DB / no persistent disk).
 */
export class DedupCache {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize = 5000) {}

  has(key: string): boolean {
    return this.seen.has(key);
  }

  add(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.maxSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  /** Adds the key and reports whether it was new (i.e. should be acted on). */
  addIfNew(key: string): boolean {
    if (this.has(key)) return false;
    this.add(key);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
