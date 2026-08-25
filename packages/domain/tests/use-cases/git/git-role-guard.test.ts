import { requireGitRole } from '../../../src/use-cases/git/git-role-guard';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

describe('requireGitRole', () => {
  test('allows a VIEWER to perform a viewer-tier action', async () => {
    const memberRepo = await memberRepoWithRole('viewer');
    const auditRepo = new InMemoryAuditLogRepository();

    const result = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'viewer',
    });

    expect(result.success).toBe(true);
  });

  test('denies a VIEWER a commit (editor-tier action) with InsufficientRoleError', async () => {
    const memberRepo = await memberRepoWithRole('viewer');
    const auditRepo = new InMemoryAuditLogRepository();

    const result = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'editor',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InsufficientRoleError);
    }
  });

  test('allows an EDITOR to commit (editor-tier action)', async () => {
    const memberRepo = await memberRepoWithRole('editor');
    const auditRepo = new InMemoryAuditLogRepository();

    const result = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'editor',
    });

    expect(result.success).toBe(true);
  });

  test('denies an EDITOR an owner-tier action (e.g. connect/disconnect a remote)', async () => {
    const memberRepo = await memberRepoWithRole('editor');
    const auditRepo = new InMemoryAuditLogRepository();

    const result = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'owner',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InsufficientRoleError);
    }
  });

  test('allows an OWNER to perform an owner-tier action', async () => {
    const memberRepo = await memberRepoWithRole('owner');
    const auditRepo = new InMemoryAuditLogRepository();

    const result = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'owner',
    });

    expect(result.success).toBe(true);
  });

  test('an OWNER may also perform viewer- and editor-tier actions', async () => {
    const memberRepo = await memberRepoWithRole('owner');
    const auditRepo = new InMemoryAuditLogRepository();

    const viewerResult = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'viewer',
    });
    const editorResult = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'editor',
    });

    expect(viewerResult.success).toBe(true);
    expect(editorResult.success).toBe(true);
  });

  test('denies a non-member of the project entirely, even for the lowest (viewer) tier', async () => {
    const memberRepo = await memberRepoWithRole(null);
    const auditRepo = new InMemoryAuditLogRepository();

    const result = await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'viewer',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InsufficientRoleError);
    }
  });

  test('records an authz.denied audit entry on denial', async () => {
    const memberRepo = await memberRepoWithRole('viewer');
    const auditRepo = new InMemoryAuditLogRepository();

    await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'owner',
    });

    const entries = await auditRepo.findByProjectId(PROJECT_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('authz.denied');
  });

  test('does not record an audit entry when access is allowed', async () => {
    const memberRepo = await memberRepoWithRole('owner');
    const auditRepo = new InMemoryAuditLogRepository();

    await requireGitRole(memberRepo, auditRepo, {
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      requiredRole: 'owner',
    });

    const entries = await auditRepo.findByProjectId(PROJECT_ID);
    expect(entries).toHaveLength(0);
  });
});
