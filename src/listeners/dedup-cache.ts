/**
 * How close (in blocks) two matches of the same event (type + arguments) must
 * be to count as duplicates. Covers both the backfill/live overlap and a reorg
 * moving an already-alerted event to a nearby block. Subtensor reorgs are 1–2
 * blocks deep, so 5 is comfortably above that. Deliberately not
 * env-configurable.
 */
export const DEDUP_WINDOW_BLOCKS = 5;

/**
 * In-memory dedup: remembers the block number of the last alert per key
 * (event type + arguments) and suppresses further matches within the window.
 * Suppressed matches do NOT move the marker, so a continuous stream of
 * matching blocks still alerts once per window rather than never. Bounded:
 * the oldest entries are evicted past `maxSize`.
 *
 * The service is stateless, so this only dedups within a single process
 * lifetime: a restart may re-alert an event still inside the backfill window.
 * That trade-off is intentional (no DB / no persistent disk).
 */
export class DedupCache {
  /** Insertion-ordered; re-alerting refreshes the entry's position. */
  private readonly lastAlerted = new Map<string, number>();

  constructor(
    private readonly windowBlocks = DEDUP_WINDOW_BLOCKS,
    private readonly maxSize = 5000,
  ) {}

  /**
   * Reports whether an alert at `blockNumber` should fire for `key`, and
   * records it if so. The window is symmetric (absolute distance) so a reorg
   * that re-includes the event in a slightly *earlier* block is also caught.
   */
  shouldAlert(key: string, blockNumber: number): boolean {
    const last = this.lastAlerted.get(key);
    if (
      last !== undefined &&
      Math.abs(blockNumber - last) <= this.windowBlocks
    ) {
      return false;
    }
    this.lastAlerted.delete(key);
    this.lastAlerted.set(key, blockNumber);
    if (this.lastAlerted.size > this.maxSize) {
      for (const oldest of this.lastAlerted.keys()) {
        this.lastAlerted.delete(oldest);
        break;
      }
    }
    return true;
  }

  get size(): number {
    return this.lastAlerted.size;
  }
}
