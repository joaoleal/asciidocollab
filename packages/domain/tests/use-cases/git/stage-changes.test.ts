import { StageChangesUseCase } from '../../../src/use-cases/git/stage-changes';
import { AUDIT_GIT_CHANGES_STAGED, AUDIT_GIT_CHANGES_UNSTAGED } from '../../../src/audit-actions';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { ValidationError } from '../../../src/errors/common/validation-error';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
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
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: StageChangesUseCase;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  memberRepo: InMemoryProjectMemberRepository;
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
  const gitOperationRepo = new InMemoryGitOperationRepository();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099'),
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );
  }

  const useCase = new StageChangesUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    gitOperationRepo,
    commandRunner,
  );

  return { useCase, gitRepositoryRepo, commandRunner, gitOperationRepo, auditRepo, memberRepo };
}

describe('StageChangesUseCase', () => {
  test('an EDITOR stages an unstaged and an untracked file: both come back staged', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [
        { path: 'chapters/intro.adoc', changeType: 'modified', state: 'staged' },
        { path: 'chapters/new.adoc', changeType: 'added', state: 'staged' },
        { path: 'chapters/untouched.adoc', changeType: 'modified', state: 'unstaged' },
      ],
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc', 'chapters/new.adoc'],
      action: 'stage',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.staged).toEqual(['chapters/intro.adoc', 'chapters/new.adoc']);

    expect(harness.commandRunner.stageCalls).toHaveLength(1);
    expect(harness.commandRunner.stageCalls[0].projectId).toBe(PROJECT_ID);
    expect(harness.commandRunner.stageCalls[0].paths).toEqual([
      'chapters/intro.adoc',
      'chapters/new.adoc',
    ]);
    expect(harness.commandRunner.unstageCalls).toHaveLength(0);
  });

  test('an EDITOR unstages a staged file: it no longer comes back staged', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: 'chapters/intro.adoc', changeType: 'modified', state: 'unstaged' }],
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'unstage',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.staged).toEqual([]);

    expect(harness.commandRunner.unstageCalls).toHaveLength(1);
    expect(harness.commandRunner.unstageCalls[0].paths).toEqual(['chapters/intro.adoc']);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
  });

  test('a VIEWER is denied with InsufficientRoleError and stage is never called', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'stage',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
  });

  test('a non-member is denied with InsufficientRoleError and stage is never called', async () => {
    const harness = await buildHarness({ role: null });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'stage',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
  });

  test('an already-active operation refuses with GitOperationInProgressError and stage is never called', async () => {
    const harness = await buildHarness();
    await harness.gitOperationRepo.enqueue({
      projectId: PROJECT_ID,
      kind: 'COMMIT',
      triggeredByUserId: ACTOR_ID,
    });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'stage',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitOperationInProgressError);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError, after the role gate', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'stage',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
  });

  test('empty paths refuses with ValidationError before any connectivity or git call', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: [],
      action: 'stage',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(ValidationError);
    expect(harness.commandRunner.stageCalls).toHaveLength(0);
  });

  test('a failing stage command propagates its GitCommandFailedError', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedStageFailure(
      PROJECT_ID,
      new GitCommandFailedError('git add failed'),
    );

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'stage',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a successful stage records AUDIT_GIT_CHANGES_STAGED, and a successful unstage records the distinguishable AUDIT_GIT_CHANGES_UNSTAGED', async () => {
    const staging = await buildHarness();
    staging.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: 'chapters/intro.adoc', changeType: 'modified', state: 'staged' }],
    });
    const stageResult = await staging.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'stage',
    });
    expect(stageResult.success).toBe(true);

    const stageEntries = await staging.auditRepo.findByProjectId(PROJECT_ID);
    expect(stageEntries.some((entry) => entry.action === AUDIT_GIT_CHANGES_STAGED)).toBe(true);
    expect(stageEntries.some((entry) => entry.action === AUDIT_GIT_CHANGES_UNSTAGED)).toBe(false);

    const unstaging = await buildHarness();
    unstaging.commandRunner.seedStatus(PROJECT_ID, {
      currentBranch: 'main',
      changes: [{ path: 'chapters/intro.adoc', changeType: 'modified', state: 'unstaged' }],
    });
    const unstageResult = await unstaging.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      paths: ['chapters/intro.adoc'],
      action: 'unstage',
    });
    expect(unstageResult.success).toBe(true);

    const unstageEntries = await unstaging.auditRepo.findByProjectId(PROJECT_ID);
    expect(unstageEntries.some((entry) => entry.action === AUDIT_GIT_CHANGES_UNSTAGED)).toBe(true);
    expect(unstageEntries.some((entry) => entry.action === AUDIT_GIT_CHANGES_STAGED)).toBe(false);
  });
});
