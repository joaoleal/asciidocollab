import { CompleteMergeUseCase } from '../../../src/use-cases/git/complete-merge';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { NoConflictInProgressError } from '../../../src/errors/git/no-conflict-in-progress';
import { UnresolvedConflictsError } from '../../../src/errors/git/unresolved-conflicts';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import { RepositoryNotConnectedError } from '../../../src/errors/git/repository-not-connected';
import { ProjectMember } from '../../../src/entities/project-member';
import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { GitProvider } from '../../../src/value-objects/project/git-provider';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { Role } from '../../../src/value-objects/identity/role';
import { AUDIT_AUTHZ_DENIED, AUDIT_GIT_CONFLICTS_RESOLVED } from '../../../src/audit-actions';
import { buildGitDriftSummary } from '../../../src/types/git-drift-summary';
import type { GitMergeFileChange, GitResolveMergeOutcome } from '../../../src/ports/git/git-command-runner';
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
const CONFLICT_PATH = 'chapters/intro.adoc';
const OTHER_PATH = 'chapters/outro.adoc';
const RESOLVED_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const RESOLVED_CHANGES: readonly GitMergeFileChange[] = [
  { type: 'modified', path: CONFLICT_PATH, content: Buffer.from('resolved text'), mimeType: 'text/asciidoc' },
];
const RESOLVED_OUTCOME: GitResolveMergeOutcome = {
  status: 'resolved',
  headCommit: RESOLVED_HEAD,
  changes: RESOLVED_CHANGES,
};

function makeReconciler(): FileChangeReconciler & { apply: jest.Mock } {
  return {
    apply: jest.fn().mockResolvedValue({ success: true, value: { changedPaths: [CONFLICT_PATH], anomalies: [] } }),
  };
}

interface Harness {
  useCase: CompleteMergeUseCase;
  gitOperationRepo: InMemoryGitOperationRepository;
  gitRepositoryRepo: InMemoryGitRepositoryRepository;
  commandRunner: InMemoryGitCommandRunner;
  conflictStageStore: InMemoryConflictStageStore;
  auditRepo: InMemoryAuditLogRepository;
  reconciler: FileChangeReconciler & { apply: jest.Mock };
  operationId: GitOperationId;
}

interface HarnessOptions {
  role?: string | null;
  connected?: boolean;
  kind?: 'PULL' | 'BRANCH_SWITCH';
  /** When false, no operation is enqueued/transitioned at all. */
  awaitingConflict?: boolean;
  /** When false, the second conflict is left unresolved. */
  allResolved?: boolean;
  /** The remote head preserved on the CONFLICTED row; null when none was recorded at detection. */
  remoteHead?: string | null;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const {
    role = 'editor',
    connected = true,
    kind = 'PULL',
    awaitingConflict = true,
    allResolved = true,
    remoteHead = 'previous-head-commit-hash',
  } = options;

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
        'CONFLICTED',
        'main',
        remoteHead,
        new Date('2024-01-01T00:00:00.000Z'),
        new Date('2024-01-01T00:00:00.000Z'),
        ACTOR_ID,
      ),
    );
  }

  let operationId = GitOperationId.create('550e8400-e29b-41d4-a716-446655440099');
  if (awaitingConflict) {
    const enqueued = await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind, triggeredByUserId: ACTOR_ID });
    operationId = enqueued.id;
    await gitOperationRepo.claimNextQueued(30_000);
    await gitOperationRepo.transition(operationId, 'AWAITING_CONFLICT');
    await gitOperationRepo.createConflict({ operationId, path: CONFLICT_PATH, isBinary: false });
    await gitOperationRepo.createConflict({ operationId, path: OTHER_PATH, isBinary: false });
    await gitOperationRepo.resolveConflict(operationId, CONFLICT_PATH, 'ours');
    if (allResolved) {
      await gitOperationRepo.resolveConflict(operationId, OTHER_PATH, 'theirs');
    }

    // Stages backing a BRANCH_SWITCH completion's stage-store reads.
    await conflictStageStore.writeStages(operationId, CONFLICT_PATH, {
      base: Buffer.from('base'),
      ours: Buffer.from('ours text'),
      theirs: Buffer.from('theirs text'),
      isBinary: false,
    });
    await conflictStageStore.writeStages(operationId, OTHER_PATH, {
      base: Buffer.from('base'),
      ours: Buffer.from('ours other'),
      theirs: Buffer.from('theirs other'),
      isBinary: false,
    });
  }

  const useCase = new CompleteMergeUseCase(
    memberRepo,
    auditRepo,
    gitRepositoryRepo,
    gitOperationRepo,
    commandRunner,
    conflictStageStore,
    reconciler,
  );

  return {
    useCase,
    gitOperationRepo,
    gitRepositoryRepo,
    commandRunner,
    conflictStageStore,
    auditRepo,
    reconciler,
    operationId,
  };
}

function completeInput() {
  return { actorId: ACTOR_ID, projectId: PROJECT_ID };
}

describe('CompleteMergeUseCase', () => {
  test('a fully-resolved PULL re-runs the merge with every resolution, reconciles, and succeeds', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedResolveMerge(PROJECT_ID, RESOLVED_OUTCOME);

    const result = await harness.useCase.execute(completeInput());

    expect(result).toEqual({
      success: true,
      value: { status: 'resolved', operationId: harness.operationId, headCommit: RESOLVED_HEAD },
    });

    expect(harness.commandRunner.resolveMergeCalls).toHaveLength(1);
    const call = harness.commandRunner.resolveMergeCalls[0];
    expect(call.input.branch).toBe(CURRENT_BRANCH);
    expect(call.input.operationId).toBe(harness.operationId);
    const sortedResolutions = call.input.resolutions.toSorted((a, b) => a.path.localeCompare(b.path));
    expect(sortedResolutions).toEqual([
      { path: CONFLICT_PATH, resolution: 'ours' },
      { path: OTHER_PATH, resolution: 'theirs' },
    ]);

    expect(harness.reconciler.apply).toHaveBeenCalledWith(PROJECT_ID, RESOLVED_CHANGES);

    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('SUCCEEDED');
    expect(await harness.gitOperationRepo.listConflicts(harness.operationId)).toHaveLength(0);
    expect(harness.conflictStageStore.clearedOperationIds).toContainEqual(harness.operationId);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    // The resolving merge commit is a local commit the remote lacks, so the branch is AHEAD — not
    // UP_TO_DATE — and the observed remote head stays the one fetched when the conflict was detected
    // (preserved on the CONFLICTED row), never the local resolving commit.
    expect(saved?.syncStatus).toBe('AHEAD');
    expect(saved?.lastKnownRemoteHead).toBe('previous-head-commit-hash');

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    expect(audits.some((entry) => entry.action === AUDIT_GIT_CONFLICTS_RESOLVED)).toBe(true);
  });

  test('a PULL completed with no recorded remote head leaves lastKnownRemoteHead null, never the local resolving commit', async () => {
    const harness = await buildHarness({ remoteHead: null });
    harness.commandRunner.seedResolveMerge(PROJECT_ID, RESOLVED_OUTCOME);

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(true);

    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    // The local resolving commit is one the remote lacks, so it must never be written as the
    // observed remote head. With none recorded at detection, the field stays null (not RESOLVED_HEAD).
    expect(saved?.lastKnownRemoteHead).toBeNull();
    expect(saved?.lastKnownRemoteHead).not.toBe(RESOLVED_HEAD);
    expect(saved?.syncStatus).toBe('AHEAD');
  });

  test('folds reconciler drift into the completion audit metadata', async () => {
    const harness = await buildHarness();
    const anomalies = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' },
    ];
    harness.reconciler.apply.mockResolvedValue({ success: true, value: { changedPaths: [CONFLICT_PATH], anomalies } });

    await harness.useCase.execute(completeInput());

    const audits = await harness.auditRepo.findByProjectId(PROJECT_ID);
    const entry = audits.find((audit) => audit.action === AUDIT_GIT_CONFLICTS_RESOLVED);
    expect(entry).toBeDefined();
    expect(entry!.metadata).toMatchObject({ kind: 'PULL', total: 1, droppedCount: 1 });
  });

  test('persists a drift summary on the SUCCEEDED row when a resolved landing dropped content, matching buildGitDriftSummary', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedResolveMerge(PROJECT_ID, RESOLVED_OUTCOME);
    const anomalies = [
      { path: 'docs', kind: 'content_dropped_folder_occupies_path', applied: false, message: 'dropped' },
    ];
    harness.reconciler.apply.mockResolvedValue({ success: true, value: { changedPaths: [CONFLICT_PATH], anomalies } });

    const result = await harness.useCase.execute(completeInput());
    expect(result.success).toBe(true);

    // The conflict-resolution success path must persist the SAME summary a clean pull records, so the
    // polling client warns the user that a pulled change was dropped.
    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('SUCCEEDED');
    expect(operation?.driftSummary).toEqual(buildGitDriftSummary(anomalies));
    expect(operation?.driftSummary?.total).toBe(1);
    expect(operation?.driftSummary?.droppedCount).toBe(1);
  });

  test('leaves the SUCCEEDED row drift summary null when the resolved landing was clean', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedResolveMerge(PROJECT_ID, RESOLVED_OUTCOME);
    // The default reconciler returns no anomalies — a clean landing, consistent with the clean pull path.

    const result = await harness.useCase.execute(completeInput());
    expect(result.success).toBe(true);

    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('SUCCEEDED');
    expect(operation?.driftSummary).toBeNull();
  });

  test('any unresolved conflict refuses with UnresolvedConflictsError and changes nothing', async () => {
    const harness = await buildHarness({ allResolved: false });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(UnresolvedConflictsError);

    expect(harness.commandRunner.resolveMergeCalls).toHaveLength(0);
    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
    expect(await harness.gitOperationRepo.listConflicts(harness.operationId)).toHaveLength(2);
  });

  test('a stillConflicted re-merge reverts to AWAITING_CONFLICT and lands nothing', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedResolveMerge(PROJECT_ID, {
      status: 'stillConflicted',
      conflicts: [{ path: CONFLICT_PATH, isBinary: false }],
    });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);

    expect(harness.reconciler.apply).not.toHaveBeenCalled();
    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
    // Nothing is cleared on a failed completion.
    expect(await harness.gitOperationRepo.listConflicts(harness.operationId)).toHaveLength(2);
  });

  test('a resolveMerge command failure reverts to AWAITING_CONFLICT and lands nothing', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedResolveMergeFailure(PROJECT_ID, new GitCommandFailedError('merge failed'));

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    expect(harness.reconciler.apply).not.toHaveBeenCalled();
    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
  });

  test('a reconciler failure reverts to AWAITING_CONFLICT and the repository row is not refreshed', async () => {
    const harness = await buildHarness();
    harness.commandRunner.seedResolveMerge(PROJECT_ID, RESOLVED_OUTCOME);
    harness.reconciler.apply.mockResolvedValue({
      success: false,
      error: new GitCommandFailedError('could not land changes'),
    });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
    const saved = await harness.gitRepositoryRepo.findByProjectId(PROJECT_ID);
    expect(saved?.syncStatus).toBe('CONFLICTED');
  });

  test('a BRANCH_SWITCH-kind operation builds changes from the stage store and reconciles without a resolving commit', async () => {
    const harness = await buildHarness({ kind: 'BRANCH_SWITCH' });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headCommit).toBe('');

    // No merge is re-run for a switch completion.
    expect(harness.commandRunner.resolveMergeCalls).toHaveLength(0);

    expect(harness.reconciler.apply).toHaveBeenCalledTimes(1);
    const [, changes] = harness.reconciler.apply.mock.calls[0] as [ProjectId, GitMergeFileChange[]];
    const byPath = new Map(
      changes.map((change) => [change.type === 'renamed' ? change.toPath : change.path, change]),
    );
    expect(byPath.get(CONFLICT_PATH)).toEqual({
      type: 'modified',
      path: CONFLICT_PATH,
      content: Buffer.from('ours text'),
      mimeType: 'text/plain',
    });
    expect(byPath.get(OTHER_PATH)).toEqual({
      type: 'modified',
      path: OTHER_PATH,
      content: Buffer.from('theirs other'),
      mimeType: 'text/plain',
    });

    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('SUCCEEDED');
  });

  test('a project with no connected repository refuses with RepositoryNotConnectedError', async () => {
    const harness = await buildHarness({ connected: false });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(RepositoryNotConnectedError);
  });

  test('no active operation at all refuses with NoConflictInProgressError', async () => {
    const harness = await buildHarness({ awaitingConflict: false });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NoConflictInProgressError);
  });

  test('a non-editor is denied with InsufficientRoleError, the denial is audited, and nothing is touched', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute(completeInput());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    expect(harness.commandRunner.resolveMergeCalls).toHaveLength(0);
    const audited = await harness.auditRepo.findAll();
    expect(audited.some((entry) => entry.action === AUDIT_AUTHZ_DENIED)).toBe(true);
    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
  });
});
