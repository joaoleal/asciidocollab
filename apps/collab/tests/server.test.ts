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
import type { Logger } from 'pino';

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
    } as unknown as NonNullable<Parameters<typeof createCollabServer>[3]>;
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
    } as unknown as NonNullable<Parameters<typeof createCollabServer>[3]>;
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

// ---------------------------------------------------------------------------------------------
// Session-hook contract. The hooks are the only place the collab server decides whether a room may
// live, and every failure they absorb leaves nothing behind but a log record — so the record IS the
// contract. The specs below assert the observable effect of each guard (both outcomes, where a
// guard has two) and the WHOLE logged payload plus its exact message, never merely that a logger
// was called.
// ---------------------------------------------------------------------------------------------

const hookProjectId = '550e8400-e29b-41d4-a716-446655440001';
const hookYjsStateId = '550e8400-e29b-41d4-a716-446655440002';
const hookRoomName = `${hookProjectId}/${hookYjsStateId}`;
const hookDocumentId = { value: '550e8400-e29b-41d4-a716-446655440010' };

type SessionCallbacksArgument = NonNullable<Parameters<typeof createCollabServer>[3]>;
type DocumentLookupArgument = Parameters<typeof createCollabServer>[4];

interface RecordingLogger {
  error: jest.Mock;
  warn: jest.Mock;
  info: jest.Mock;
  debug: jest.Mock;
}

interface RecordingSessionCallbacks {
  onRoomOpen: jest.Mock;
  onRoomClose: jest.Mock;
}

interface CollabHooks {
  onConnect?: (payload: unknown) => Promise<void>;
  onDisconnect?: (payload: unknown) => Promise<void>;
}

function makeRecordingLogger(): RecordingLogger {
  return { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
}

function makeSettingRepo(value: string | null = '30'): SystemSettingRepository {
  return { get: jest.fn().mockResolvedValue(value), set: jest.fn() } as unknown as SystemSettingRepository;
}

function makeSessionCallbacks(overrides: Partial<RecordingSessionCallbacks> = {}): RecordingSessionCallbacks {
  return {
    onRoomOpen: overrides.onRoomOpen ?? jest.fn().mockResolvedValue({ success: true, value: undefined }),
    onRoomClose: overrides.onRoomClose ?? jest.fn().mockResolvedValue({ success: true, value: undefined }),
  };
}

function makeDocumentLookup(document: unknown): DocumentLookupArgument {
  return { findByYjsStateId: jest.fn().mockResolvedValue(document) } as unknown as DocumentLookupArgument;
}

function lookupCalls(documentRepository: DocumentLookupArgument): jest.Mock {
  return (documentRepository as unknown as { findByYjsStateId: jest.Mock }).findByYjsStateId;
}

async function hooksOf(options: {
  logger?: RecordingLogger;
  sessionCallbacks?: RecordingSessionCallbacks;
  documentRepository?: DocumentLookupArgument;
  settingRepo?: SystemSettingRepository;
}): Promise<CollabHooks> {
  const server = await createCollabServer(
    { port: 0, ...(options.logger && { logger: options.logger as unknown as Logger }) },
    [makeExtension()],
    options.settingRepo ?? makeSettingRepo(),
    options.sessionCallbacks as unknown as SessionCallbacksArgument | undefined,
    options.documentRepository,
  );
  return (server as unknown as { configuration: CollabHooks }).configuration;
}

/** A last-client-left disconnect payload for the content room, with a working store + document. */
function disconnectPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientsCount: 0,
    documentName: hookRoomName,
    context: { documentId: hookDocumentId },
    document: { getConnectionsCount: jest.fn().mockReturnValue(0) },
    instance: { storeDocumentHooks: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('room-name parsers reject a malformed name with an exact, actionable message', () => {
  it('parsePresenceRoom names the expected shape and the offending room', () => {
    // A content room is not a presence room: the message must say so, rather than the UUID
    // validation error a fabricated slice would raise.
    expect(() => parsePresenceRoom(hookRoomName)).toThrow(
      new Error(`Invalid presence room name (expected "presence/<projectId>"): ${hookRoomName}`),
    );
  });

  it('parsePresenceRoom accepts a presence room and returns its typed projectId', () => {
    expect(parsePresenceRoom(`presence/${hookProjectId}`).projectId.value).toBe(hookProjectId);
  });

  it('parseRoomName names the expected shape and the offending room', () => {
    expect(() => parseRoomName('no-slash')).toThrow(
      new Error('Invalid room name (expected "<projectId>/<yjsStateId>"): no-slash'),
    );
  });

  it('parseRoomName rejects a name whose second half is empty', () => {
    expect(() => parseRoomName(`${hookProjectId}/`)).toThrow(
      new Error(`Invalid room name (expected "<projectId>/<yjsStateId>"): ${hookProjectId}/`),
    );
  });

  it('parseRoomName returns both typed ids for a well-formed room name', () => {
    const parsed = parseRoomName(hookRoomName);
    expect(parsed.projectId.value).toBe(hookProjectId);
    expect(parsed.yjsStateId.value).toBe(hookYjsStateId);
  });
});

describe('the writeback interval comes from one exact system-setting key', () => {
  it('reads collaboration.writeback_interval_seconds and applies it as maxDebounce', async () => {
    const settingRepo = makeSettingRepo('45');

    const server = await createCollabServer({ port: 0 }, [makeExtension()], settingRepo);

    expect((settingRepo.get as jest.Mock).mock.calls).toEqual([
      ['collaboration.writeback_interval_seconds'],
    ]);
    expect((server as unknown as { configuration: { maxDebounce: number } }).configuration.maxDebounce).toBe(45_000);
  });

  it('falls back to a 30 second write-back when the setting is unset', async () => {
    const server = await createCollabServer({ port: 0 }, [makeExtension()], makeSettingRepo(null));

    expect((server as unknown as { configuration: { maxDebounce: number } }).configuration.maxDebounce).toBe(30_000);
  });
});

// Both collaborators are required: a hook holding only one of them would dereference the other and
// reject (onConnect) or silently swallow a TypeError (onDisconnect) on every single connection.
describe('session hooks are installed only when BOTH collaborators are supplied', () => {
  it('installs both hooks when sessionCallbacks and documentRepository are given', async () => {
    const hooks = await hooksOf({
      sessionCallbacks: makeSessionCallbacks(),
      documentRepository: makeDocumentLookup(null),
    });

    expect(typeof hooks.onConnect).toBe('function');
    expect(typeof hooks.onDisconnect).toBe('function');
  });

  it('installs NEITHER hook when only sessionCallbacks is given', async () => {
    const hooks = await hooksOf({ sessionCallbacks: makeSessionCallbacks() });

    expect(hooks.onConnect).toBeUndefined();
    expect(hooks.onDisconnect).toBeUndefined();
  });

  it('installs NEITHER hook when only documentRepository is given', async () => {
    const hooks = await hooksOf({ documentRepository: makeDocumentLookup(null) });

    expect(hooks.onConnect).toBeUndefined();
    expect(hooks.onDisconnect).toBeUndefined();
  });

  it('installs NEITHER hook when both are omitted', async () => {
    const hooks = await hooksOf({});

    expect(hooks.onConnect).toBeUndefined();
    expect(hooks.onDisconnect).toBeUndefined();
  });
});

describe('onConnect logs exactly what it rejects on', () => {
  it('warns with the room name, then errors, when the document has vanished', async () => {
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();

    const hooks = await hooksOf({ logger, sessionCallbacks, documentRepository: makeDocumentLookup(null) });
    await expect(hooks.onConnect!({ documentName: hookRoomName, context: {} })).rejects.toThrow(
      new Error('Document not found'),
    );

    expect(logger.warn.mock.calls).toEqual([
      [{ documentName: hookRoomName }, 'Document not found for room; rejecting connection'],
    ]);
    expect(logger.error.mock.calls).toEqual([
      [
        { err: new Error('Document not found'), documentName: hookRoomName },
        'Error in onConnect; rejecting connection',
      ],
    ]);
    expect(sessionCallbacks.onRoomOpen).not.toHaveBeenCalled();
  });

  it('errors with the open failure and then with the rejection, when onRoomOpen fails', async () => {
    const logger = makeRecordingLogger();
    const openError = new Error('DB unavailable');
    const sessionCallbacks = makeSessionCallbacks({
      onRoomOpen: jest.fn().mockResolvedValue({ success: false, error: openError }),
    });

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup({ id: hookDocumentId }),
    });
    await expect(hooks.onConnect!({ documentName: hookRoomName, context: {} })).rejects.toThrow(openError);

    expect(logger.error.mock.calls).toEqual([
      [
        { err: openError, documentName: hookRoomName },
        'Failed to open collaboration session; rejecting connection to preserve the edit lock',
      ],
      [
        { err: openError, documentName: hookRoomName },
        'Error in onConnect; rejecting connection',
      ],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs nothing on a successful open and opens the session for the parsed project + document', async () => {
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup({ id: hookDocumentId }),
    });
    const context: Record<string, unknown> = {};
    await expect(hooks.onConnect!({ documentName: hookRoomName, context })).resolves.toBeUndefined();

    expect(sessionCallbacks.onRoomOpen.mock.calls).toEqual([
      [expect.objectContaining({ value: hookProjectId }), hookDocumentId],
    ]);
    expect(context.documentId).toBe(hookDocumentId);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs nothing and looks nothing up for a presence room', async () => {
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();
    const documentRepository = makeDocumentLookup(null);

    const hooks = await hooksOf({ logger, sessionCallbacks, documentRepository });
    await expect(
      hooks.onConnect!({ documentName: `presence/${hookProjectId}`, context: {} }),
    ).resolves.toBeUndefined();

    expect(lookupCalls(documentRepository)).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('onDisconnect logs exactly what it absorbs', () => {
  it('logs the flush failure with its error and room, and still closes the session', async () => {
    const logger = makeRecordingLogger();
    const flushError = new Error('store wedged');
    const sessionCallbacks = makeSessionCallbacks();

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup({ id: hookDocumentId }),
    });
    await expect(
      hooks.onDisconnect!(
        disconnectPayload({ instance: { storeDocumentHooks: jest.fn().mockRejectedValue(flushError) } }),
      ),
    ).resolves.toBeUndefined();

    expect(logger.error.mock.calls).toEqual([
      [
        { err: flushError, documentName: hookRoomName },
        'Failed to flush the write-back before closing the collaboration session; the file store may lag',
      ],
    ]);
    expect(sessionCallbacks.onRoomClose).toHaveBeenCalledTimes(1);
  });

  it('logs the close failure with its error and room', async () => {
    const logger = makeRecordingLogger();
    const closeError = new Error('Close failed');
    const sessionCallbacks = makeSessionCallbacks({
      onRoomClose: jest.fn().mockResolvedValue({ success: false, error: closeError }),
    });

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup({ id: hookDocumentId }),
    });
    await expect(hooks.onDisconnect!(disconnectPayload())).resolves.toBeUndefined();

    expect(logger.error.mock.calls).toEqual([
      [{ err: closeError, documentName: hookRoomName }, 'Failed to close collaboration session'],
    ]);
  });

  it('logs NOTHING when the session closes cleanly', async () => {
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup({ id: hookDocumentId }),
    });
    await expect(hooks.onDisconnect!(disconnectPayload())).resolves.toBeUndefined();

    expect(sessionCallbacks.onRoomClose.mock.calls).toEqual([
      [expect.objectContaining({ value: hookProjectId }), hookDocumentId],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs the absorbed error when onRoomClose throws outright', async () => {
    const logger = makeRecordingLogger();
    const thrown = new Error('DB connection lost');
    const sessionCallbacks = makeSessionCallbacks({ onRoomClose: jest.fn().mockRejectedValue(thrown) });

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup({ id: hookDocumentId }),
    });
    await expect(hooks.onDisconnect!(disconnectPayload())).resolves.toBeUndefined();

    expect(logger.error.mock.calls).toEqual([
      [{ err: thrown, documentName: hookRoomName }, 'Error in onDisconnect'],
    ]);
  });

  it('resolves the documentId by lookup when Hocuspocus carries NO context object at all', async () => {
    // Production reality: Hocuspocus does not carry the onConnect-mutated context into onDisconnect,
    // and may pass no context at all. Reading it unguarded would throw, the outer catch would eat it,
    // and the session row would leak — leaving the file permanently undeletable (active-session 409).
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();
    const documentRepository = makeDocumentLookup({ id: hookDocumentId });

    const hooks = await hooksOf({ logger, sessionCallbacks, documentRepository });
    await expect(
      hooks.onDisconnect!({
        clientsCount: 0,
        documentName: hookRoomName,
        document: { getConnectionsCount: jest.fn().mockReturnValue(0) },
        instance: { storeDocumentHooks: jest.fn().mockResolvedValue(undefined) },
      }),
    ).resolves.toBeUndefined();

    expect(lookupCalls(documentRepository)).toHaveBeenCalledTimes(1);
    expect(sessionCallbacks.onRoomClose.mock.calls).toEqual([
      [expect.objectContaining({ value: hookProjectId }), hookDocumentId],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns QUIETLY when the room resolves to no document', async () => {
    // Nothing to close and nothing to flush — and, crucially, nothing to log: a deleted document is
    // an ordinary end of life, not an operator-visible fault.
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();
    const storeDocumentHooks = jest.fn().mockResolvedValue(undefined);

    const hooks = await hooksOf({
      logger,
      sessionCallbacks,
      documentRepository: makeDocumentLookup(null),
    });
    await expect(
      hooks.onDisconnect!(disconnectPayload({ context: {}, instance: { storeDocumentHooks } })),
    ).resolves.toBeUndefined();

    expect(sessionCallbacks.onRoomClose).not.toHaveBeenCalled();
    expect(storeDocumentHooks).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs nothing and looks nothing up for a presence room', async () => {
    const logger = makeRecordingLogger();
    const sessionCallbacks = makeSessionCallbacks();
    const documentRepository = makeDocumentLookup({ id: hookDocumentId });

    const hooks = await hooksOf({ logger, sessionCallbacks, documentRepository });
    await expect(
      hooks.onDisconnect!(
        disconnectPayload({ documentName: `presence/${hookProjectId}`, context: {} }),
      ),
    ).resolves.toBeUndefined();

    expect(lookupCalls(documentRepository)).not.toHaveBeenCalled();
    expect(sessionCallbacks.onRoomClose).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
