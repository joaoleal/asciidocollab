import Fastify from 'fastify';
import {
  RemoveUserUseCase,
  CannotRemoveSelfError,
  UserNotFoundError,
} from '@asciidocollab/domain';

function namedError(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}
import { usersRemoveRoute } from '../../../src/routes/admin/users-remove';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

jest.mock('../../../src/plugins/require-admin', () => ({
  requireAdmin: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
}));

const TARGET_ID = '550e8400-e29b-41d4-a716-446655440002';

function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    user: { findById: jest.fn(), delete: jest.fn() },
    projectMember: { findByUserId: jest.fn(), findSoleOwnerProjects: jest.fn() },
    session: { deleteByUserId: jest.fn() },
    auditLog: { save: jest.fn() },
  });
  app.register(usersRemoveRoute);
  return app;
}

describe('DELETE /admin/users/:id', () => {
  it('returns 200 with projectsTransferred on success', async () => {
    jest.spyOn(RemoveUserUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { projectIdsTransferred: ['proj-1', 'proj-2'] },
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/admin/users/${TARGET_ID}` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.projectsTransferred).toEqual(['proj-1', 'proj-2']);
  });

  it('returns 403 CANNOT_REMOVE_SELF', async () => {
    jest.spyOn(RemoveUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new CannotRemoveSelfError(),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/admin/users/${TARGET_ID}` });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('CANNOT_REMOVE_SELF');
  });

  it('returns 403 CANNOT_REMOVE_LAST_ADMIN', async () => {
    jest.spyOn(RemoveUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: namedError('CannotRemoveLastAdminError') as never,
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/admin/users/${TARGET_ID}` });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('CANNOT_REMOVE_LAST_ADMIN');
  });

  it('returns 404 NOT_FOUND when user does not exist', async () => {
    jest.spyOn(RemoveUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new UserNotFoundError(TARGET_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/admin/users/${TARGET_ID}` });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 PERMISSION_DENIED for unrecognised error', async () => {
    jest.spyOn(RemoveUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('Unknown'), { name: 'UnknownError' }),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'DELETE', url: `/admin/users/${TARGET_ID}` });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('PERMISSION_DENIED');
  });
});
