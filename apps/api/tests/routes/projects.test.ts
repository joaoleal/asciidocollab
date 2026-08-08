import Fastify from 'fastify';
import {
  ListUserProjectsUseCase,
  CreateProjectUseCase,
  UpdateProjectUseCase,
  ArchiveProjectUseCase,
  RestoreProjectUseCase,
  DeleteProjectUseCase,
  PermissionDeniedError,
  ProjectNotFoundError,
  ProjectAlreadyArchivedError,
  ProjectNotArchivedError,
} from '@asciidocollab/domain';
import { projectRoutes } from '../../src/routes/projects';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const ROOT_FOLDER_ID = '550e8400-e29b-41d4-a716-446655440003';
const OWNER_USER_ID = '550e8400-e29b-41d4-a716-446655440004';

const mockProject = {
  id: { value: PROJECT_ID },
  name: { value: 'Test Project' },
  description: 'A test project',
  tags: ['tag1', 'tag2'],
  rootFolderId: { value: ROOT_FOLDER_ID },
  archivedAt: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const mockMember = {
  userId: { value: USER_ID },
  role: { value: 'editor' },
  joinedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const mockOwnerMember = {
  userId: { value: OWNER_USER_ID },
  role: { value: 'owner' },
  joinedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const mockUser = {
  id: { value: OWNER_USER_ID },
  displayName: 'Owner User',
};

function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    project: { findById: jest.fn().mockResolvedValue(mockProject), save: jest.fn() },
    projectMember: {
      findByProjectId: jest.fn().mockResolvedValue([mockOwnerMember, mockMember]),
      findByCompositeKey: jest.fn().mockResolvedValue(mockOwnerMember),
      addMember: jest.fn(),
    },
    user: { findById: jest.fn().mockResolvedValue(mockUser) },
    fileNode: { save: jest.fn(), findByProjectId: jest.fn().mockResolvedValue([]) },
    auditLog: { save: jest.fn() },
  });
  decorateApp(app, 'stores', {
    fileStore: { removeDirectory: jest.fn(), remove: jest.fn() },
    yjsStateStore: { delete: jest.fn() },
  });
  app.register(projectRoutes);
  return app;
}

describe('GET /api/projects', () => {
  it('returns 200 with paginated project list', async () => {
    jest.spyOn(ListUserProjectsUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        projects: [mockProject as never],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      },
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(PROJECT_ID);
    expect(body.data[0].rootFolderId).toBe(ROOT_FOLDER_ID);
    expect(body.data[0].archivedAt).toBeNull();
    expect(body.pagination.total).toBe(1);
  });

  it('includes a fileCount that counts files only, excluding folders', async () => {
    jest.spyOn(ListUserProjectsUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { projects: [mockProject as never], total: 1, page: 1, limit: 20, totalPages: 1 },
    });

    const app = buildTestServer();
    (app.repos as never as { fileNode: { findByProjectId: jest.Mock } }).fileNode.findByProjectId.mockResolvedValue([
      { type: { value: 'file' } },
      { type: { value: 'folder' } },
      { type: { value: 'file' } },
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data[0].fileCount).toBe(2);
  });

  it('includes null user filtered from owners list', async () => {
    jest.spyOn(ListUserProjectsUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { projects: [mockProject as never], total: 1, page: 1, limit: 20, totalPages: 1 },
    });
    const app = buildTestServer();
    (app.repos as never as { user: { findById: jest.Mock } }).user.findById.mockResolvedValue(null);

    const response = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data[0].owners).toHaveLength(0);
  });

  it('returns 500 INTERNAL_ERROR when use case fails', async () => {
    jest.spyOn(ListUserProjectsUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new Error('db error') as never,
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
  });

  it('applies pagination query params', async () => {
    const spy = jest.spyOn(ListUserProjectsUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { projects: [], total: 0, page: 2, limit: 5, totalPages: 0 },
    });

    const app = buildTestServer();
    await app.inject({ method: 'GET', url: '/api/projects?page=2&limit=5&archived=true' });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { page: 2, limit: 5 }, true);
  });
});

describe('GET /api/projects/:id', () => {
  it('returns 200 with project data including the caller role', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.id).toBe(PROJECT_ID);
    expect(['owner', 'editor', 'viewer']).toContain(body.data.role);
  });

  it('returns 404 when project does not exist', async () => {
    const app = buildTestServer();
    (app.repos as never as { project: { findById: jest.Mock } }).project.findById.mockResolvedValue(null);

    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}` });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when user is not a member', async () => {
    const app = buildTestServer();
    (app.repos as never as { projectMember: { findByProjectId: jest.Mock } }).projectMember.findByProjectId.mockResolvedValue([]);

    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}` });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/projects', () => {
  it('returns 201 with the created project', async () => {
    jest.spyOn(CreateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        projectId: { value: PROJECT_ID } as never,
        rootFolderId: { value: ROOT_FOLDER_ID } as never,
        ownerRole: 'owner',
      },
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'My Project', description: 'desc', tags: ['a'] },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.data.id).toBe(PROJECT_ID);
    expect(body.data.rootFolderId).toBe(ROOT_FOLDER_ID);
    expect(body.data.description).toBe('desc');
  });

  it('returns 201 with null description when omitted', async () => {
    jest.spyOn(CreateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        projectId: { value: PROJECT_ID } as never,
        rootFolderId: { value: ROOT_FOLDER_ID } as never,
        ownerRole: 'owner',
      },
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'My Project' },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).data.description).toBeNull();
  });

  it('returns 400 when use case fails', async () => {
    jest.spyOn(CreateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('Name contains invalid characters'), { name: 'ValidationError' }) as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'ValidName' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/projects/:id', () => {
  it('returns 200 with updated project', async () => {
    jest.spyOn(UpdateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        id: { value: PROJECT_ID },
        name: { value: 'Updated Name' },
        description: 'Updated desc',
        tags: ['new-tag'],
        updatedAt: new Date('2024-06-01T00:00:00.000Z'),
      } as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}`,
      payload: { name: 'Updated Name' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.name).toBe('Updated Name');
  });

  it('forwards language to the use case and echoes it in the response', async () => {
    const executeSpy = jest.spyOn(UpdateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: {
        id: { value: PROJECT_ID },
        name: { value: 'Doc' },
        description: null,
        tags: [],
        language: 'pt',
        updatedAt: new Date('2024-06-01T00:00:00.000Z'),
      } as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}`,
      payload: { language: 'pt' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.language).toBe('pt');
    expect(executeSpy.mock.calls.at(-1)?.[2]).toMatchObject({ language: 'pt' });
  });

  it('returns 403 when actor lacks permission', async () => {
    jest.spyOn(UpdateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}`,
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when project does not exist', async () => {
    jest.spyOn(UpdateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectNotFoundError(PROJECT_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}`,
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/projects/:id/archive', () => {
  it('returns 200 with archivedAt on success', async () => {
    const archivedAt = new Date('2024-06-01T00:00:00.000Z');
    jest.spyOn(ArchiveProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { archivedAt },
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/archive` });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.archivedAt).toBe(archivedAt.toISOString());
  });

  it('returns 400 ALREADY_ARCHIVED when project is already archived', async () => {
    jest.spyOn(ArchiveProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectAlreadyArchivedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/archive` });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('ALREADY_ARCHIVED');
  });

  it('returns 404 when project not found', async () => {
    jest.spyOn(ArchiveProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectNotFoundError(PROJECT_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/archive` });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/restore', () => {
  it('returns 200 with archivedAt: null on success', async () => {
    jest.spyOn(RestoreProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: undefined,
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/restore` });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.archivedAt).toBeNull();
  });

  it('returns 400 NOT_ARCHIVED when project is not archived', async () => {
    jest.spyOn(RestoreProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectNotArchivedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/restore` });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('NOT_ARCHIVED');
  });

  it('returns 403 when actor lacks permission', async () => {
    jest.spyOn(RestoreProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/restore` });

    expect(response.statusCode).toBe(403);
  });
});

describe('PATCH /api/projects/:id — VALIDATION_ERROR fallback', () => {
  it('returns 400 VALIDATION_ERROR for unrecognised error', async () => {
    jest.spyOn(UpdateProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new Error('Unknown domain error') as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}`,
      payload: { name: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/projects/:id', () => {
  it('returns 200 with the project id on success', async () => {
    jest.spyOn(DeleteProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: undefined,
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/api/projects/${PROJECT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.id).toBe(PROJECT_ID);
  });

  it('returns 403 when actor lacks permission', async () => {
    jest.spyOn(DeleteProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/api/projects/${PROJECT_ID}` });

    expect(response.statusCode).toBe(403);
  });

  it('returns 404 when project not found', async () => {
    jest.spyOn(DeleteProjectUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectNotFoundError(PROJECT_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/api/projects/${PROJECT_ID}` });

    expect(response.statusCode).toBe(404);
  });
});
