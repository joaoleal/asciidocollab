import { createCollabServer, parsePresenceRoom, parseRoomName } from '../src/server';
import { isPresenceRoom } from '@asciidocollab/shared';
import { PersistenceExtension } from '../src/extensions/persistence';
import type {
  YjsStateStore,
  ProjectFileStore,
  DocumentRepository,
  FileNodeRepository,
  SystemSettingRepository,
} from '@asciidocollab/domain';

function makeExtension() {
  return new PersistenceExtension(
    { load: jest.fn(), save: jest.fn(), delete: jest.fn(), deleteAllForProject: jest.fn() } as unknown as YjsStateStore,
    { read: jest.fn(), write: jest.fn(), createExclusive: jest.fn(), remove: jest.fn(), move: jest.fn(), createDirectory: jest.fn(), removeDirectory: jest.fn(), removeProject: jest.fn(), readStream: jest.fn() } as unknown as ProjectFileStore,
    { findByYjsStateId: jest.fn(), findById: jest.fn(), findByFileNodeId: jest.fn(), findByFileNodeIds: jest.fn(), save: jest.fn(), delete: jest.fn() } as unknown as DocumentRepository,
    { findById: jest.fn(), findByParentId: jest.fn(), findByProjectId: jest.fn(), findByPath: jest.fn(), save: jest.fn(), delete: jest.fn(), findDescendants: jest.fn(), findByProjectIdAndType: jest.fn(), deleteAllForProject: jest.fn() } as unknown as FileNodeRepository,
  );
}

describe('createCollabServer', () => {
  it('initialises server with persistence extension registered', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo);

    expect(server).toBeDefined();
    expect(typeof server.destroy).toBe('function');
  });

  it('maxDebounce reflects the configured writeback interval', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('60'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo);

    const config = (server as { configuration?: { maxDebounce?: number } }).configuration;
    if (config) {
      expect(config.maxDebounce).toBe(60_000);
    }
  });

  it('registers onConnect and onDisconnect handlers when session callbacks are provided', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const sessionCallbacks = {
      onRoomOpen: jest.fn().mockResolvedValue({ success: true, value: undefined }),
      onRoomClose: jest.fn().mockResolvedValue({ success: true, value: undefined }),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    // Verify the server is configured with both hooks
    const cfg = (server as { configuration?: { onConnect?: unknown; onDisconnect?: unknown } }).configuration;
    if (cfg) {
      expect(typeof cfg.onConnect).toBe('function');
      expect(typeof cfg.onDisconnect).toBe('function');
    }
  });

  it('onConnect stores documentId in payload.context so onDisconnect can skip the second DB lookup', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const documentId = { value: '550e8400-e29b-41d4-a716-446655440010' };
    const mockDocument = { id: documentId, fileNodeId: { value: '550e8400-e29b-41d4-a716-446655440011' } };

    const sessionCallbacks = {
      onRoomOpen: jest.fn().mockResolvedValue({ success: true, value: undefined }),
      onRoomClose: jest.fn().mockResolvedValue({ success: true, value: undefined }),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue(mockDocument),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onConnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onConnect) return;

    const context: Record<string, unknown> = {};
    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    await cfg.onConnect({ documentName: `${projectId}/${yjsStateId}`, context });

    expect(context.documentId).toBe(documentId);
  });

  it('onDisconnect skips onRoomClose when new client joined after the last client left (TOCTOU guard)', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const documentId = { value: '550e8400-e29b-41d4-a716-446655440010' };
    const sessionCallbacks = {
      onRoomOpen: jest.fn().mockResolvedValue({ success: true, value: undefined }),
      onRoomClose: jest.fn().mockResolvedValue({ success: true, value: undefined }),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn(),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    // Simulate a new client having joined before onDisconnect fires (getConnectionsCount > 0).
    const mockHocuspocusDocument = { getConnectionsCount: jest.fn().mockReturnValue(1) };
    await cfg.onDisconnect({
      clientsCount: 0,
      documentName: `${projectId}/${yjsStateId}`,
      context: { documentId },
      document: mockHocuspocusDocument,
    });

    expect(sessionCallbacks.onRoomClose).not.toHaveBeenCalled();
  });

  it('creates successfully when session callbacks are omitted', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo);

    expect(server).toBeDefined();
    expect(typeof server.destroy).toBe('function');
  });

  it('onConnect REJECTS when the document is not found (no untracked live room; preserves the edit lock)', async () => {
    // onConnect rejects on ANY failure rather than letting a live room exist without its session
    // row. A document-not-found here is a sub-millisecond delete race (auth already confirmed the
    // document existed); rejecting is consistent with the onRoomOpen-failure path and avoids an
    // untracked connection that would mismatch onDisconnect's counting. onRoomOpen is not called.
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn(),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue(null), // document not found
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onConnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onConnect) return;

    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    const context: Record<string, unknown> = {};
    await expect(
      cfg.onConnect({ documentName: `${projectId}/${yjsStateId}`, context }),
    ).rejects.toThrow('Document not found');
    expect(sessionCallbacks.onRoomOpen).not.toHaveBeenCalled();
    expect(context.documentId).toBeUndefined();
  });

  it('onConnect REJECTS when onRoomOpen fails for an existing document (preserves the edit lock)', async () => {
    // The document EXISTS but the active-session row could not be created. The connection must be
    // rejected, NOT failed open: a live room without a session row would let a concurrent REST
    // PUT /content bypass spec-018's active-session edit lock. (Trade-off: a rejection
    // here fires no onDisconnect, so a repeated failure during a DB outage can inflate the user's
    // ConnectionLimit count until restart — an accepted availability cost to protect data.)
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const mockDocument = { id: { value: 'doc-id' }, fileNodeId: { value: 'fn-id' } };
    const sessionCallbacks = {
      onRoomOpen: jest.fn().mockResolvedValue({ success: false, error: new Error('DB unavailable') }),
      onRoomClose: jest.fn(),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue(mockDocument),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onConnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onConnect) return;

    const context: Record<string, unknown> = {};
    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    await expect(
      cfg.onConnect({ documentName: `${projectId}/${yjsStateId}`, context }),
    ).rejects.toThrow('DB unavailable');

    expect(context.documentId).toBeUndefined();
  });

  it('onDisconnect resolves the documentId by lookup when context lacks it, and closes the session', async () => {
    // Regression: Hocuspocus does not preserve the onConnect-mutated context into onDisconnect,
    // so context.documentId is absent in practice. onDisconnect must still resolve the document
    // (by yjsStateId) and close the session — otherwise the room never closes and the file
    // becomes permanently undeletable (an active-session 409).
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn().mockResolvedValue({ success: true, value: undefined }),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue({ id: { value: '550e8400-e29b-41d4-a716-446655440010' } }),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);
    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    await cfg.onDisconnect({
      clientsCount: 0,
      documentName: '550e8400-e29b-41d4-a716-446655440001/550e8400-e29b-41d4-a716-446655440002',
      context: {}, // Hocuspocus did not carry documentId across hooks
      document: { getConnectionsCount: jest.fn().mockReturnValue(0) },
      instance: { storeDocumentHooks: jest.fn() },
    });

    expect(documentRepository.findByYjsStateId).toHaveBeenCalled();
    expect(sessionCallbacks.onRoomClose).toHaveBeenCalledTimes(1);
  });

  it('onDisconnect does nothing when the document cannot be resolved', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn(),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    const mockHocuspocusDocument = { getConnectionsCount: jest.fn().mockReturnValue(0) };

    await cfg.onDisconnect({
      clientsCount: 0,
      documentName: `${projectId}/${yjsStateId}`,
      context: {}, // no documentId stored
      document: mockHocuspocusDocument,
    });

    expect(sessionCallbacks.onRoomClose).not.toHaveBeenCalled();
  });

  it('onDisconnect logs error but does not throw when onRoomClose fails', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const documentId = { value: '550e8400-e29b-41d4-a716-446655440010' };
    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn().mockResolvedValue({ success: false, error: new Error('Close failed') }),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn(),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    const mockHocuspocusDocument = { getConnectionsCount: jest.fn().mockReturnValue(0) };

    await expect(
      cfg.onDisconnect({
        clientsCount: 0,
        documentName: `${projectId}/${yjsStateId}`,
        context: { documentId },
        document: mockHocuspocusDocument,
        instance: { storeDocumentHooks: jest.fn() },
      }),
    ).resolves.toBeUndefined(); // must not throw

    expect(sessionCallbacks.onRoomClose).toHaveBeenCalledTimes(1);
  });

  it('uses the default writeback interval when the system setting is not configured', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo);

    expect(server).toBeDefined();
  });

  it('skips onDisconnect processing when other clients are still connected (clientsCount > 0)', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn(),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn(),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    // clientsCount > 0 means other clients remain — handler must return early
    await cfg.onDisconnect({
      clientsCount: 2,
      documentName: `${projectId}/${yjsStateId}`,
      context: {},
      document: { getConnectionsCount: jest.fn().mockReturnValue(2) },
    });

    expect(documentRepository.findByYjsStateId).not.toHaveBeenCalled();
    expect(sessionCallbacks.onRoomClose).not.toHaveBeenCalled();
  });

  it('wires a max-payload guard into the server when maxPayloadBytes is configured', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const extension = makeExtension();
    const server = await createCollabServer(
      { port: 0, maxPayloadBytes: 1024 },
      [extension],
      settingRepo,
    );

    const cfg = (server as { configuration?: { beforeHandleMessage?: unknown } }).configuration;
    if (cfg) {
      expect(typeof cfg.beforeHandleMessage).toBe('function');
    }
  });

  it('onDisconnect catches and logs when onRoomClose throws (not just fails)', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const documentId = { value: '550e8400-e29b-41d4-a716-446655440010' };
    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn().mockRejectedValue(new Error('DB connection lost')),
    };

    const documentRepository = {
      findByYjsStateId: jest.fn(),
      findById: jest.fn(),
      findByFileNodeId: jest.fn(),
      findByFileNodeIds: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    } as unknown as DocumentRepository;

    const extension = makeExtension();
    const server = await createCollabServer({ port: 0 }, [extension], settingRepo, sessionCallbacks, documentRepository);

    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    const projectId = '550e8400-e29b-41d4-a716-446655440001';
    const yjsStateId = '550e8400-e29b-41d4-a716-446655440002';
    const mockHocuspocusDocument = { getConnectionsCount: jest.fn().mockReturnValue(0) };

    // When onRoomClose rejects, onDisconnect must absorb the error and not propagate it
    await expect(
      cfg.onDisconnect({
        clientsCount: 0,
        documentName: `${projectId}/${yjsStateId}`,
        context: { documentId },
        document: mockHocuspocusDocument,
        instance: { storeDocumentHooks: jest.fn() },
      }),
    ).resolves.toBeUndefined();

    expect(sessionCallbacks.onRoomClose).toHaveBeenCalledTimes(1);
  });

  // The write-back MUST be flushed before the session row is deleted. GetFileNodeContentUseCase only
  // reads a document's live text while its session row exists and otherwise trusts the file-store
  // projection, so closing first exposes a window where the row is gone and the projection is still
  // pre-edit — and the web client caches content write-once, so one stale read sticks for the session.
  it('flushes the pending write-back BEFORE closing the collaboration session', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const documentId = { value: '550e8400-e29b-41d4-a716-446655440010' };
    const order: string[] = [];
    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn().mockImplementation(async () => {
        order.push('close');
        return { success: true };
      }),
    } as unknown as Parameters<typeof createCollabServer>[3];
    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue({ id: documentId }),
    } as unknown as Parameters<typeof createCollabServer>[4];

    const server = await createCollabServer({ port: 0 }, [makeExtension()], settingRepo, sessionCallbacks, documentRepository);
    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) throw new Error('onDisconnect was not configured');

    const storeDocumentHooks = jest.fn().mockImplementation(async () => {
      order.push('store');
    });

    await cfg.onDisconnect({
      clientsCount: 0,
      documentName: '550e8400-e29b-41d4-a716-446655440001/550e8400-e29b-41d4-a716-446655440002',
      context: { documentId },
      document: { getConnectionsCount: jest.fn().mockReturnValue(0) },
      instance: { storeDocumentHooks },
    });

    expect(order).toEqual(['store', 'close']);
    // `immediately` must be true, or the store stays behind its debounce and the window reopens.
    expect(storeDocumentHooks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientsCount: 0 }), true);
  });

  // A stuck or failing store must never keep the session row alive: an orphaned active session 409s
  // REST writes and makes the file undeletable, which is strictly worse than a lagging projection.
  it('still closes the session when the write-back flush throws', async () => {
    const settingRepo = {
      get: jest.fn().mockResolvedValue('30'),
      set: jest.fn(),
    } as unknown as SystemSettingRepository;

    const documentId = { value: '550e8400-e29b-41d4-a716-446655440010' };
    const sessionCallbacks = {
      onRoomOpen: jest.fn(),
      onRoomClose: jest.fn().mockResolvedValue({ success: true }),
    } as unknown as Parameters<typeof createCollabServer>[3];
    const documentRepository = {
      findByYjsStateId: jest.fn().mockResolvedValue({ id: documentId }),
    } as unknown as Parameters<typeof createCollabServer>[4];

    const server = await createCollabServer({ port: 0 }, [makeExtension()], settingRepo, sessionCallbacks, documentRepository);
    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) throw new Error('onDisconnect was not configured');

    await expect(
      cfg.onDisconnect({
        clientsCount: 0,
        documentName: '550e8400-e29b-41d4-a716-446655440001/550e8400-e29b-41d4-a716-446655440002',
        context: { documentId },
        document: { getConnectionsCount: jest.fn().mockReturnValue(0) },
        instance: { storeDocumentHooks: jest.fn().mockRejectedValue(new Error('store wedged')) },
      }),
    ).resolves.toBeUndefined();

    expect(sessionCallbacks.onRoomClose).toHaveBeenCalledTimes(1);
  });
});

// Feature 024: presence rooms (`presence/<projectId>`) are a distinct room type.
describe('presence room helpers', () => {
  const projectId = '550e8400-e29b-41d4-a716-446655440001';

  it('isPresenceRoom distinguishes presence rooms from document rooms', () => {
    expect(isPresenceRoom(`presence/${projectId}`)).toBe(true);
    expect(isPresenceRoom(`${projectId}/550e8400-e29b-41d4-a716-446655440002`)).toBe(false);
  });

  it('parsePresenceRoom extracts the projectId', () => {
    expect(parsePresenceRoom(`presence/${projectId}`).projectId.value).toBe(projectId);
  });

  it('parsePresenceRoom rejects a non-presence room name', () => {
    expect(() => parsePresenceRoom(`${projectId}/x`)).toThrow();
  });

  it('parseRoomName still rejects a malformed name', () => {
    expect(() => parseRoomName('no-slash')).toThrow();
  });
});

function makePresenceLifecycleDeps() {
  const settingRepo = { get: jest.fn().mockResolvedValue('30'), set: jest.fn() } as unknown as SystemSettingRepository;
  const sessionCallbacks = {
    onRoomOpen: jest.fn().mockResolvedValue({ success: true, value: undefined }),
    onRoomClose: jest.fn().mockResolvedValue({ success: true, value: undefined }),
  };
  const documentRepository = {
    findByYjsStateId: jest.fn().mockResolvedValue(null),
    findById: jest.fn(), findByFileNodeId: jest.fn(), findByFileNodeIds: jest.fn(), save: jest.fn(), delete: jest.fn(),
  } as unknown as DocumentRepository;
  return { settingRepo, sessionCallbacks, documentRepository };
}

describe('createCollabServer session lifecycle skips presence rooms', () => {
  const projectId = '550e8400-e29b-41d4-a716-446655440001';

  it('onConnect does not open a session (or look up a document) for a presence room', async () => {
    const { settingRepo, sessionCallbacks, documentRepository } = makePresenceLifecycleDeps();
    const server = await createCollabServer({ port: 0 }, [makeExtension()], settingRepo, sessionCallbacks, documentRepository);
    const cfg = (server as { configuration?: { onConnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onConnect) return;

    await expect(cfg.onConnect({ documentName: `presence/${projectId}`, context: {} })).resolves.toBeUndefined();
    expect(sessionCallbacks.onRoomOpen).not.toHaveBeenCalled();
    expect((documentRepository.findByYjsStateId as jest.Mock)).not.toHaveBeenCalled();
  });

  it('onDisconnect does not close a session for a presence room', async () => {
    const { settingRepo, sessionCallbacks, documentRepository } = makePresenceLifecycleDeps();
    const server = await createCollabServer({ port: 0 }, [makeExtension()], settingRepo, sessionCallbacks, documentRepository);
    const cfg = (server as { configuration?: { onDisconnect?: (p: unknown) => Promise<void> } }).configuration;
    if (!cfg?.onDisconnect) return;

    await expect(
      cfg.onDisconnect({ clientsCount: 0, documentName: `presence/${projectId}`, context: {}, document: { getConnectionsCount: () => 0 } }),
    ).resolves.toBeUndefined();
    expect(sessionCallbacks.onRoomClose).not.toHaveBeenCalled();
  });
});
