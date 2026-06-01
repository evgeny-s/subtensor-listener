import { DedupCache } from './dedup-cache';

describe('DedupCache', () => {
  it('treats the first occurrence as new and the rest as seen', () => {
    const cache = new DedupCache();
    expect(cache.addIfNew('a')).toBe(true);
    expect(cache.addIfNew('a')).toBe(false);
    expect(cache.has('a')).toBe(true);
  });

  it('evicts oldest keys past the max size (FIFO)', () => {
    const cache = new DedupCache(2);
    cache.add('a');
    cache.add('b');
    cache.add('c'); // evicts 'a'
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size).toBe(2);
  });
});
