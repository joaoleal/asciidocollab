import Fastify from 'fastify';
import { fileTreePatchRoutes } from '../../src/routes/projects/file-tree-patch';
import { FileConflictError } from '@asciidocollab/domain';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const FILE_NODE_ID = '550e8400-e29b-41d4-a716-446655440003';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440004';

// A real FileNode always carries Timestamps — the entity constructor defaults them — so `createdAt`
// is never undefined in production. These mocks omitted it, and rename/move both rebuild the node
// with `new Timestamps(fileNode.createdAt, new Date())`. With `createdAt` undefined that becomes a
// RACE: the `new Date()` argument is evaluated at the call site, then the constructor's own
// `createdAt = new Date()` default runs a moment later. Same millisecond and the `createdAt <=
// updatedAt` invariant holds; one millisecond later — which is what a descheduled worker under the
// full parallel suite produces — it throws ValidationError, which escapes the handler as a 500 with
// no log to show for it. Pinned to a fixed past instant so the mocks match the entity's guarantee.
const CREATED_AT = new Date('2024-01-01T00:00:00.000Z');

/** A file node that is valid for rename (has parentId, correct projectId). */
const mockFileNode = {
  id: { value: FILE_NODE_ID },
  projectId: { value: PROJECT_ID },
  parentId: { value: PARENT_ID },
  type: { value: 'file' },
  name: 'doc.adoc',
  path: { value: '/doc.adoc' },
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

/** A folder node suitable for being a move target. */
const mockParentFolder = {
  id: { value: PARENT_ID },
  projectId: { value: PROJECT_ID },
  parentId: null,
  type: { value: 'folder' },
  name: 'root',
  path: { value: '/' },
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const PATCH_URL = `/projects/${PROJECT_ID}/files/${FILE_NODE_ID}`;

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a server where rename succeeds and move succeeds (all repo mocks happy). */
function buildRenameServer(options: {
  memberResult?: unknown;
  /** If set, findById always returns this value. Otherwise returns mockFileNode. */
  findByIdOverride?: unknown;
  activeGitOperation?: { kind: string } | null;
} = {}) {
  const app = Fastify();

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(
        options.memberResult === undefined ? { role: { value: 'editor' } } : options.memberResult,
      ),
    },
    fileNode: {
      findById: jest.fn().mockResolvedValue(
        options.findByIdOverride === undefined ? mockFileNode : options.findByIdOverride,
      ),
      findByParentId: jest.fn().mockResolvedValue([]),
      findByProjectId: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    },
    project: { findById: jest.fn().mockResolvedValue(null), save: jest.fn().mockResolvedValue(undefined) },
    auditLog: {
      save: jest.fn().mockResolvedValue(undefined),
    },
    gitOperation: {
      findActiveOperation: jest.fn().mockResolvedValue(
        options.activeGitOperation === undefined ? null : options.activeGitOperation,
      ),
    },
  });

  decorateApp(app, 'stores', {
    fileStore: {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
      move: jest.fn().mockResolvedValue({ success: true }),
      createExclusive: jest.fn().mockResolvedValue({ success: true }),
      remove: jest.fn().mockResolvedValue(undefined),
    },
  });

  decorateApp(app, 'fileTreeEventBus', {
    emit: jest.fn(),
    subscribe: jest.fn(),
  });

  app.register(fileTreePatchRoutes);
  return app;
}

/**
 * Build a server where move operations can succeed.
 * MoveFileUseCase calls findById twice: first for the file node, then for the parent folder.
 */
function buildMoveServer(options: {
  memberResult?: unknown;
  fileNodeForMove?: unknown;
  parentFolder?: unknown;
  /** If set, the post-move findById (for event) returns this. */
  postMoveNode?: unknown;
  fileStoreMove?: { success: boolean; error?: Error };
  activeGitOperation?: { kind: string } | null;
} = {}) {
  const app = Fastify();

  const fileNode = options.fileNodeForMove === undefined ? mockFileNode : options.fileNodeForMove;
  const parentFolder = options.parentFolder === undefined ? mockParentFolder : options.parentFolder;
  const postMoveNode = options.postMoveNode === undefined ? mockFileNode : options.postMoveNode;

  // Resolve findById by ARGUMENT, not call order: the parent lookup is keyed on PARENT_ID, so it
  // is immune to any drift in call count/order (a `mockResolvedValueOnce` sequence is not — a
  // single extra/missing call shifts every later result, which can leave the post-op event lookup
  // resolving to `undefined` and the 'moved' event silently un-emitted: a flaky "0 calls").
  let moveFileLookups = 0;
  const moveFindById = jest.fn((id: { value: string }) => {
    if (id.value === PARENT_ID) return Promise.resolve(parentFolder);
    moveFileLookups += 1;
    // 1st fileNodeId lookup = MoveFileUseCase source; the next = the post-op event lookup.
    return Promise.resolve(moveFileLookups === 1 ? fileNode : postMoveNode);
  });

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(
        options.memberResult === undefined ? { role: { value: 'editor' } } : options.memberResult,
      ),
    },
    fileNode: {
      findById: moveFindById,
      findByParentId: jest.fn().mockResolvedValue([]),
      findByProjectId: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    },
    project: { findById: jest.fn().mockResolvedValue(null), save: jest.fn().mockResolvedValue(undefined) },
    auditLog: {
      save: jest.fn().mockResolvedValue(undefined),
    },
    gitOperation: {
      findActiveOperation: jest.fn().mockResolvedValue(
        options.activeGitOperation === undefined ? null : options.activeGitOperation,
      ),
    },
  });

  decorateApp(app, 'stores', {
    fileStore: {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
      move: jest.fn().mockResolvedValue(
        options.fileStoreMove === undefined ? { success: true } : options.fileStoreMove,
      ),
    },
  });

  decorateApp(app, 'fileTreeEventBus', {
    emit: jest.fn(),
    subscribe: jest.fn(),
  });

  app.register(fileTreePatchRoutes);
  return app;
}

/**
 * Build a server for the rename+move combined branch.
 * RenameFileUseCase: findById(fileNodeId)
 * MoveFileUseCase:   findById(fileNodeId), findById(parentId)
 * Post-operation:    findById(fileNodeId)
 */
function buildRenameMoveServer(options: {
  memberResult?: unknown;
  renameFileStoreMove?: { success: boolean; error?: Error };
  moveFileStoreMove?: { success: boolean; error?: Error };
  postOpNode?: unknown;
  activeGitOperation?: { kind: string } | null;
} = {}) {
  const app = Fastify();

  const postOpNode = options.postOpNode === undefined ? mockFileNode : options.postOpNode;
  // Resolve findById by ARGUMENT, not call order (see buildMoveServer for why). The parent lookup
  // is keyed on PARENT_ID; the source lookups (rename + move) return the file node; only the final
  // post-op event lookup uses the override. This removes the order-dependence that made the
  // 'emits a moved event' assertion flaky under the full parallel suite.
  let renameMoveFileLookups = 0;
  const renameMoveFindById = jest.fn((id: { value: string }) => {
    if (id.value === PARENT_ID) return Promise.resolve(mockParentFolder);
    renameMoveFileLookups += 1;
    // 1st & 2nd fileNodeId lookups = rename/move source; the 3rd = the post-op event lookup.
    return Promise.resolve(renameMoveFileLookups >= 3 ? postOpNode : mockFileNode);
  });

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(
        options.memberResult === undefined ? { role: { value: 'editor' } } : options.memberResult,
      ),
    },
    fileNode: {
      findById: renameMoveFindById,
      findByParentId: jest.fn().mockResolvedValue([]),
      findByProjectId: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    },
    project: { findById: jest.fn().mockResolvedValue(null), save: jest.fn().mockResolvedValue(undefined) },
    auditLog: {
      save: jest.fn().mockResolvedValue(undefined),
    },
    gitOperation: {
      findActiveOperation: jest.fn().mockResolvedValue(
        options.activeGitOperation === undefined ? null : options.activeGitOperation,
      ),
    },
  });

  // move() is called separately for rename and for move; use a sequence
  const renameMoveResult = options.renameFileStoreMove ?? { success: true };
  const actualMoveResult = options.moveFileStoreMove ?? { success: true };

  decorateApp(app, 'stores', {
    fileStore: {
      read: jest.fn().mockResolvedValue(null),
      write: jest.fn().mockResolvedValue(undefined),
      move: jest.fn()
        .mockResolvedValueOnce(renameMoveResult)
        .mockResolvedValueOnce(actualMoveResult),
    },
  });

  decorateApp(app, 'fileTreeEventBus', {
    emit: jest.fn(),
    subscribe: jest.fn(),
  });

  app.register(fileTreePatchRoutes);
  return app;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('PATCH /projects/:projectId/files/:fileNodeId', () => {
  describe('rename-only (name set, parentId absent)', () => {
    test('returns 204 on successful rename', async () => {
      const app = buildRenameServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(204);
    });

    test('emits a renamed event via fileTreeEventBus', async () => {
      const app = buildRenameServer();
      await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
      expect(bus.emit).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ type: 'renamed', name: 'renamed.adoc' }),
      );
    });

    test('returns 403 when actor is not a project member', async () => {
      const app = buildRenameServer({ memberResult: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    test('returns 404 when file node is not found', async () => {
      const app = buildRenameServer({ findByIdOverride: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    test('returns 409 when the file store rejects the rename as a conflict', async () => {
      const app = buildRenameServer();
      // Override the fileStore.move to simulate a conflict
      const stores = (app as unknown as { stores: { fileStore: { move: jest.Mock } } }).stores;
      stores.fileStore.move.mockResolvedValue({
        success: false,
        error: new FileConflictError('existing.adoc'),
      });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'existing.adoc' },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    test('rejects renaming a file to .git without touching the file store', async () => {
      const app = buildRenameServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: '.git' },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
      const stores = (app as unknown as { stores: { fileStore: { move: jest.Mock } } }).stores;
      expect(stores.fileStore.move).not.toHaveBeenCalled();
    });

    test('rejects renaming a file to .collab without touching the file store', async () => {
      const app = buildRenameServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: '.collab' },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
    });

    test('still allows renaming a file to the ordinary dotfile .gitignore', async () => {
      const app = buildRenameServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: '.gitignore' },
      });
      expect(response.statusCode).toBe(204);
    });

    test('does not emit event when post-rename findById returns null', async () => {
      const app = buildRenameServer();
      const repos = (app as unknown as { repos: { fileNode: { findById: jest.Mock } } }).repos;
      // Use case calls findById for source (returns mockFileNode); post-rename call returns null
      repos.fileNode.findById
        .mockResolvedValueOnce(mockFileNode)
        .mockResolvedValueOnce(null);
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(204);
      const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
      expect(bus.emit).not.toHaveBeenCalled();
    });

    test('returns 409 git_operation_in_progress while a content-changing operation (PULL) is active', async () => {
      const app = buildRenameServer({ activeGitOperation: { kind: 'PULL' } });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe('git_operation_in_progress');
      const stores = (app as unknown as { stores: { fileStore: { move: jest.Mock } } }).stores;
      expect(stores.fileStore.move).not.toHaveBeenCalled();
    });

    test('does not block rename when the active operation is not content-changing (e.g. FETCH)', async () => {
      const app = buildRenameServer({ activeGitOperation: { kind: 'FETCH' } });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(204);
    });

    test('returns 403 (not 409) for a non-member while a content-changing operation (PULL) is active', async () => {
      const app = buildRenameServer({ memberResult: null, activeGitOperation: { kind: 'PULL' } });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'renamed.adoc' },
      });
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
    });
  });

  describe('move-only (parentId set, name absent)', () => {
    test('returns 204 on successful move', async () => {
      const app = buildMoveServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(204);
    });

    test('emits a moved event via fileTreeEventBus', async () => {
      const app = buildMoveServer();
      await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
      expect(bus.emit).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ type: 'moved', parentId: PARENT_ID }),
      );
    });

    test('returns 403 when actor is not a project member', async () => {
      const app = buildMoveServer({ memberResult: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    test('returns 404 when target file node is not found', async () => {
      const app = buildMoveServer({ fileNodeForMove: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    test('returns 409 when the file store rejects the move as a conflict', async () => {
      const app = buildMoveServer({
        fileStoreMove: { success: false, error: new FileConflictError('doc.adoc') },
      });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    test('does not emit event when post-move findById returns null', async () => {
      const app = buildMoveServer({ postMoveNode: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(204);
      const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
      expect(bus.emit).not.toHaveBeenCalled();
    });

    test('returns 409 git_operation_in_progress while a content-changing operation (IMPORT) is active', async () => {
      const app = buildMoveServer({ activeGitOperation: { kind: 'IMPORT' } });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe('git_operation_in_progress');
    });
  });

  describe('rename+move combined (both name and parentId set)', () => {
    test('returns 204 when both operations succeed', async () => {
      const app = buildRenameMoveServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(204);
    });

    test('emits a moved event with the new name', async () => {
      const app = buildRenameMoveServer();
      await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
      expect(bus.emit).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({ type: 'moved', name: 'newname.adoc', parentId: PARENT_ID }),
      );
    });

    test('returns 403 when rename fails with PermissionDeniedError (no member)', async () => {
      const app = buildRenameMoveServer({ memberResult: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    test('returns 409 when rename store move fails with conflict', async () => {
      const app = buildRenameMoveServer({
        renameFileStoreMove: { success: false, error: new FileConflictError('newname.adoc') },
      });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    test('returns 409 when rename succeeds but move store fails with conflict', async () => {
      const app = buildRenameMoveServer({
        moveFileStoreMove: { success: false, error: new FileConflictError('newname.adoc') },
      });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CONFLICT');
    });

    test('rejects a combined rename+move that renames to .git', async () => {
      const app = buildRenameMoveServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: '.git', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
    });

    test('does not emit event when post-operation findById returns null', async () => {
      const app = buildRenameMoveServer({ postOpNode: null });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(204);
      const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
      expect(bus.emit).not.toHaveBeenCalled();
    });

    test('returns 409 git_operation_in_progress while a content-changing operation (BRANCH_SWITCH) is active', async () => {
      const app = buildRenameMoveServer({ activeGitOperation: { kind: 'BRANCH_SWITCH' } });
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'newname.adoc', parentId: PARENT_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body).error.code).toBe('git_operation_in_progress');
    });
  });

  describe('missing body fields', () => {
    test('returns 400 VALIDATION_ERROR when neither name nor parentId is provided', async () => {
      const app = buildRenameServer();
      const response = await app.inject({
        method: 'PATCH',
        url: PATCH_URL,
        headers: { 'content-type': 'application/json' },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
