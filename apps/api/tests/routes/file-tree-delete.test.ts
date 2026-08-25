import Fastify from 'fastify';
import { DeleteFileUseCase, PermissionDeniedError } from '@asciidocollab/domain';
import { fileTreeDeleteRoutes } from '../../src/routes/projects/file-tree-delete';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440003';

function buildTestServer(options: {
  activeSession?: boolean;
  memberRole?: string;
  activeGitOperation?: { kind: string } | null;
} = {}) {
  const app = Fastify();

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue({ role: { value: options.memberRole ?? 'editor' } }),
    },
    fileNode: {
      findById: jest.fn().mockResolvedValue({
        id: { value: FILE_NODE_ID },
        projectId: { value: PROJECT_ID },
        parentId: { value: '550e8400-e29b-41d4-a716-446655440009' },
        type: { value: 'file' },
        name: 'doc.adoc',
        path: { value: '/doc.adoc' },
      }),
      findByParentId: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    document: {
      findByFileNodeId: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    auditLog: {
      save: jest.fn().mockResolvedValue(undefined),
    },
    collaborationSession: {
      isActive: jest.fn().mockResolvedValue(options.activeSession ?? false),
    },
    gitOperation: {
      findActiveOperation: jest.fn().mockResolvedValue(
        options.activeGitOperation === undefined ? null : options.activeGitOperation,
      ),
    },
  });

  decorateApp(app, 'stores', {
    fileStore: {
      remove: jest.fn().mockResolvedValue(undefined),
      removeDirectory: jest.fn().mockResolvedValue(undefined),
    },
    yjsStateStore: {
      delete: jest.fn().mockResolvedValue(undefined),
    },
  });

  decorateApp(app, 'fileTreeEventBus', {
    emit: jest.fn(),
    subscribe: jest.fn(),
  });

  app.register(fileTreeDeleteRoutes);
  return app;
}

describe('DELETE /projects/:projectId/files/:fileNodeId', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns 204 on successful deletion', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(204);
  });

  test('deleting succeeds (204) even when a collaboration session is active (guard relaxed)', async () => {
    const app = buildTestServer({ activeSession: true });
    const mockDocument = { id: { value: '550e8400-e29b-41d4-a716-446655440010' } };
    const repos = (app as unknown as { repos: { document: { findByFileNodeId: jest.Mock } } }).repos;
    repos.document.findByFileNodeId.mockResolvedValue(mockDocument);

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(204);
  });

  test('returns 403 FORBIDDEN when use case fails with PermissionDeniedError', async () => {
    jest.spyOn(DeleteFileUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
  });

  test('returns 204 without emitting event when fileNode not found before delete', async () => {
    jest.spyOn(DeleteFileUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { mainFileCleared: false },
    });

    const app = buildTestServer();
    const repos = (app as unknown as { repos: { fileNode: { findById: jest.Mock } } }).repos;
    repos.fileNode.findById.mockResolvedValue(null);

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(204);
    const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
    expect(bus.emit).not.toHaveBeenCalled();
  });

  test('rejects deleting a node whose stored path resolves into .git, without invoking the use case', async () => {
    const app = buildTestServer();
    const repos = (app as unknown as { repos: { fileNode: { findById: jest.Mock } } }).repos;
    repos.fileNode.findById.mockResolvedValue({
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      parentId: { value: '550e8400-e29b-41d4-a716-446655440009' },
      type: { value: 'file' },
      name: 'config',
      path: { value: '/.git/config' },
    });
    const executeSpy = jest.spyOn(DeleteFileUseCase.prototype, 'execute');

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('rejects deleting a node whose stored path resolves into .collab, without invoking the use case', async () => {
    const app = buildTestServer();
    const repos = (app as unknown as { repos: { fileNode: { findById: jest.Mock } } }).repos;
    repos.fileNode.findById.mockResolvedValue({
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      parentId: { value: '550e8400-e29b-41d4-a716-446655440009' },
      type: { value: 'folder' },
      name: '.collab',
      path: { value: '/.collab' },
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
  });

  test('returns 409 git_operation_in_progress while a content-changing operation (BRANCH_SWITCH) is active', async () => {
    const app = buildTestServer({ activeGitOperation: { kind: 'BRANCH_SWITCH' } });
    const executeSpy = jest.spyOn(DeleteFileUseCase.prototype, 'execute');

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('git_operation_in_progress');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('does not block deletion when the active operation is not content-changing (e.g. COMMIT)', async () => {
    const app = buildTestServer({ activeGitOperation: { kind: 'COMMIT' } });

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(204);
  });

  test('returns 403 (not 409) for a non-member while a content-changing operation (BRANCH_SWITCH) is active', async () => {
    const app = buildTestServer({ memberRole: undefined, activeGitOperation: { kind: 'BRANCH_SWITCH' } });
    const repos = (app as unknown as { repos: { projectMember: { findByCompositeKey: jest.Mock } } }).repos;
    repos.projectMember.findByCompositeKey.mockResolvedValue(null);
    const executeSpy = jest.spyOn(DeleteFileUseCase.prototype, 'execute');

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('emits event with parentId=null when file node has no parent', async () => {
    jest.spyOn(DeleteFileUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { mainFileCleared: false },
    });

    const app = buildTestServer();
    const repos = (app as unknown as { repos: { fileNode: { findById: jest.Mock } } }).repos;
    repos.fileNode.findById.mockResolvedValue({
      id: { value: FILE_NODE_ID },
      projectId: { value: PROJECT_ID },
      parentId: null,
      type: { value: 'file' },
      name: 'root.adoc',
      path: { value: '/root.adoc' },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`,
    });
    expect(response.statusCode).toBe(204);
    const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
    expect(bus.emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ parentId: null }),
    );
  });
});
