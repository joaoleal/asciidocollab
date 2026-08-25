import { UndoPullUseCase } from '../../../src/use-cases/git/undo-pull';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { NothingToUndoError } from '../../../src/errors/git/nothing-to-undo';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { GitOperationInProgressError } from '../../../src/errors/git/git-operation-in-progress';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { AUDIT_AUTHZ_DENIED, AUDIT_GIT_PULL_UNDONE } from '../../../src/audit-actions';
import type { GitMergeFileChange } from '../../../src/ports/git/git-command-runner';
import type { FileChangeReconciler } from '../../../src/use-cases/git/pull-changes';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitRepositoryRepository } from '../../ports/project/in-memory-git-repository.repository';
import { InMemoryGitCommandRunner } from '../../ports/git/in-memory-git-command-runner';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { InMemoryConflictStageStore } from '../../ports/git/in-memory-conflict-stage-store';

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const REPO_ID = GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440099');
const REMOTE_URL = 'https://github.com/example/repo.git';
const CURRENT_BRANCH = 'main';
const PRE_OP_HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const REVERT_CHANGES: readonly GitMergeFileChange[] = [
  { type: 'modified', path: 'chapters/intro.adoc', content: Buffer.from('pre-pull text'), mimeType: 'text/asciidoc' },
];

function makeReconciler(): FileChangeReconciler & { apply: jest.Mock } {
  return {
    apply: jest.fn().mockResolvedValue({ success: true, value: { changedPaths: ['chapters/intro.adoc'] } }),
  };
}

interface Harness {
  useCase: UndoPullUseCase;
  gitOperationRepo: InMemoryGitOperationRepository;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  commandRunner: InMemoryGitCommandRunner;
  conflictStageStore: InMemoryConflictStageStore;
  auditRepo: InMemoryAuditLogRepository;
  reconciler: FileChangeReconciler & { apply: jest.Mock };
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { role = 'editor', connected = true } = options;

  const memberRepo = new InMemoryProjectMemberRepository();
  if (role) {
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const gitOperationRepo = new InMemoryGitOperationRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const conflictStageStore = new InMemoryConflictStageStore();
  const reconciler = makeReconciler();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        REPO_ID,
        PROJECT_ID,
        GitProvider.create('github'),
        REMOTE_URL,
        PROJECT_ID.value,
        CURRENT_BRANCH,
        'UP_TO_DATE',
        'main',
        'remote-head-commit-hash',
        new Date('2024-01-01T00:00:00.000Z'),
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
  }

  commandRunner.seedBehindAhead(PROJECT_ID, { behind: 0, ahead: 0 });

  const useCase = new UndoPullUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    gitOperationRepo,
    commandRunner,
    conflictStageStore,
    reconciler,
  );

  return { useCase, gitOperationRepo, gitRepositoryRepo, commandRunner, conflictStageStore, auditRepo, reconciler };
}

/** Enqueues a PULL operation, claims it, transitions to AWAITING_CONFLICT, and seeds its snapshot. */
async function seedAwaitingConflictPull(harness: Harness): Promise<GitOperationId> {
  const enqueued = await harness.gitOperationRepo.enqueue({
    projectId: PROJECT_ID,
    kind: 'PULL',
    triggeredByUserId: ACTOR_ID,
  });
  await harness.gitOperationRepo.claimNextQueued(30_000);
  await harness.gitOperationRepo.transition(enqueued.id, 'AWAITING_CONFLICT');
  await harness.gitOperationRepo.createConflict({ operationId: enqueued.id, path: 'chapters/intro.adoc' });
  harness.conflictStageStore.seedSnapshot(enqueued.id, { preOpHead: PRE_OP_HEAD, branch: CURRENT_BRANCH });
  return enqueued.id;
}

/** Enqueues a PULL operation, claims and runs it to SUCCEEDED, and seeds its retained snapshot. */
async function seedSucceededPull(harness: Harness): Promise<GitOperationId> {
  const enqueued = await harness.gitOperationRepo.enqueue({
    projectId: PROJECT_ID,
    kind: 'PULL',
    triggeredByUserId: ACTOR_ID,
  });
  await harness.gitOperationRepo.claimNextQueued(30_000);
  await harness.gitOperationRepo.transition(enqueued.id, 'SUCCEEDED');
  harness.conflictStageStore.seedSnapshot(enqueued.id, { preOpHead: PRE_OP_HEAD, branch: CURRENT_BRANCH });
  return enqueued.id;
}

function undoInput() {
  return { actorId: ACTOR_ID, projectId: PROJECT_ID };
}

describe('UndoPullUseCase', () => {
  test('case A: an AWAITING_CONFLICT pull is restored to its snapshot, reverted, and ABORTED', async () => {
    const harness = await buildHarness();
    const operationId = await seedAwaitingConflictPull(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, changes: REVERT_CHANGES });

    const result = await harness.useCase.execute(undoInput());

    expect(result).toEqual({ success: true, value: { operationId, headCommit: PRE_OP_HEAD } });

    expect(harness.commandRunner.restoreToSnapshotCalls).toEqual([
      { projectId: PROJECT_ID, input: { operationId } },
    ]);
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, REVERT_CHANGES);

    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.state).toBe('ABORTED');
    expect(await harness.gitOperationRepo.listConflicts(operationId)).toHaveLength(0);
    expect(harness.conflictStageStore.clearedOperationIds).toContainEqual(operationId);

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits.some((entry) => entry.action === AUDIT_GIT_PULL_UNDONE)).toBe(true);
  });

  test('case A: a restore failure reverts to AWAITING_CONFLICT and lands nothing', async () => {
    const harness = await buildHarness();
    const operationId = await seedAwaitingConflictPull(harness);
    harness.commandRunner.seedRestoreToSnapshotFailure(PROJECT_ID, new GitCommandFailedError('reset failed'));

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
    // The snapshot is retained for a retry.
    expect(harness.conflictStageStore.clearedOperationIds).not.toContainEqual(operationId);
  });

  test('case A: a reconciler failure reverts to AWAITING_CONFLICT, tree already safe, snapshot retained', async () => {
    const harness = await buildHarness();
    const operationId = await seedAwaitingConflictPull(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, changes: REVERT_CHANGES });
    harness.reconciler.apply.mockResolvedValue({ success: false, error: new GitCommandFailedError('revert failed') });

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
    expect(harness.conflictStageStore.clearedOperationIds).not.toContainEqual(operationId);
  });

  test('case B: a SUCCEEDED clean pull with a retained snapshot is restored, reverted, and its snapshot cleared', async () => {
    const harness = await buildHarness();
    const operationId = await seedSucceededPull(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, changes: REVERT_CHANGES });

    const result = await harness.useCase.execute(undoInput());

    expect(result).toEqual({ success: true, value: { operationId, headCommit: PRE_OP_HEAD } });
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, REVERT_CHANGES);

    // No synthetic UNDO_PULL row is minted; the original pull operation stays SUCCEEDED.
    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.state).toBe('SUCCEEDED');
    expect(harness.conflictStageStore.clearedOperationIds).toContainEqual(operationId);

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits.some((entry) => entry.action === AUDIT_GIT_PULL_UNDONE)).toBe(true);
  });

  test('case B: no snapshot anywhere refuses with NothingToUndoError', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NothingToUndoError);
    expect(harness.commandRunner.restoreToSnapshotCalls).toHaveLength(0);
  });

  test('case B: a prior pull whose snapshot was already cleared refuses with NothingToUndoError', async () => {
    const harness = await buildHarness();
    const operationId = await seedSucceededPull(harness);
    await harness.conflictStageStore.clear(operationId);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NothingToUndoError);
  });

  test('case B: a reconciler failure leaves the retained snapshot in place for a retry', async () => {
    const harness = await buildHarness();
    const operationId = await seedSucceededPull(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, changes: REVERT_CHANGES });
    harness.reconciler.apply.mockResolvedValue({ success: false, error: new GitCommandFailedError('revert failed') });

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.conflictStageStore.clearedOperationIds).not.toContainEqual(operationId);
  });

  test('case B: another active operation refuses with GitOperationInProgressError', async () => {
    const harness = await buildHarness();
    await seedSucceededPull(harness);
    // A second, unrelated operation is active for the project (not an AWAITING_CONFLICT pull).
    await harness.gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'BRANCH_SWITCH', triggeredByUserId: ACTOR_ID });
    await harness.gitOperationRepo.claimNextQueued(30_000);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitOperationInProgressError);
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError', async () => {
    const harness = await buildHarness({ connected: false });
    await seedAwaitingConflictPull(harness);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
  });

  test('a non-editor is denied with InsufficientRoleError, the denial is audited, and nothing is touched', async () => {
    const harness = await buildHarness({ role: 'viewer' });
    const operationId = await seedAwaitingConflictPull(harness);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.restoreToSnapshotCalls).toHaveLength(0);
    const audited = await harness.auditRepo.findAll();
    expect(audited.some((entry) => entry.action === AUDIT_AUTHZ_DENIED)).toBe(true);
    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
  });
});
