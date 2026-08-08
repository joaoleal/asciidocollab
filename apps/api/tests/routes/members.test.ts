import Fastify from 'fastify';
import {
  InviteUserUseCase,
  ChangeMemberRoleUseCase,
  RemoveMemberUseCase,
  PermissionDeniedError,
  ProjectNotFoundError,
  UserNotFoundError,
  MemberNotFoundError,
  ProjectMemberAlreadyExistsError,
  CannotRemoveLastOwnerError,
} from '@asciidocollab/domain';
import { memberRoutes } from '../../src/routes/projects/members';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const SESSION_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const TARGET_USER_ID = '550e8400-e29b-41d4-a716-446655440003';

const mockCallerMembership = { userId: { value: SESSION_USER_ID }, role: { value: 'owner' } };
const mockMembers = [
  { userId: { value: SESSION_USER_ID }, role: { value: 'owner' }, joinedAt: new Date('2024-01-01') },
  { userId: { value: TARGET_USER_ID }, role: { value: 'editor' }, joinedAt: new Date('2024-01-02') },
];
const mockUsers = [
  { id: { value: SESSION_USER_ID }, email: { value: 'owner@example.com' }, displayName: 'Owner' },
  { id: { value: TARGET_USER_ID }, email: { value: 'editor@example.com' }, displayName: 'Editor' },
];

function buildTestServer() {
  const app = Fastify();
  decorateApp(app, 'repos', {
    project: { findById: jest.fn().mockResolvedValue({ id: { value: PROJECT_ID } }) },
    projectMember: {
      findByCompositeKey: jest.fn().mockResolvedValue(mockCallerMembership),
      findByProjectId: jest.fn().mockResolvedValue(mockMembers),
      addMember: jest.fn(),
    },
    user: {
      findById: jest.fn().mockImplementation((userId: { value: string }) =>
        mockUsers.find((u) => u.id.value === userId.value) ?? null,
      ),
    },
    auditLog: { save: jest.fn() },
  });
  app.register(memberRoutes);
  return app;
}

describe('GET /api/projects/:id/members', () => {
  it('returns 200 with member list', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/members` });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.members).toHaveLength(2);
    expect(body.data.members[0].role).toBe('owner');
  });

  it('returns 403 when caller is not a member', async () => {
    const app = buildTestServer();
    (app.repos as never as { projectMember: { findByCompositeKey: jest.Mock } })
      .projectMember.findByCompositeKey.mockResolvedValue(null);

    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/members` });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
  });

  it('returns 500 when a user lookup returns null', async () => {
    const app = buildTestServer();
    (app.repos as never as { user: { findById: jest.Mock } })
      .user.findById.mockResolvedValue(null);

    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/members` });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when repo throws', async () => {
    const app = buildTestServer();
    (app.repos as never as { projectMember: { findByProjectId: jest.Mock } })
      .projectMember.findByProjectId.mockRejectedValue(new Error('db error'));

    const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/members` });
    expect(response.statusCode).toBe(500);
  });
});

describe('POST /api/projects/:id/members', () => {
  const mockInvitedUser = {
    id: { value: TARGET_USER_ID },
    email: { value: 'invited@example.com' },
    displayName: 'Invited User',
  };
  const mockMember = { userId: { value: TARGET_USER_ID }, role: { value: 'editor' }, joinedAt: new Date('2024-01-01') };

  it('returns 201 with member data on success', async () => {
    jest.spyOn(InviteUserUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: { member: mockMember as never, user: mockInvitedUser as never },
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/members`,
      payload: { email: 'invited@example.com', role: 'editor' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.data.email).toBe('invited@example.com');
    expect(body.data.role).toBe('editor');
  });

  it('returns 403 FORBIDDEN on PermissionDeniedError', async () => {
    jest.spyOn(InviteUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/members`,
      payload: { email: 'x@example.com', role: 'viewer' },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 on UserNotFoundError', async () => {
    jest.spyOn(InviteUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new UserNotFoundError('x@example.com'),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/members`,
      payload: { email: 'x@example.com', role: 'viewer' },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('USER_NOT_FOUND');
  });

  it('returns 409 ALREADY_A_MEMBER on ProjectMemberAlreadyExistsError', async () => {
    jest.spyOn(InviteUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectMemberAlreadyExistsError(PROJECT_ID, TARGET_USER_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/members`,
      payload: { email: 'x@example.com', role: 'viewer' },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('ALREADY_A_MEMBER');
  });

  it('returns 404 on ProjectNotFoundError', async () => {
    jest.spyOn(InviteUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new ProjectNotFoundError(PROJECT_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/members`,
      payload: { email: 'x@example.com', role: 'viewer' },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 400 VALIDATION_ERROR for unrecognised error', async () => {
    jest.spyOn(InviteUserUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: Object.assign(new Error('bad'), { name: 'UnknownError' }) as never,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT_ID}/members`,
      payload: { email: 'x@example.com', role: 'viewer' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/projects/:id/members/:userId', () => {
  it('returns 200 with updated role on success', async () => {
    jest.spyOn(ChangeMemberRoleUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: undefined,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
      payload: { role: 'owner' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.role).toBe('owner');
  });

  it('returns 404 MEMBER_NOT_FOUND on MemberNotFoundError', async () => {
    jest.spyOn(ChangeMemberRoleUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new MemberNotFoundError(PROJECT_ID, TARGET_USER_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
      payload: { role: 'viewer' },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('returns 403 on PermissionDeniedError', async () => {
    jest.spyOn(ChangeMemberRoleUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new PermissionDeniedError(),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
      payload: { role: 'viewer' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('DELETE /api/projects/:id/members/:userId', () => {
  it('returns 200 on success', async () => {
    jest.spyOn(RemoveMemberUseCase.prototype, 'execute').mockResolvedValue({
      success: true,
      value: undefined,
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.message).toContain('removed');
  });

  it('returns 409 CANNOT_REMOVE_LAST_OWNER', async () => {
    jest.spyOn(RemoveMemberUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new CannotRemoveLastOwnerError(PROJECT_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
  });

  it('returns 404 on MemberNotFoundError', async () => {
    jest.spyOn(RemoveMemberUseCase.prototype, 'execute').mockResolvedValue({
      success: false,
      error: new MemberNotFoundError(PROJECT_ID, TARGET_USER_ID),
    });

    const app = buildTestServer();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('MEMBER_NOT_FOUND');
  });
});
