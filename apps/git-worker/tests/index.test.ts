// Native ESM: jest.mock()/require() do not work, so the collaborator is mocked with
// jest.unstable_mockModule and apps/git-worker is loaded with a dynamic import after the mock registers.
describe('apps/git-worker graceful shutdown', () => {
  let mockApp: { start: jest.Mock; shutdown: jest.Mock; isRunning: jest.Mock };
  let shutdownFns: Array<() => Promise<void>>;

  beforeEach(() => {
    jest.resetModules();

    shutdownFns = [];
    mockApp = {
      start: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockReturnValue(true),
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
