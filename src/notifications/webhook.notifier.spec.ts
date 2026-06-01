import { WebhookNotifier } from './webhook.notifier';

describe('WebhookNotifier', () => {
  afterEach(() => jest.restoreAllMocks());

  it('posts the message under the configured field and returns true on 2xx', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const notifier = new WebhookNotifier();

    const ok = await notifier.send(
      { url: 'https://hooks.example/triggers/x', field: 'text' },
      'hello',
    );

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ text: 'hello' }));
  });

  it('defaults the field to "text"', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const notifier = new WebhookNotifier();

    await notifier.send({ url: 'https://hooks.example/x' }, 'hi');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ text: 'hi' }));
  });

  it('returns false (swallows) on a network error', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const notifier = new WebhookNotifier();

    expect(await notifier.send({ url: 'https://hooks.example/x' }, 'hi')).toBe(
      false,
    );
  });

  it('retries once on HTTP 429 then succeeds', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('rate', { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const notifier = new WebhookNotifier();

    const ok = await notifier.send({ url: 'https://hooks.example/x' }, 'hi');

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
