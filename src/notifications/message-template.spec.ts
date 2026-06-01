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
      blockNumber: '8283784',
      specVersionChange: '402 → 411',
      timestampUtc: '28 May 2026 15:54 UTC',
      explorerUrl: 'https://polkadot.js.org/apps/#/explorer/query/0xabc',
    });
    expect(out).toContain('🚨 CodeUpdated on Finney Mainnet');
    expect(out).toContain('#8283784');
    expect(out).toContain('402 → 411');
    expect(out).toContain('https://polkadot.js.org/apps/');
    // Hash line was removed — the explorer link covers it.
    expect(out).not.toContain('Hash');
    // No literal mrkdwn that a Slack workflow variable wouldn't render.
    expect(out).not.toContain('*');
    expect(out).not.toContain('`');
  });
});
