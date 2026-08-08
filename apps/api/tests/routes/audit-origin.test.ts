import Fastify from 'fastify';
import { AuditLog } from '@asciidocollab/domain';
import { memberRoutes } from '../../src/routes/projects/members';
import { decorateApp } from '../helpers/decorate-app';

jest.mock('../../src/plugins/require-auth', () => ({
  requireAuth: jest.fn((_request: unknown, _rep: unknown, done: () => void) => done()),
  getAuthenticatedUserId: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
}));

const SESSION_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440002';
const TARGET_USER_ID = '550e8400-e29b-41d4-a716-446655440003';

const callerMembership = { userId: { value: SESSION_USER_ID }, role: { value: 'owner' } };
const targetMembership = { userId: { value: TARGET_USER_ID }, role: { value: 'viewer' } };

function buildTestServer() {
  const auditLog = { save: jest.fn() };
  const app = Fastify();
  decorateApp(app, 'repos', {
    project: { findById: jest.fn().mockResolvedValue({ id: { value: PROJECT_ID } }) },
    projectMember: {
      findByCompositeKey: jest.fn((_projectId: unknown, userId: { value: string }) =>
        Promise.resolve(userId.value === TARGET_USER_ID ? targetMembership : callerMembership),
      ),
      findByProjectId: jest.fn().mockResolvedValue([callerMembership, targetMembership]),
      updateRole: jest.fn().mockResolvedValue(undefined),
    },
    auditLog,
  });
  app.register(memberRoutes);
  return { app, auditLog };
}

describe('audit origin — PATCH /api/projects/:id/members/:userId', () => {
  it('records the request origin and before/after roles in the saved audit log', async () => {
    const { app, auditLog } = buildTestServer();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${PROJECT_ID}/members/${TARGET_USER_ID}`,
      payload: { role: 'editor' },
      remoteAddress: '127.0.0.1',
    });

    expect(response.statusCode).toBe(200);
    expect(auditLog.save).toHaveBeenCalledTimes(1);

    const saved = auditLog.save.mock.calls[0][0] as AuditLog;
    expect(saved.action).toBe('member.roleChanged');
    // Fastify inject's default source ip is 127.0.0.1.
    expect((saved.metadata.origin as { ipAddress?: string }).ipAddress).toBe('127.0.0.1');
    expect(saved.metadata.previousRole).toBe('viewer');
    expect(saved.metadata.newRole).toBe('editor');
  });
});
