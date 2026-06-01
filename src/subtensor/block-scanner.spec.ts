import { isMatch } from './block-scanner.service';

describe('isMatch', () => {
  const filters = [
    { pallet: 'system', event: 'CodeUpdated' },
    { pallet: 'balances', event: 'Transfer' },
  ];

  it('matches a configured pallet+event', () => {
    expect(isMatch(filters, 'system', 'CodeUpdated')).toBe(true);
    expect(isMatch(filters, 'balances', 'Transfer')).toBe(true);
  });

  it('is case-sensitive and rejects partial matches', () => {
    expect(isMatch(filters, 'System', 'CodeUpdated')).toBe(false);
    expect(isMatch(filters, 'system', 'codeUpdated')).toBe(false);
    expect(isMatch(filters, 'system', 'ExtrinsicSuccess')).toBe(false);
  });
});
