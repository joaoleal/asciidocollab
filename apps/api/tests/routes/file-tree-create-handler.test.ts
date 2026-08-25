import Fastify from 'fastify';
import { fileTreeCreateRoutes } from '../../src/routes/projects/file-tree-create';
import { FileConflictError } from '@asciidocollab/domain';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440003';

const POST_URL = `/projects/${PROJECT_ID}/files`;

const parentFolderNode = {
  id: { value: PARENT_ID },
  projectId: { value: PROJECT_ID },
  parentId: null,
  type: { value: 'folder' },
  name: 'root',
  path: { value: '/' },
};

type BuildOptions = {
  memberResult?: unknown;
  findByIdResult?: unknown;
  fileSaveError?: boolean;
  fileConflict?: boolean;
  activeGitOperation?: { kind: string } | null;
};

function buildTestServer(options: BuildOptions = {}) {
  const app = Fastify();

  const memberResult = options.memberResult === undefined
    ? { role: { value: 'editor' } }
    : options.memberResult;

  const findByIdResult = options.findByIdResult === undefined
    ? parentFolderNode
    : options.findByIdResult;

  decorateApp(app, 'repos', {
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(memberResult),
    },
    fileNode: {
      findById: jest.fn().mockResolvedValue(findByIdResult),
      findByParentId: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
    },
    document: {
      save: jest.fn().mockResolvedValue(undefined),
    },
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
      createExclusive: jest.fn().mockResolvedValue(
        options.fileConflict
          ? { success: false, error: new FileConflictError('doc.adoc') }
          : { success: true }
      ),
      remove: jest.fn().mockResolvedValue(undefined),
      createDirectory: jest.fn().mockResolvedValue(undefined),
    },
  });

  decorateApp(app, 'fileTreeEventBus', {
    emit: jest.fn(),
    subscribe: jest.fn(),
  });

  app.register(fileTreeCreateRoutes);
  return app;
}

describe('POST /projects/:projectId/files — file creation', () => {
  test('returns 201 with fileNodeId and path on success', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('fileNodeId');
    expect(body).toHaveProperty('path');
  });

  test('emits a created file event via fileTreeEventBus', async () => {
    const app = buildTestServer();
    await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
    expect(bus.emit).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ type: 'created', nodeType: 'file', name: 'doc.adoc', parentId: PARENT_ID }),
    );
  });

  test('uses text/asciidoc mime type when mimeType is not specified', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(201);
  });

  test('accepts an explicit mimeType', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'notes.md', mimeType: 'text/markdown' },
    });
    expect(response.statusCode).toBe(201);
  });

  test('returns 403 when actor is not a project member', async () => {
    const app = buildTestServer({ memberResult: null });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('returns 404 when parent folder is not found', async () => {
    const app = buildTestServer({ findByIdResult: null });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('returns 409 when file already exists (store conflict)', async () => {
    const app = buildTestServer({ fileConflict: true });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('CONFLICT');
  });

  test('returns 400 when required fields are missing from body', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file' },
    });
    expect(response.statusCode).toBe(400);
  });

  test('rejects creating a file literally named .git without touching the file store', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: '.git' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('RESERVED_PATH');
    const stores = (app as unknown as { stores: { fileStore: { createExclusive: jest.Mock } } }).stores;
    expect(stores.fileStore.createExclusive).not.toHaveBeenCalled();
  });

  test('rejects creating a file literally named .collab without touching the file store', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: '.collab' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
  });

  test('still allows creating an ordinary dotfile named .gitignore', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: '.gitignore' },
    });
    expect(response.statusCode).toBe(201);
  });

  test('returns 409 git_operation_in_progress while a content-changing operation (PULL) is active', async () => {
    const app = buildTestServer({ activeGitOperation: { kind: 'PULL' } });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('git_operation_in_progress');
    const stores = (app as unknown as { stores: { fileStore: { createExclusive: jest.Mock } } }).stores;
    expect(stores.fileStore.createExclusive).not.toHaveBeenCalled();
  });

  test('does not block when the active operation is not content-changing (e.g. PUSH)', async () => {
    const app = buildTestServer({ activeGitOperation: { kind: 'PUSH' } });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'file', parentId: PARENT_ID, name: 'doc.adoc' },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('POST /projects/:projectId/files — folder creation', () => {
  test('returns 201 with fileNodeId and path on folder creation', async () => {
    // Folder creation uses CreateFolderUseCase which calls fileNode.save (not document.save)
    // We set findById to return parentFolderNode for the parent lookup
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: 'my-folder' },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('fileNodeId');
    expect(body).toHaveProperty('path');
  });

  test('emits a created folder event via fileTreeEventBus', async () => {
    const app = buildTestServer();
    await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: 'my-folder' },
    });
    const bus = (app as unknown as { fileTreeEventBus: { emit: jest.Mock } }).fileTreeEventBus;
    expect(bus.emit).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ type: 'created', nodeType: 'folder', name: 'my-folder', parentId: PARENT_ID }),
    );
  });

  test('returns 403 when actor is not a project member for folder creation', async () => {
    const app = buildTestServer({ memberResult: null });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: 'my-folder' },
    });
    expect(response.statusCode).toBe(403);
  });

  test('returns 404 when parent folder is not found for folder creation', async () => {
    const app = buildTestServer({ findByIdResult: null });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: 'my-folder' },
    });
    expect(response.statusCode).toBe(404);
  });

  test('returns 409 when a folder with the same name already exists', async () => {
    const app = buildTestServer();
    // Override findByParentId to return a sibling with the same name
    const repos = (app as unknown as { repos: { fileNode: { findByParentId: jest.Mock } } }).repos;
    repos.fileNode.findByParentId.mockResolvedValue([
      { name: 'my-folder', type: { value: 'folder' }, id: { value: '550e8400-e29b-41d4-a716-446655440099' } },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: 'my-folder' },
    });
    expect(response.statusCode).toBe(409);
  });

  test('rejects creating a folder literally named .git without touching the file store', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: '.git' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('RESERVED_PATH');
    const stores = (app as unknown as { stores: { fileStore: { createDirectory: jest.Mock } } }).stores;
    expect(stores.fileStore.createDirectory).not.toHaveBeenCalled();
  });

  test('rejects creating a folder literally named .collab without touching the file store', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: '.collab' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('RESERVED_PATH');
  });

  test('still allows creating an ordinary folder named .github', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: '.github' },
    });
    expect(response.statusCode).toBe(201);
  });

  test('returns 409 git_operation_in_progress while a content-changing operation (IMPORT) is active', async () => {
    const app = buildTestServer({ activeGitOperation: { kind: 'IMPORT' } });
    const response = await app.inject({
      method: 'POST',
      url: POST_URL,
      headers: { 'content-type': 'application/json' },
      payload: { type: 'folder', parentId: PARENT_ID, name: 'my-folder' },
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('git_operation_in_progress');
  });
});
