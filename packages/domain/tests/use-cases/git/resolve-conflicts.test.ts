import { ResolveConflictsUseCase } from '../../../src/use-cases/git/resolve-conflicts';
import { InsufficientRoleError } from '../../../src/errors/git/insufficient-role';
import { NoConflictInProgressError } from '../../../src/errors/git/no-conflict-in-progress';
import { GitConflictNotFoundError } from '../../../src/errors/git/git-conflict-not-found';
import { InvalidResolutionError } from '../../../src/errors/git/invalid-resolution';
import { ProjectMember } from '../../../src/entities/project-member';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { GitOperationId } from '../../../src/value-objects/ids/git-operation-id';
import { Role } from '../../../src/value-objects/identity/role';
import { AUDIT_AUTHZ_DENIED } from '../../../src/audit-actions';
import { AUDIT_GIT_CONFLICT_RESOLVED } from '../../../src/audit-actions';
import { InMemoryProjectMemberRepository } from '../../ports/project/in-memory-project-member.repository';
import { InMemoryAuditLogRepository } from '../../ports/admin/in-memory-audit-log.repository';
import { InMemoryGitOperationRepository } from '../../ports/git/in-memory-git-operation-repository';
import { InMemoryConflictStageStore } from '../../ports/git/in-memory-conflict-stage-store';
import { GitCommandFailedError } from '../../../src/errors/git/git-command-failed';
import type { GitConflict } from '../../../src/entities/git-conflict';
import type { Result } from '../../../src/types/result';

/** Stage store whose merged-bytes write always fails, standing in for an unwritable blob store. */
class UnwritableConflictStageStore extends InMemoryConflictStageStore {
  async writeMerged(): Promise<Result<void, GitCommandFailedError>> {
    return { success: false, error: new GitCommandFailedError('the merged content could not be stored') };
  }
}

/** Operation repository that refuses to record a resolution, as a concurrent clear would. */
class UnrecordableGitOperationRepository extends InMemoryGitOperationRepository {
  async resolveConflict(
    _operationId: GitOperationId,
    path: string,
  ): Promise<Result<GitConflict, GitConflictNotFoundError>> {
    return { success: false, error: new GitConflictNotFoundError(path) };
  }
}

const PROJECT_ID = ProjectId.create('550e8400-e29b-41d4-a716-446655440000');
const ACTOR_ID = UserId.create('550e8400-e29b-41d4-a716-446655440001');
const CONFLICT_PATH = 'chapters/intro.adoc';
const BINARY_PATH = 'assets/logo.png';

interface Harness {
  useCase: ResolveConflictsUseCase;
  gitOperationRepo: InMemoryGitOperationRepository;
  conflictStageStore: InMemoryConflictStageStore;
  auditRepo: InMemoryAuditLogRepository;
  operationId: GitOperationId;
}

interface HarnessOptions {
  role?: string | null;
  /** When false, no operation is enqueued/transitioned at all. */
  awaitingConflict?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { role = 'editor', awaitingConflict = true } = options;

  const memberRepo = new InMemoryProjectMemberRepository();
  if (role) {
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create(role)));
  }
  const auditRepo = new InMemoryAuditLogRepository();
  const gitOperationRepo = new InMemoryGitOperationRepository();
  const conflictStageStore = new InMemoryConflictStageStore();

  let operationId = GitOperationId.create('550e8400-e29b-41d4-a716-446655440099');
  if (awaitingConflict) {
    const enqueued = await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'PULL', triggeredByUserId: ACTOR_ID });
    operationId = enqueued.id;
    const claimed = await gitOperationRepo.claimNextQueued(30_000);
    await gitOperationRepo.transition(claimed!.id, 'AWAITING_CONFLICT');
    await gitOperationRepo.createConflict({ operationId, path: CONFLICT_PATH, isBinary: false });
    await gitOperationRepo.createConflict({ operationId, path: BINARY_PATH, isBinary: true });
  }

  const useCase = new ResolveConflictsUseCase(memberRepo, auditRepo, gitOperationRepo, conflictStageStore);

  return { useCase, gitOperationRepo, conflictStageStore, auditRepo, operationId };
}

describe('ResolveConflictsUseCase', () => {
  test('an "ours" resolution persists via resolveConflict without touching the stage store', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    expect(result).toEqual({ success: true, value: { resolved: true } });
    const conflicts = await harness.gitOperationRepo.listConflicts(harness.operationId);
    const conflict = conflicts.find((c) => c.path === CONFLICT_PATH);
    expect(conflict?.resolved).toBe(true);
    expect(conflict?.resolution).toBe('ours');
    expect(harness.conflictStageStore.recordedMerged).toHaveLength(0);
  });

  test('a "theirs" resolution persists via resolveConflict, ignoring any mergedContent', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'theirs',
      mergedContent: 'should be ignored',
    });

    expect(result.success).toBe(true);
    const conflicts = await harness.gitOperationRepo.listConflicts(harness.operationId);
    expect(conflicts.find((c) => c.path === CONFLICT_PATH)?.resolution).toBe('theirs');
    expect(harness.conflictStageStore.recordedMerged).toHaveLength(0);
  });

  test('a "merged" resolution writes the bytes to the stage store and persists via resolveConflict', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'merged',
      mergedContent: 'merged text',
    });

    expect(result).toEqual({ success: true, value: { resolved: true } });
    expect(harness.conflictStageStore.recordedMerged).toEqual([
      { operationId: harness.operationId, path: CONFLICT_PATH, content: Buffer.from('merged text', 'utf8') },
    ]);
    const conflicts = await harness.gitOperationRepo.listConflicts(harness.operationId);
    expect(conflicts.find((c) => c.path === CONFLICT_PATH)?.resolution).toBe('merged');
  });

  test('a "merged" resolution on a binary conflict refuses with InvalidResolutionError and writes nothing', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: BINARY_PATH,
      resolution: 'merged',
      mergedContent: 'irrelevant',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InvalidResolutionError);
    expect(harness.conflictStageStore.recordedMerged).toHaveLength(0);
    const conflicts = await harness.gitOperationRepo.listConflicts(harness.operationId);
    expect(conflicts.find((c) => c.path === BINARY_PATH)?.resolved).toBe(false);
  });

  test('a "merged" resolution without mergedContent refuses with InvalidResolutionError', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'merged',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InvalidResolutionError);
    expect(harness.conflictStageStore.recordedMerged).toHaveLength(0);
  });

  test('a non-editor is denied with InsufficientRoleError, the denial is audited, and resolveConflict is never reached', async () => {
    const harness = await buildHarness({ role: 'viewer' });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(InsufficientRoleError);
    const conflicts = await harness.gitOperationRepo.listConflicts(harness.operationId);
    expect(conflicts.find((c) => c.path === CONFLICT_PATH)?.resolved).toBe(false);
    const audited = await harness.auditRepo.findAll();
    expect(audited.some((entry) => entry.action === AUDIT_AUTHZ_DENIED)).toBe(true);
  });

  test('a successful resolution is audited', async () => {
    const harness = await buildHarness();

    await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    const audited = await harness.auditRepo.findAll();
    expect(audited.some((entry) => entry.action === AUDIT_GIT_CONFLICT_RESOLVED)).toBe(true);
  });

  test('no active operation at all refuses with NoConflictInProgressError', async () => {
    const harness = await buildHarness({ awaitingConflict: false });

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NoConflictInProgressError);
  });

  test('an active operation in the wrong state (not AWAITING_CONFLICT) refuses with NoConflictInProgressError', async () => {
    const memberRepo = new InMemoryProjectMemberRepository();
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create('editor')));
    const auditRepo = new InMemoryAuditLogRepository();
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const conflictStageStore = new InMemoryConflictStageStore();
    // RUNNING, not AWAITING_CONFLICT.
    await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'PULL', triggeredByUserId: ACTOR_ID });
    await gitOperationRepo.claimNextQueued(30_000);
    const useCase = new ResolveConflictsUseCase(memberRepo, auditRepo, gitOperationRepo, conflictStageStore);

    const result = await useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(NoConflictInProgressError);
  });

  test('an unknown path refuses with GitConflictNotFoundError', async () => {
    const harness = await buildHarness();

    const result = await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: 'no/such/file.adoc',
      resolution: 'ours',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitConflictNotFoundError);
  });

  test('does not transition the operation — it stays AWAITING_CONFLICT after a resolution', async () => {
    const harness = await buildHarness();

    await harness.useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    const operation = await harness.gitOperationRepo.findById(harness.operationId);
    expect(operation?.state).toBe('AWAITING_CONFLICT');
  });

  test('a stage-store write failure refuses without recording the resolution', async () => {
    const memberRepo = new InMemoryProjectMemberRepository();
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create('editor')));
    const auditRepo = new InMemoryAuditLogRepository();
    const gitOperationRepo = new InMemoryGitOperationRepository();
    const enqueued = await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'PULL', triggeredByUserId: ACTOR_ID });
    await gitOperationRepo.claimNextQueued(30_000);
    await gitOperationRepo.transition(enqueued.id, 'AWAITING_CONFLICT');
    await gitOperationRepo.createConflict({ operationId: enqueued.id, path: CONFLICT_PATH, isBinary: false });
    const useCase = new ResolveConflictsUseCase(
      memberRepo,
      auditRepo,
      gitOperationRepo,
      new UnwritableConflictStageStore(),
    );

    const result = await useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'merged',
      mergedContent: 'merged text',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitCommandFailedError);
    const conflicts = await gitOperationRepo.listConflicts(enqueued.id);
    expect(conflicts.find((c) => c.path === CONFLICT_PATH)?.resolved).toBe(false);
    expect(await auditRepo.findByProjectId(PROJECT_ID)).toHaveLength(0);
  });

  test('a failure recording the resolution is surfaced and nothing is audited', async () => {
    const memberRepo = new InMemoryProjectMemberRepository();
    await memberRepo.addMember(new ProjectMember(PROJECT_ID, ACTOR_ID, Role.create('editor')));
    const auditRepo = new InMemoryAuditLogRepository();
    const gitOperationRepo = new UnrecordableGitOperationRepository();
    const enqueued = await gitOperationRepo.enqueue({ projectId: PROJECT_ID, kind: 'PULL', triggeredByUserId: ACTOR_ID });
    await gitOperationRepo.claimNextQueued(30_000);
    await gitOperationRepo.transition(enqueued.id, 'AWAITING_CONFLICT');
    await gitOperationRepo.createConflict({ operationId: enqueued.id, path: CONFLICT_PATH, isBinary: false });
    const useCase = new ResolveConflictsUseCase(
      memberRepo,
      auditRepo,
      gitOperationRepo,
      new InMemoryConflictStageStore(),
    );

    const result = await useCase.execute({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      path: CONFLICT_PATH,
      resolution: 'ours',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(GitConflictNotFoundError);
    expect(await auditRepo.findByProjectId(PROJECT_ID)).toHaveLength(0);
  });
});
