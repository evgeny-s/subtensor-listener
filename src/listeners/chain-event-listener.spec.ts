import type { MatchedEvent } from '../subtensor/block-scanner.service';
import { dedupKey, specVersionChange } from './chain-event-listener';

const base: MatchedEvent = {
  pallet: 'system',
  event: 'CodeUpdated',
  data: '[]',
  blockNumber: 100,
  blockHash: '0xabc',
  timestampMs: 0,
  eventIndex: 3,
  specVersionFrom: null,
  specVersionTo: null,
};

describe('dedupKey', () => {
  it('is unique per network/event/arguments', () => {
    expect(dedupKey('Finney', base)).toBe('Finney|system.CodeUpdated|[]');
  });

  it('ignores block number and position (a reorg must not re-alert)', () => {
    expect(
      dedupKey('Finney', { ...base, blockNumber: 101, eventIndex: 7 }),
    ).toBe(dedupKey('Finney', base));
  });

  it('differs when the event arguments differ', () => {
    expect(dedupKey('Finney', { ...base, data: '["0xdead"]' })).not.toBe(
      dedupKey('Finney', base),
    );
  });
});

describe('specVersionChange', () => {
  it('renders an upgrade transition', () => {
    expect(
      specVersionChange({ ...base, specVersionFrom: 180, specVersionTo: 181 }),
    ).toBe('180 → 181');
  });

  it('marks an unchanged version', () => {
    expect(
      specVersionChange({ ...base, specVersionFrom: 181, specVersionTo: 181 }),
    ).toBe('unchanged (181)');
  });

  it('falls back to the target version when the parent is unknown', () => {
    expect(
      specVersionChange({ ...base, specVersionFrom: null, specVersionTo: 181 }),
    ).toBe('181');
  });

  it('reports unknown when neither version could be read', () => {
    expect(specVersionChange(base)).toBe('unknown');
  });
});
