import Fastify from 'fastify';
import { ListUsersUseCase, PermissionDeniedError } from '@asciidocollab/domain';
import { usersRoute } from '../../../src/routes/admin/users';
import { decorateApp } from '../../helpers/decorate-app';

jest.mock('../../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

jest.mock('../../../src/plugins/require-admin', () => ({
  requireAdmin: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
}));

const TARGET_ID = '550e8400-e29b-41d4-a716-446655440002';

const mockUser = {
  id: { value: '550e8400-e29b-41d4-a716-446655440001' },
  email: { value: 'admin@example.com' },
  displayName: 'Admin User',
  isAdmin: true,
  emailVerified: true,
  registrationMethod: 'SELF_REGISTERED' as const,
  createdAt: new Date('2024-01-01'),
};

function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    user: { findById: jest.fn() },
    projectMember: {
      findSoleOwnerProjects: jest.fn().mockResolvedValue([
        { id: { value: 'proj-1' }, name: 'Project One' },
      ]),
    },
  });
  app.register(usersRoute);
  return app;
}

describe('GET /admin/users', () => {
  it('returns 200 with user list on success', async () => {
    jest.spyOn(ListUsersUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { users: [mockUser as never] },
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/users' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.users).toHaveLength(1);
    expect(body.users[0].email).toBe('admin@example.com');
    expect(body.users[0].isAdmin).toBe(true);
  });

  it('returns 403 PERMISSION_DENIED on use case failure', async () => {
    jest.spyOn(ListUsersUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/admin/users' });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('PERMISSION_DENIED');
  });
});

describe('GET /admin/users/:id/removal-preview', () => {
  it('returns 200 with projects that would be transferred', async () => {
    const app = buildTestServer();
    const response = await app.inject({
      method: 'GET',
      url: `/admin/users/${TARGET_ID}/removal-preview`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.projectsToTransfer).toHaveLength(1);
    expect(body.projectsToTransfer[0].id).toBe('proj-1');
    expect(body.projectsToTransfer[0].name).toBe('Project One');
  });
});
