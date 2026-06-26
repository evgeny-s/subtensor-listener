import { DedupCache, DEDUP_WINDOW_BLOCKS } from './dedup-cache';

describe('DedupCache', () => {
  it('alerts on the first occurrence of a key', () => {
    const cache = new DedupCache();
    expect(cache.shouldAlert('a', 100)).toBe(true);
  });

  it('suppresses a repeat within the window', () => {
    const cache = new DedupCache();
    cache.shouldAlert('a', 100);
    expect(cache.shouldAlert('a', 100)).toBe(false);
    expect(cache.shouldAlert('a', 100 + DEDUP_WINDOW_BLOCKS)).toBe(false);
  });

  it('suppresses a reorged event landing in an earlier block', () => {
    const cache = new DedupCache();
    cache.shouldAlert('a', 100);
    expect(cache.shouldAlert('a', 99)).toBe(false);
  });

  it('alerts again beyond the window', () => {
    const cache = new DedupCache();
    cache.shouldAlert('a', 100);
    expect(cache.shouldAlert('a', 100 + DEDUP_WINDOW_BLOCKS + 1)).toBe(true);
  });

  it('does not let suppressed matches slide the window forward', () => {
    const cache = new DedupCache(5);
    cache.shouldAlert('a', 100);
    // A continuous stream of matches: 101..105 suppressed, 106 alerts again.
    for (let n = 101; n <= 105; n++) {
      expect(cache.shouldAlert('a', n)).toBe(false);
    }
    expect(cache.shouldAlert('a', 106)).toBe(true);
  });

  it('tracks keys independently', () => {
    const cache = new DedupCache();
    cache.shouldAlert('a', 100);
    expect(cache.shouldAlert('b', 100)).toBe(true);
  });

  it('evicts the oldest keys past the max size', () => {
    const cache = new DedupCache(5, 2);
    cache.shouldAlert('a', 100);
    cache.shouldAlert('b', 100);
    cache.shouldAlert('c', 100); // evicts 'a'
    expect(cache.size).toBe(2);
    expect(cache.shouldAlert('a', 100)).toBe(true); // forgotten → alerts again
  });
});
