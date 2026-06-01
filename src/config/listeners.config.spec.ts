import { ConfigService } from '@nestjs/config';
import { ListenersConfig } from './listeners.config';

function configWith(value: string | undefined): ConfigService {
  return {
    get: (key: string) => (key === 'LISTENERS' ? value : undefined),
  } as unknown as ConfigService;
}

const valid = JSON.stringify([
  {
    network: 'Finney Mainnet',
    endpoints: ['wss://entrypoint-finney.opentensor.ai:443'],
    events: [{ pallet: 'system', event: 'CodeUpdated' }],
    webhookUrl: 'https://hooks.slack.com/triggers/x/y/z',
  },
]);

describe('ListenersConfig', () => {
  it('returns an empty list when LISTENERS is unset', () => {
    expect(new ListenersConfig(configWith(undefined)).listeners).toEqual([]);
  });

  it('parses and exposes a valid definition', () => {
    const cfg = new ListenersConfig(configWith(valid));
    expect(cfg.listeners).toHaveLength(1);
    expect(cfg.listeners[0].network).toBe('Finney Mainnet');
    expect(cfg.listeners[0].events[0].event).toBe('CodeUpdated');
  });

  it('throws on non-JSON', () => {
    expect(() => new ListenersConfig(configWith('not json'))).toThrow(
      /not valid JSON/,
    );
  });

  it('throws when not an array', () => {
    expect(() => new ListenersConfig(configWith('{}'))).toThrow(
      /must be a JSON array/,
    );
  });

  it('throws with a field path when a definition is invalid', () => {
    const bad = JSON.stringify([
      { network: 'x', endpoints: [], events: [], webhookUrl: 'nope' },
    ]);
    expect(() => new ListenersConfig(configWith(bad))).toThrow(
      /Invalid LISTENERS config/,
    );
  });
});
