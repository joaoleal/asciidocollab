import Fastify from 'fastify';
import {
  SetAdminStatusUseCase,
  CannotModifySelfAdminError,
  UserNotFoundError,
} from '@asciidocollab/domain';

function namedError(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}
import { usersAdminStatusRoute } from '../../../src/routes/admin/users-admin-status';
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
    user: { findById: jest.fn(), save: jest.fn() },
    auditLog: { save: jest.fn() },
    session: { deleteByUserId: jest.fn() },
  });
  app.register(usersAdminStatusRoute);
  return app;
}

describe('PATCH /admin/users/:id/admin', () => {
  it('returns 200 on success', async () => {
    jest.spyOn(SetAdminStatusUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: undefined,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${TARGET_ID}/admin`,
      payload: { isAdmin: true },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).message).toBe('Admin status updated');
  });

  it('returns 403 with CANNOT_MODIFY_SELF when actor tries to modify self', async () => {
    jest.spyOn(SetAdminStatusUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new CannotModifySelfAdminError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${TARGET_ID}/admin`,
      payload: { isAdmin: false },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('CANNOT_MODIFY_SELF');
  });

  it('returns 403 with CANNOT_REMOVE_LAST_ADMIN', async () => {
    jest.spyOn(SetAdminStatusUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: namedError('CannotRemoveLastAdminError') as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${TARGET_ID}/admin`,
      payload: { isAdmin: false },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('CANNOT_REMOVE_LAST_ADMIN');
  });

  it('returns 404 with NOT_FOUND when user does not exist', async () => {
    jest.spyOn(SetAdminStatusUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new UserNotFoundError(TARGET_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${TARGET_ID}/admin`,
      payload: { isAdmin: true },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 PERMISSION_DENIED for unrecognised error names', async () => {
    jest.spyOn(SetAdminStatusUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('Unknown'), { name: 'UnknownError' }),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${TARGET_ID}/admin`,
      payload: { isAdmin: true },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('PERMISSION_DENIED');
  });
});
