// Native ESM: jest.mock()/require() do not work, so the collaborators are mocked with
// jest.unstable_mockModule and apps/collab is loaded with a dynamic import after the mocks register.
describe('apps/collab graceful shutdown', () => {
  let mockServer: { destroy: jest.Mock; listen: jest.Mock; hocuspocus: { documents: Map<string, unknown> } };
  let mockCollaborationSessionRepo: { closeAll: jest.Mock };
  let mockPrisma: { $disconnect: jest.Mock };
  let mockEditServerClose: jest.Mock;
  let shutdownFns: Array<() => Promise<void>>;

  beforeEach(() => {
    jest.resetModules();

    shutdownFns = [];
    mockServer = {
      destroy: jest.fn().mockResolvedValue(undefined),
      listen: jest.fn().mockResolvedValue(undefined),
      // v4: the live-document map lives on the inner Hocuspocus instance (server.hocuspocus).
      hocuspocus: { documents: new Map() },
    };
    mockCollaborationSessionRepo = { closeAll: jest.fn().mockResolvedValue(undefined) };
    mockPrisma = { $disconnect: jest.fn().mockResolvedValue(undefined) };
    mockEditServerClose = jest.fn((callback: () => void) => callback());

    jest.unstable_mockModule('../src/composition-root.js', () => ({
      compositionRoot: jest.fn().mockResolvedValue({
        server: mockServer,
        collaborationSessionRepo: mockCollaborationSessionRepo,
        prisma: mockPrisma,
        documentRepository: { findByYjsStateId: jest.fn() },
        config: { get: jest.fn((key: string) => (key === 'internalEditHost' ? '127.0.0.1' : 0)) },
        mtlsFetch: undefined,
      }),
    }));
    // This suite exercises the shutdown sequence, not storage; stub the startup storage check.
    jest.unstable_mockModule('../src/storage-probe.js', () => ({
      verifySharedStorage: jest.fn().mockResolvedValue(undefined),
    }));
    // The internal edit server would bind a real port otherwise; stub it to a closeable handle.
    jest.unstable_mockModule('../src/internal-edit-server.js', () => ({
      startInternalEditServer: jest.fn().mockReturnValue({ close: mockEditServerClose }),
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

  it('shutdown sequence: destroy → closeAll → $disconnect', async () => {
    await import('../src/index.js');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(shutdownFns.length).toBeGreaterThan(0);

    await shutdownFns[0]();

    const destroyOrder = mockServer.destroy.mock.invocationCallOrder[0];
    const closeAllOrder = mockCollaborationSessionRepo.closeAll.mock.invocationCallOrder[1];
    const disconnectOrder = mockPrisma.$disconnect.mock.invocationCallOrder[0];

    // The internal edit server is closed during shutdown too.
    expect(mockEditServerClose).toHaveBeenCalledTimes(1);
    expect(mockServer.destroy).toHaveBeenCalledTimes(1);
    expect(mockCollaborationSessionRepo.closeAll).toHaveBeenCalledTimes(2);
    expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);

    if (destroyOrder && closeAllOrder && disconnectOrder) {
      expect(destroyOrder).toBeLessThan(closeAllOrder);
      expect(closeAllOrder).toBeLessThan(disconnectOrder);
    }
  });
});
