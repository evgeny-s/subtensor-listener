import { DEFAULT_TEMPLATE, renderMessage } from './message-template';

describe('renderMessage', () => {
  it('interpolates known tokens', () => {
    const out = renderMessage('{{event}} on {{network}}', {
      event: 'CodeUpdated',
      network: 'Finney Mainnet',
    });
    expect(out).toBe('CodeUpdated on Finney Mainnet');
  });

  it('replaces missing tokens with empty string (never the literal token)', () => {
    const out = renderMessage('a {{missing}} b', {});
    expect(out).toBe('a  b');
    expect(out).not.toContain('{{');
  });

  it('drops lines that end up blank after interpolation', () => {
    const out = renderMessage('keep me\n{{gone}}\nkeep me too', {});
    expect(out).toBe('keep me\nkeep me too');
  });

  it('renders the default template with chain-event vars', () => {
    const out = renderMessage(DEFAULT_TEMPLATE, {
      event: 'CodeUpdated',
      network: 'Finney Mainnet',
      pallet: 'system',
      blockNumber: '1234567',
      blockHash: '0xabc',
      specVersionChange: '180 → 181',
      timestamp: '2026-06-01T12:00:00.000Z',
    });
    expect(out).toContain('CodeUpdated');
    expect(out).toContain('Finney Mainnet');
    expect(out).toContain('1234567');
    expect(out).toContain('180 → 181');
  });
});
