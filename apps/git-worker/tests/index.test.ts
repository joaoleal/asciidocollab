// Native ESM: jest.mock()/require() do not work, so the collaborator is mocked with
// jest.unstable_mockModule and apps/git-worker is loaded with a dynamic import after the mock registers.
describe('apps/git-worker graceful shutdown', () => {
  let mockApp: {
    start: jest.Mock;
    shutdown: jest.Mock;
    isRunning: jest.Mock;
    config: { get: jest.Mock };
    getStatus: jest.Mock;
    stage: jest.Mock;
    unstage: jest.Mock;
    commit: jest.Mock;
  };
  let shutdownFns: Array<() => Promise<void>>;

  // Backs the mocked config's `.get()` with the same defaults `createGitWorkerConfig()` would
  // produce for the internal git-ops server's bind settings, so `index.ts`'s new startup logic
  // (reading host/port/secret/tls) runs unmodified against this fake app.
  const configValues: Record<string, unknown> = {
    internalGitHost: '127.0.0.1',
    internalGitPort: 0,
    internalGitSecret: '',
    'internalGitTls.cert': '',
    'internalGitTls.key': '',
    'internalGitTls.clientCa': '',
  };

  beforeEach(() => {
    jest.resetModules();

    shutdownFns = [];
    mockApp = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockReturnValue(true),
      config: { get: jest.fn((key: string) => configValues[key]) },
      getStatus: jest.fn(),
      stage: jest.fn(),
      unstage: jest.fn(),
      commit: jest.fn(),
    };

    jest.unstable_mockModule('../src/composition-root.js', () => ({
      compositionRoot: jest.fn().mockResolvedValue(mockApp),
    }));

    jest.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: (...arguments_: unknown[]) => void) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        shutdownFns.push(handler as () => Promise<void>);
      }
      return process;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('starts the app and shuts it down cleanly on SIGTERM/SIGINT', async () => {
    await import('../src/index.js');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockApp.start).toHaveBeenCalledTimes(1);
    expect(shutdownFns.length).toBeGreaterThan(0);

    await shutdownFns[0]();

    expect(mockApp.shutdown).toHaveBeenCalledTimes(1);
  });
});
