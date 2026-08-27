import { CreateBranchUseCase } from '../../../src/use-cases/git/create-branch';
import { AUDIT_GIT_BRANCH_CREATED } from '../../../src/audit-actions';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440020');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440021');
const BRANCH_NAME = 'feature/new-chapter';

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: CreateBranchUseCase;
  commandRunner: InMemoryGitCommandRunner;
  auditRepo: InMemoryAuditLogRepository;
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { role = 'editor', connected = true } = options;

  const memberRepo = await memberRepoWithRole(role);
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440098'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );
  }

  const useCase = new CreateBranchUseCase(memberRepo, auditRepo, gitRepositoryRepo, commandRunner);

  return { useCase, commandRunner, auditRepo };
}

describe('CreateBranchUseCase', () => {
  test('an EDITOR creates a branch: the runner is called with the name and the branch is returned', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      name: BRANCH_NAME,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.branch).toEqual({ name: BRANCH_NAME });
    expect(harness.commandRunner.createBranchCalls).toEqual([
      { projectId: PROJECT_ID, input: { name: BRANCH_NAME } },
    ]);
  });

  test('a VIEWER is denied with InsufficientRoleError, and createBranch is never called', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      name: BRANCH_NAME,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.createBranchCalls).toHaveLength(0);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      name: BRANCH_NAME,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.createBranchCalls).toHaveLength(0);
  });

  test('an empty (whitespace) name refuses with ValidationError before any git call', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      name: '   ',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    expect(harness.commandRunner.createBranchCalls).toHaveLength(0);
  });

  test('a failing create-branch command propagates its GitCommandFailedError', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedCreateBranchFailure(
      PROJECT_ID,
      new GitCommandFailedError('a branch by that name already exists'),
    );

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      name: BRANCH_NAME,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a successful branch creation records an AUDIT_GIT_BRANCH_CREATED audit entry with the branch name', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      name: BRANCH_NAME,
    });
    expect(result.success).toBe(true);

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    const entry = entries.find((entry) => entry.action === AUDIT_GIT_BRANCH_CREATED);
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ name: BRANCH_NAME });
  });
});
