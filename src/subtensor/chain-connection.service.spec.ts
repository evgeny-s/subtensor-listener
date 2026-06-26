/**
 * Regression test for the runtime-upgrade connection recreation.
 *
 * On a `specVersion` change, `@polkadot/api` downgrades a live connection's
 * metadata to V14 (via the legacy `state_getMetadata` RPC), which corrupts
 * decoding around the upgrade boundary. {@link ChainConnectionService} guards
 * against this by recreating the connection when the runtime version changes.
 * These tests drive a mocked `@polkadot/api` to assert that behaviour.
 */
import { ChainConnectionService } from './chain-connection.service';

type Handlers = Record<string, () => void>;

class FakeProvider {
  handlers: Handlers = {};
  disconnect = jest.fn().mockResolvedValue(undefined);
  constructor(public endpoints: string[]) {}
  on(event: string, cb: () => void): void {
    this.handlers[event] = cb;
  }
  emit(event: string): void {
    this.handlers[event]?.();
  }
}

type VersionCb = (rv: { specVersion: { toNumber: () => number } }) => void;

class FakeApi {
  isReady: Promise<FakeApi> = Promise.resolve(this);
  versionCb: VersionCb | null = null;
  unsub = jest.fn();
  disconnect = jest.fn().mockResolvedValue(undefined);
  rpc = {
    state: {
      subscribeRuntimeVersion: (cb: VersionCb): Promise<() => void> => {
        this.versionCb = cb;
        return Promise.resolve(this.unsub);
      },
    },
  };
  /** Drives a runtime-version notification to the service's watcher. */
  fireVersion(spec: number): void {
    this.versionCb?.({ specVersion: { toNumber: () => spec } });
  }
}

const providers: FakeProvider[] = [];
const apis: FakeApi[] = [];

jest.mock('@polkadot/api', () => ({
  WsProvider: jest.fn().mockImplementation((endpoints: string[]) => {
    const p = new FakeProvider(endpoints);
    providers.push(p);
    return p;
  }),
  ApiPromise: {
    create: jest.fn().mockImplementation(() => {
      const a = new FakeApi();
      apis.push(a);
      return Promise.resolve(a);
    }),
  },
}));

/** Flush pending microtasks (the version watcher is wired up asynchronously). */
const flush = () => new Promise((r) => setImmediate(r));

describe('ChainConnectionService — runtime-upgrade recreation', () => {
  const endpoints = ['ws://127.0.0.1:9944'];
  let service: ChainConnectionService;

  beforeEach(() => {
    providers.length = 0;
    apis.length = 0;
    service = new ChainConnectionService();
  });

  afterEach(async () => {
    await service.onApplicationShutdown();
    jest.clearAllMocks();
  });

  it('recreates the connection on a specVersion change and re-fires reconnect handlers', async () => {
    const onReconnect = jest.fn();
    service.onReconnect(endpoints, onReconnect);

    await service.getConnection(endpoints);
    await flush(); // let the version watcher subscribe on the first api

    expect(apis).toHaveLength(1);
    providers[0].emit('connected'); // initial connect (not a reconnect)
    expect(onReconnect).not.toHaveBeenCalled();

    apis[0].fireVersion(424); // baseline spec — must not recreate
    await flush();
    expect(apis).toHaveLength(1);

    apis[0].fireVersion(425); // upgrade — must recreate
    await flush();

    expect(apis).toHaveLength(2); // a fresh api was created
    expect(apis[0].disconnect).toHaveBeenCalled(); // the stale one was torn down

    providers[1].emit('connected'); // fresh connection comes up
    expect(onReconnect).toHaveBeenCalledTimes(1); // listeners are told to re-attach

    // getConnection now hands out the fresh api, not the downgraded one.
    await expect(service.getConnection(endpoints)).resolves.toBe(apis[1]);
  });

  it('does not recreate when the specVersion is unchanged', async () => {
    service.onReconnect(endpoints, jest.fn());
    await service.getConnection(endpoints);
    await flush();

    apis[0].fireVersion(424);
    apis[0].fireVersion(424);
    apis[0].fireVersion(424);
    await flush();

    expect(apis).toHaveLength(1);
    expect(apis[0].disconnect).not.toHaveBeenCalled();
  });

  it('tears down the version watch and disconnects the api on shutdown', async () => {
    service.onReconnect(endpoints, jest.fn());
    await service.getConnection(endpoints);
    await flush(); // let the version watcher subscribe (sets versionUnsub)

    await service.onApplicationShutdown();

    expect(apis[0].unsub).toHaveBeenCalled(); // version subscription torn down
    expect(apis[0].disconnect).toHaveBeenCalled(); // socket closed
  });

  it('refuses to hand out connections once shutting down', async () => {
    await service.onApplicationShutdown();
    await expect(service.getConnection(endpoints)).rejects.toThrow(
      /shutting down/,
    );
  });
});
