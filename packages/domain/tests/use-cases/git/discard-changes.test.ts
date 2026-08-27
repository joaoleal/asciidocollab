import { DiscardChangesUseCase } from '../../../src/use-cases/git/discard-changes';
import { AUDIT_GIT_CHANGES_DISCARDED } from '../../../src/audit-actions';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
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
import type { GitMergeFileChange } from '../../../src/ports/git/git-command-runner';
import type { FileChangeReconciler } from '../../../src/use-cases/git/pull-changes';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REPO_ID = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099');

const DISCARD_PATH = 'chapters/intro.adoc';
const RESTORED_CONTENT = Buffer.from('= Introduction\nCommitted content', 'utf8');
const CHANGE_SET: GitMergeFileChange[] = [
  { type: 'modified', path: DISCARD_PATH, content: RESTORED_CONTENT, mimeType: 'text/asciidoc' },
];
const RESTORED_PATHS = [DISCARD_PATH];

function makeReconciler(): FileChangeReconciler & { apply: jest.Mock } {
  return {
    apply: jest.fn().mockResolvedValue({ success: true, value: { changedPaths: RESTORED_PATHS, anomalies: [] } }),
  };
}

async function memberRepoWithRole(role: string | null): Promise<InMemoryProjectMemberRepository> {
  const repo = new InMemoryProjectMemberRepository();
  if (role) {
    await repo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  return repo;
}

interface Harness {
  useCase: DiscardChangesUseCase;
  commandRunner: InMemoryGitCommandRunner;
  gitOperationRepo: InMemoryGitOperationRepository;
  auditRepo: InMemoryAuditLogRepository;
  reconciler: FileChangeReconciler & { apply: jest.Mock };
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
  const reconciler = makeReconciler();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        REPO_ID,
        PROJECT_ID,
        GitProvider.create('github'),
        'https://github.com/example/repo.git',
        PROJECT_ID.value,
      ),
    );
  }

  const useCase = new DiscardChangesUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    gitOperationRepo,
    commandRunner,
    reconciler,
  );

  return { useCase, commandRunner, gitOperationRepo, auditRepo, reconciler };
}

function discardInput(overrides: Partial<{ paths: readonly string[]; fromCommit: string }> = {}) {
  return {
    actorId: ACTOR_ID,
    projectId: PROJECT_ID,
    paths: overrides.paths ?? [DISCARD_PATH],
    fromCommit: overrides.fromCommit,
  };
}

describe('DiscardChangesUseCase', () => {
  test('a VIEWER is denied with InsufficientRoleError, the denial is audited, and neither the runner nor the reconciler is called', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute(discardInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.discardChangesCalls).toHaveLength(0);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits).toHaveLength(1);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError and the runner is never called', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute(discardInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.discardChangesCalls).toHaveLength(0);
  });

  test('discarding to HEAD lands the runner change-set through the reconciler and returns its restored paths', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiscardChanges(PROJECT_ID, CHANGE_SET);

    const result = await harness.useCase.execute(discardInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toEqual({ restoredPaths: RESTORED_PATHS });

    expect(harness.reconciler.apply).toHaveBeenCalledTimes(1);
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, CHANGE_SET);

    expect(harness.commandRunner.discardChangesCalls).toHaveLength(1);
    expect(harness.commandRunner.discardChangesCalls[0].input).toEqual({
      paths: [DISCARD_PATH],
      fromCommit: undefined,
    });
  });

  test('restoring from a chosen commit passes fromCommit and paths through to the runner', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiscardChanges(PROJECT_ID, CHANGE_SET);
    const commit = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    await harness.useCase.execute(discardInput({ paths: [DISCARD_PATH], fromCommit: commit }));

    expect(harness.commandRunner.discardChangesCalls).toHaveLength(1);
    expect(harness.commandRunner.discardChangesCalls[0].input).toEqual({
      paths: [DISCARD_PATH],
      fromCommit: commit,
    });
  });

  test('the work runs inside the single-flight guard, and a refusal surfaces flat', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiscardChanges(PROJECT_ID, CHANGE_SET);
    await harness.gitOperationRepo.enqueue({
      projectId: PROJECT_ID,
      kind: 'PUSH',
      triggeredByUserId: ACTOR_ID,
    });

    const result = await harness.useCase.execute(discardInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitOperationInProgressError);
    expect(harness.commandRunner.discardChangesCalls).toHaveLength(0);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
  });

  test('all-or-nothing: a failing discardChanges never reaches the reconciler and its error propagates', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiscardChangesFailure(PROJECT_ID, new GitCommandFailedError('git checkout failed'));

    const result = await harness.useCase.execute(discardInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
  });

  test('a reconciler failure propagates unchanged from execute', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiscardChanges(PROJECT_ID, CHANGE_SET);
    harness.reconciler.apply.mockResolvedValue({
      success: false,
      error: new GitCommandFailedError('collaboration source unreachable'),
    });

    const result = await harness.useCase.execute(discardInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
  });

  test('a successful discard records an AUDIT_GIT_CHANGES_DISCARDED audit entry with the restored count', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedDiscardChanges(PROJECT_ID, CHANGE_SET);

    const result = await harness.useCase.execute(discardInput());
    expect(result.success).toBe(true);

    const entries = await harness.auditRepo.findByProjectId(PROJECT_ID);
    const entry = entries.find((entry) => entry.action === AUDIT_GIT_CHANGES_DISCARDED);
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ count: RESTORED_PATHS.length });
  });
});
