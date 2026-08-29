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
import type { ConflictUndoSnapshot } from '../../../src/ports/git/conflict-stage-store';
import type { GitOperation } from '../../../src/entities/git-operation';
import type { GitOperationTransitionTarget } from '../../../src/ports/git/git-operation-repository';
import { IllegalGitOperationTransitionError } from '../../../src/errors/git/illegal-git-operation-transition';
import type { Result } from '../../../src/types/result';

/** Stage store whose snapshot read always fails, standing in for an unreadable blob store. */
class UnreadableSnapshotStageStore extends InMemoryConflictStageStore {
  async readSnapshot(): Promise<Result<ConflictUndoSnapshot | null, GitCommandFailedError>> {
    return { success: false, error: new GitCommandFailedError('the undo snapshot could not be read') };
  }
}

/** Operation repository that refuses to claim the awaiting operation back into RUNNING. */
class UnclaimableGitOperationRepository extends InMemoryGitOperationRepository {
  async transition(
    operationId: GitOperationId,
    toState: GitOperationTransitionTarget,
  ): Promise<Result<GitOperation, IllegalGitOperationTransitionError>> {
    if (toState === 'RUNNING') {
      return { success: false, error: new IllegalGitOperationTransitionError('AWAITING_CONFLICT', toState) };
    }
    return super.transition(operationId, toState);
  }
}

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
    apply: jest.fn().mockResolvedValue({ success: true, value: { changedPaths: ['chapters/intro.adoc'], anomalies: [] } }),
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
  /** The sync status the stored repository link starts on. */
  syncStatus?: 'UP_TO_DATE' | 'BEHIND';
  /** Substitute stage store, for exercising a failing blob read. */
  conflictStageStore?: InMemoryConflictStageStore;
  /** Substitute operation repository, for exercising a refused transition. */
  gitOperationRepo?: InMemoryGitOperationRepository;
  /** The branch the stored repository link starts on — the target branch, for a switch-abort test. */
  currentBranch?: string;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'editor',
    connected = true,
    syncStatus = 'UP_TO_DATE',
    conflictStageStore = new InMemoryConflictStageStore(),
    gitOperationRepo = new InMemoryGitOperationRepository(),
    currentBranch = CURRENT_BRANCH,
  } = options;

  const memberRepo = new InMemoryProjectMemberRepository();
  if (role) {
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  const auditRepo = new InMemoryAuditLogRepository();
  const gitRepositoryRepo = new InMemoryGitRepositoryRepository();
  const commandRunner = new InMemoryGitCommandRunner();
  const reconciler = makeReconciler();

  if (connected) {
    await gitRepositoryRepo.save(
      new GitRepository(
        REPO_ID,
        PROJECT_ID,
        GitProvider.create('github'),
        REMOTE_URL,
        PROJECT_ID.value,
        currentBranch,
        syncStatus,
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

/**
 * Enqueues a BRANCH_SWITCH operation, claims it, transitions to AWAITING_CONFLICT, and seeds its
 * snapshot — a switch's snapshot records the source branch's pre-switch tip under the same
 * `preOpHead` field a pull uses.
 */
async function seedAwaitingConflictSwitch(harness: Harness): Promise<GitOperationId> {
  const enqueued = await harness.gitOperationRepo.enqueue({
    projectId: PROJECT_ID,
    kind: 'BRANCH_SWITCH',
    triggeredByUserId: ACTOR_ID,
    branch: 'feature-x',
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

/**
 * Enqueues a BRANCH_SWITCH operation, claims and runs it to SUCCEEDED, and seeds its retained
 * snapshot — a clean switch records the pre-switch source-branch tip under the same `preOpHead`
 * field a pull uses, so its undo restores exactly like a pull's plus a `currentBranch` walk-back.
 */
async function seedSucceededSwitch(harness: Harness): Promise<GitOperationId> {
  const enqueued = await harness.gitOperationRepo.enqueue({
    projectId: PROJECT_ID,
    kind: 'BRANCH_SWITCH',
    triggeredByUserId: ACTOR_ID,
    branch: 'feature-x',
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
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, branch: CURRENT_BRANCH, changes: REVERT_CHANGES });

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

  test('case A: an AWAITING_CONFLICT branch switch is restored to its pre-switch snapshot, reverted, and ABORTED', async () => {
    const harness = await buildHarness();
    const operationId = await seedAwaitingConflictSwitch(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, branch: CURRENT_BRANCH, changes: REVERT_CHANGES });

    const result = await harness.useCase.execute(undoInput());

    expect(result).toEqual({ success: true, value: { operationId, headCommit: PRE_OP_HEAD } });

    // Restored via the same snapshot-keyed reset a conflicted pull uses — the use case's body is
    // kind-agnostic, so a switch's `preOpHead` (its pre-switch source-branch tip) is honored exactly
    // like a pull's.
    expect(harness.commandRunner.restoreToSnapshotCalls).toEqual([
      { projectId: PROJECT_ID, input: { operationId } },
    ]);
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, REVERT_CHANGES);

    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.kind).toBe('BRANCH_SWITCH');
    expect(operation?.state).toBe('ABORTED');
    expect(await harness.gitOperationRepo.listConflicts(operationId)).toHaveLength(0);
    expect(harness.conflictStageStore.clearedOperationIds).toContainEqual(operationId);

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits.some((entry) => entry.action === AUDIT_GIT_PULL_UNDONE)).toBe(true);
  });

  test('case A: undoing a conflicted branch switch walks currentBranch back to the restored source branch', async () => {
    // The conflicted switch already advanced the link to the TARGET branch, so the row starts on it;
    // undoing it must return currentBranch to the SOURCE branch the restore checked back out.
    const harness = await buildHarness({ currentBranch: 'feature-x' });
    await seedAwaitingConflictSwitch(harness);
    // The restore returns HEAD to the source branch (the switch was main -> feature-x).
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, {
      headCommit: PRE_OP_HEAD,
      branch: CURRENT_BRANCH,
      changes: REVERT_CHANGES,
    });

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(true);
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
    // The corrected branch is what behind/ahead is recomputed against, not the target it was on.
    expect(harness.commandRunner.behindAheadCalls).toContainEqual({ projectId: PROJECT_ID, branch: CURRENT_BRANCH });
  });

  test('case A: undoing a conflicted pull leaves currentBranch unchanged', async () => {
    // A pull abort restores the SAME branch (its restore reports the already-current branch), so the
    // currentBranch walk-back is a no-op and must never disturb the pull path.
    const harness = await buildHarness();
    await seedAwaitingConflictPull(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, {
      headCommit: PRE_OP_HEAD,
      branch: CURRENT_BRANCH,
      changes: REVERT_CHANGES,
    });

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(true);
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
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
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, branch: CURRENT_BRANCH, changes: REVERT_CHANGES });
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
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, branch: CURRENT_BRANCH, changes: REVERT_CHANGES });

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

  test('case B: a SUCCEEDED clean branch switch is restored to its snapshot and walks currentBranch back to the source branch', async () => {
    // A clean switch already advanced the link to the TARGET branch, so the row starts on it; undoing
    // it must return currentBranch to the SOURCE branch the restore checked back out — the same
    // walk-back Case A applies to a conflicted switch, now for a cleanly-succeeded one via Case B.
    const harness = await buildHarness({ currentBranch: 'feature-x' });
    const operationId = await seedSucceededSwitch(harness);
    // The restore returns HEAD to the source branch (the switch was main -> feature-x).
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, {
      headCommit: PRE_OP_HEAD,
      branch: CURRENT_BRANCH,
      changes: REVERT_CHANGES,
    });

    const result = await harness.useCase.execute(undoInput());

    expect(result).toEqual({ success: true, value: { operationId, headCommit: PRE_OP_HEAD } });
    expect(harness.commandRunner.restoreToSnapshotCalls).toEqual([
      { projectId: PROJECT_ID, input: { operationId } },
    ]);
    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, REVERT_CHANGES);

    // No synthetic row is minted; the original switch operation stays SUCCEEDED, its snapshot cleared.
    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.kind).toBe('BRANCH_SWITCH');
    expect(operation?.state).toBe('SUCCEEDED');
    expect(harness.conflictStageStore.clearedOperationIds).toContainEqual(operationId);

    // The link is walked back to the source branch, and behind/ahead is recomputed against it.
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.currentBranch).toBe(CURRENT_BRANCH);
    expect(harness.commandRunner.behindAheadCalls).toContainEqual({ projectId: PROJECT_ID, branch: CURRENT_BRANCH });

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
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, branch: CURRENT_BRANCH, changes: REVERT_CHANGES });
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

  test('a refused claim back into RUNNING leaves the awaiting operation untouched and restores nothing', async () => {
    const harness = await buildHarness({ gitOperationRepo: new UnclaimableGitOperationRepository() });
    const operationId = await seedAwaitingConflictPull(harness);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(IllegalGitOperationTransitionError);
    expect(harness.commandRunner.restoreToSnapshotCalls).toHaveLength(0);
    const operation = await harness.gitOperationRepo.findById(operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
  });

  test('undoing a succeeded pull on a project with no connected repository refuses with RepositoryNotConnectedError', async () => {
    const harness = await buildHarness({ connected: false });
    await seedSucceededPull(harness);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
    expect(harness.commandRunner.restoreToSnapshotCalls).toHaveLength(0);
  });

  test('a failed snapshot read is surfaced rather than reported as nothing to undo', async () => {
    const harness = await buildHarness({ conflictStageStore: new UnreadableSnapshotStageStore() });
    await seedSucceededPull(harness);

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(GitCommandFailedError);
      expect(result.error).not.toBeInstanceOf(NothingToUndoError);
    }
    expect(harness.commandRunner.restoreToSnapshotCalls).toHaveLength(0);
  });

  test('a failed restore of a succeeded pull propagates and reverts nothing', async () => {
    const harness = await buildHarness();
    await seedSucceededPull(harness);
    harness.commandRunner.seedRestoreToSnapshotFailure(PROJECT_ID, new GitCommandFailedError('reset failed'));

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
    expect(await harness.auditRepo.findByProjectId(PROJECT_ID)).toHaveLength(0);
  });

  test('a failed behind/ahead recompute keeps the repository row on its prior sync status', async () => {
    const harness = await buildHarness({ syncStatus: 'BEHIND' });
    await seedSucceededPull(harness);
    harness.commandRunner.seedRestoreToSnapshot(PROJECT_ID, { headCommit: PRE_OP_HEAD, branch: CURRENT_BRANCH, changes: REVERT_CHANGES });
    harness.commandRunner.seedBehindAheadFailure(PROJECT_ID, new GitCommandFailedError('rev-list failed'));

    const result = await harness.useCase.execute(undoInput());

    expect(result.success).toBe(true);
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('BEHIND');
  });
});
