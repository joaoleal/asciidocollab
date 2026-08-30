import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GitOperationId,
  GitProvider,
  GitRepository,
  GitRepositoryId,
  ProjectId,
  UserId,
  type GitOperationKind,
} from '@asciidocollab/domain';
import type { ConflictStageStore, ConflictStages, ConflictUndoSnapshot, Result } from '@asciidocollab/domain';
import { GitCommandFailedError } from '@asciidocollab/domain';
import { FilesystemConflictStageStore } from '../src/git/filesystem-conflict-stage-store.js';
import { createUndoReferenceSweeper } from '../src/undo-reference-sweeper.js';
import { createTemporaryStorageRootWithProject } from './helpers/temporary-git-repo.js';
import { InMemoryGitOperationRepository } from './helpers/in-memory-git-operation-repository.js';

const execFile = promisify(execFileCallback);

const USER = UserId.create('550e8400-e29b-41d4-a716-446655440501');

/** A structured-logging sink that swallows lines — the sweep logs best-effort diagnostics only. */
const silentLogger = { warn(): void {}, error(): void {} };

/** The backup ref namespace each op pins its moved work under. */
function backupReference(operationId: GitOperationId): string {
  return `refs/adc/undo/${operationId.value}`;
}

/** Creates a `FilesystemConflictStageStore` rooted OUTSIDE any working tree (the store's invariant). */
async function createTemporaryConflictStageStore(): Promise<FilesystemConflictStageStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-worker-test-conflict-store-'));
  return new FilesystemConflictStageStore(root);
}

/** A connected-repository entity for `projectId`, on `main`. */
function makeRepository(projectId: ProjectId): GitRepository {
  return new GitRepository(
    GitRepositoryId.create('550e8400-e29b-41d4-a716-446655440599'),
    projectId,
    GitProvider.create('github'),
    'https://github.com/example/repo.git',
    'cred-1',
    'main',
    'UP_TO_DATE',
    'main',
    null,
    null,
    new Date(),
    USER,
  );
}

/**
 * Waits past a millisecond boundary so two `new Date()` reads taken around it are guaranteed to
 * differ — `InMemoryGitOperationRepository` timestamps each seeded operation with the wall clock, so
 * two ops seeded back-to-back can otherwise land in the same millisecond and tie on `createdAt`; the
 * newest-first tiebreak then falls to `id` (see `byNewestFirst`), which is unrelated to seed order.
 */
async function waitPastAMillisecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Reads a ref's tip, or null when it does not exist. */
async function readReferenceOrNull(cwd: string, reference: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', '--quiet', reference], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Enqueues a terminal (SUCCEEDED) content operation and returns its id — the on-disk backup ref is
 * keyed by exactly this id. Drives the in-memory repo through the same QUEUED→RUNNING→SUCCEEDED path
 * a real op takes, so `findMostRecentByKinds`/`findActiveOperation` behave as in production.
 */
async function seedSucceededOperation(
  operationRepository: InMemoryGitOperationRepository,
  projectId: ProjectId,
  kind: GitOperationKind,
): Promise<GitOperationId> {
  const enqueued = await operationRepository.enqueue({ projectId, kind, triggeredByUserId: USER });
  await operationRepository.claimNextQueued(60_000);
  const transitioned = await operationRepository.transition(enqueued.id, 'SUCCEEDED');
  if (!transitioned.success) throw new Error('failed to seed a SUCCEEDED operation');
  return enqueued.id;
}

/**
 * Enqueues a terminal (FAILED) content operation and returns its id — a content op that failed
 * before recording an undo snapshot. Terminal, so it never registers as the project's active op and
 * never makes the sweep skip; it simply has no snapshot for the keep-scan to find.
 */
async function seedFailedOperation(
  operationRepository: InMemoryGitOperationRepository,
  projectId: ProjectId,
  kind: GitOperationKind,
): Promise<GitOperationId> {
  const enqueued = await operationRepository.enqueue({ projectId, kind, triggeredByUserId: USER });
  await operationRepository.claimNextQueued(60_000);
  const transitioned = await operationRepository.transition(enqueued.id, 'FAILED', { errorCode: 'boom' });
  if (!transitioned.success) throw new Error('failed to seed a FAILED operation');
  return enqueued.id;
}

/**
 * Enqueues a RUNNING content operation (QUEUED → RUNNING, no terminal transition) and returns its id
 * — a genuinely active op, exactly what the never-lose-work guard must refuse to sweep even when it
 * is not the elected keep.
 */
async function seedRunningOperation(
  operationRepository: InMemoryGitOperationRepository,
  projectId: ProjectId,
  kind: GitOperationKind,
): Promise<GitOperationId> {
  const enqueued = await operationRepository.enqueue({ projectId, kind, triggeredByUserId: USER });
  await operationRepository.claimNextQueued(60_000);
  return enqueued.id;
}

/**
 * An operation repository whose `findActiveOperation` always reports "no active op" while every other
 * read still tells the truth. This reproduces the sweep's TOCTOU window precisely: a pull/switch that
 * starts AFTER the sweep's one-shot active-op check — but before its delete loop — is invisible to
 * that early check (so the sweep does not skip), yet a per-ref `findById` correctly sees it as still
 * active. Without hiding it here, the same op would make the real `findActiveOperation` short-circuit
 * the sweep, so the per-ref terminal guard could never be exercised.
 */
class SweepSeesNoActiveOperation extends InMemoryGitOperationRepository {
  override async findActiveOperation(): Promise<null> {
    return null;
  }
}

/**
 * A `ConflictStageStore` wrapper that delegates everything to a real store EXCEPT `readSnapshot` for
 * one specific operation id, which it fails unconditionally — simulating a half-written/corrupt
 * snapshot a crash left behind (the very scenario the sweeper's read-failure abort exists for), while
 * every other operation's snapshot still reads back normally.
 */
class ReadSnapshotFailsForOneOperation implements ConflictStageStore {
  constructor(
    private readonly delegate: ConflictStageStore,
    private readonly failingOperationId: GitOperationId,
  ) {}

  async writeSnapshot(operationId: GitOperationId, snapshot: ConflictUndoSnapshot): ReturnType<ConflictStageStore['writeSnapshot']> {
    return this.delegate.writeSnapshot(operationId, snapshot);
  }

  async writeStages(operationId: GitOperationId, path: string, stages: ConflictStages): ReturnType<ConflictStageStore['writeStages']> {
    return this.delegate.writeStages(operationId, path, stages);
  }

  async writeMerged(operationId: GitOperationId, path: string, content: Buffer): ReturnType<ConflictStageStore['writeMerged']> {
    return this.delegate.writeMerged(operationId, path, content);
  }

  async readStages(operationId: GitOperationId, path: string): ReturnType<ConflictStageStore['readStages']> {
    return this.delegate.readStages(operationId, path);
  }

  async readMerged(operationId: GitOperationId, path: string): ReturnType<ConflictStageStore['readMerged']> {
    return this.delegate.readMerged(operationId, path);
  }

  async readSnapshot(operationId: GitOperationId): Promise<Result<ConflictUndoSnapshot | null, GitCommandFailedError>> {
    if (operationId.value === this.failingOperationId.value) {
      return { success: false, error: new GitCommandFailedError('The conflict stage store is unavailable.') };
    }
    return this.delegate.readSnapshot(operationId);
  }

  async clear(operationId: GitOperationId): ReturnType<ConflictStageStore['clear']> {
    return this.delegate.clear(operationId);
  }
}

describe('undo-ref sweeper', () => {
  it('removes the stale terminal op’s undo ref and snapshot, keeping the current op’s', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440510');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    const operationRepository = new InMemoryGitOperationRepository();
    const store = await createTemporaryConflictStageStore();

    // An older PULL, then a newer PULL — the newer is the one retained undo point to keep. A real gap
    // between the two, not just seed order, so the newer one wins on `createdAt` unambiguously rather
    // than on the `id` tiebreak (which is unrelated to which was seeded first).
    const staleOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    await waitPastAMillisecond();
    const currentOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');

    // Both left a backup ref and a snapshot on disk (the stale one a straggler a crash never pruned).
    for (const operationId of [staleOperationId, currentOperationId]) {
      await execFile('git', ['update-ref', backupReference(operationId), head], { cwd });
      await store.writeSnapshot(operationId, { preOpHead: head, branch: 'main' });
    }

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // The stale op's ref and snapshot are gone...
    expect(await readReferenceOrNull(cwd, backupReference(staleOperationId))).toBeNull();
    expect(await store.readSnapshot(staleOperationId)).toEqual({ success: true, value: null });

    // ...and the current op's undo point is kept.
    expect(await readReferenceOrNull(cwd, backupReference(currentOperationId))).toBe(head);
    const kept = await store.readSnapshot(currentOperationId);
    expect(kept.success).toBe(true);
    if (!kept.success || kept.value === null) throw new Error('expected the current op’s snapshot to be kept');
  });

  it('keeps a still-valid older undo point when a newer content op failed before writing a snapshot', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440512');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    const operationRepository = new InMemoryGitOperationRepository();
    const store = await createTemporaryConflictStageStore();

    // Older op A landed a real undo point (ref + snapshot); a NEWER op B then failed before recording
    // one. The keep-scan must skip snapshot-less B and settle on A, so A's undo point survives.
    const olderOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    await execFile('git', ['update-ref', backupReference(olderOperationId), head], { cwd });
    await store.writeSnapshot(olderOperationId, { preOpHead: head, branch: 'main' });
    await seedFailedOperation(operationRepository, projectId, 'PULL');

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // A is the project's real retained undo point — it must be kept, never deleted because the newer
    // op happened to have no snapshot (the delete-all regression this guards against).
    expect(await readReferenceOrNull(cwd, backupReference(olderOperationId))).toBe(head);
    const kept = await store.readSnapshot(olderOperationId);
    expect(kept.success).toBe(true);
    if (!kept.success || kept.value === null) throw new Error('expected the older op’s snapshot to be kept');
  });

  it('keeps a SUCCEEDED undo point when a NEWER failed op left an orphaned snapshot (elects the succeeded op, not the failed one)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440515');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    const operationRepository = new InMemoryGitOperationRepository();
    const store = await createTemporaryConflictStageStore();

    // A SUCCEEDED pull with a real undo point (ref + snapshot), then a NEWER op that FAILED but still
    // left an ORPHANED snapshot behind (a content op writes its snapshot before its fallible
    // merge/checkout, so a crash/failure between the two leaks one). The keep-scan must require
    // SUCCEEDED and elect the pull — never the newer failed op whose snapshot alone is no undo point.
    const succeededOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    await execFile('git', ['update-ref', backupReference(succeededOperationId), head], { cwd });
    await store.writeSnapshot(succeededOperationId, { preOpHead: head, branch: 'main' });
    await waitPastAMillisecond(); // a real createdAt gap, so the failed op is unambiguously the newer one
    const failedOperationId = await seedFailedOperation(operationRepository, projectId, 'PULL');
    await store.writeSnapshot(failedOperationId, { preOpHead: head, branch: 'main' });

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // The SUCCEEDED pull's ref is KEPT: the newer failed op's orphaned snapshot never elected it as
    // `keep`, so the genuine undo point's ref was not swept out from under it.
    expect(await readReferenceOrNull(cwd, backupReference(succeededOperationId))).toBe(head);
    const kept = await store.readSnapshot(succeededOperationId);
    expect(kept.success).toBe(true);
    if (!kept.success || kept.value === null) throw new Error('expected the succeeded op’s snapshot to be kept');
  });

  it('deletes nothing when no recent content op has a retained snapshot (never delete-all)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440513');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    const operationRepository = new InMemoryGitOperationRepository();
    const store = await createTemporaryConflictStageStore();

    // A straggler backup ref exists on disk, but its op recorded no snapshot and no other content op
    // has one either — there is no confirmed undo point to prune down to.
    const orphanOperationId = await seedFailedOperation(operationRepository, projectId, 'PULL');
    await execFile('git', ['update-ref', backupReference(orphanOperationId), head], { cwd });

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // Conservative: with no confirmed undo point, the sweep leaves the ref in place rather than
    // deleting every backup ref present.
    expect(await readReferenceOrNull(cwd, backupReference(orphanOperationId))).toBe(head);
  });

  it('never deletes a backup ref whose op is still active (QUEUED/RUNNING), even though it is not the keep', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440516');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    // The sweep's active-op check is hidden (see the class doc): it models a pull that started AFTER
    // the check but before the delete loop — the exact TOCTOU the per-ref terminal guard closes.
    const operationRepository = new SweepSeesNoActiveOperation();
    const store = await createTemporaryConflictStageStore();

    // A SUCCEEDED pull is the elected keep. A NEWER pull is still RUNNING and has just pinned its own
    // never-lose-work ref — it is NOT the keep (`keep` was elected before it existed), so the pre-fix
    // loop would have deleted its just-pinned ref.
    const keepOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    await store.writeSnapshot(keepOperationId, { preOpHead: head, branch: 'main' });
    await execFile('git', ['update-ref', backupReference(keepOperationId), head], { cwd });
    await waitPastAMillisecond();
    const runningOperationId = await seedRunningOperation(operationRepository, projectId, 'PULL');
    await execFile('git', ['update-ref', backupReference(runningOperationId), head], { cwd });

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // The RUNNING op's just-pinned ref survives — the guard refused to reclaim a non-terminal op's
    // undo artifact — and the keep op's ref is untouched as always.
    expect(await readReferenceOrNull(cwd, backupReference(runningOperationId))).toBe(head);
    expect(await readReferenceOrNull(cwd, backupReference(keepOperationId))).toBe(head);
  });

  it('skips a repository with an active operation, touching no ref (never races an in-flight op)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440511');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    const operationRepository = new InMemoryGitOperationRepository();
    const store = await createTemporaryConflictStageStore();

    const staleOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    await execFile('git', ['update-ref', backupReference(staleOperationId), head], { cwd });
    await store.writeSnapshot(staleOperationId, { preOpHead: head, branch: 'main' });

    // An in-flight PULL now owns the project's single-flight slot.
    await operationRepository.enqueue({ projectId, kind: 'PULL', triggeredByUserId: USER });

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // Nothing was swept: the ref and snapshot are both untouched while an op is active.
    expect(await readReferenceOrNull(cwd, backupReference(staleOperationId))).toBe(head);
    const staleSnapshot = await store.readSnapshot(staleOperationId);
    expect(staleSnapshot.success).toBe(true);
  });

  it('deletes nothing when the newest undo op’s snapshot read FAILS (never mistake a read failure for absence)', async () => {
    const projectId = ProjectId.create('550e8400-e29b-41d4-a716-446655440514');
    const storageRoot = await createTemporaryStorageRootWithProject(projectId.value);
    const cwd = path.join(storageRoot, projectId.value);
    await execFile('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
    const headResult = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const head = headResult.stdout.trim();

    const operationRepository = new InMemoryGitOperationRepository();
    const realStore = await createTemporaryConflictStageStore();

    // An older PULL with a genuinely valid, readable snapshot, and a NEWER PULL whose snapshot was
    // also written normally but whose read FAILS this pass (a half-written/corrupt snapshot after a
    // crash — the scenario the sweeper exists to clean up after). A read failure must abort the whole
    // scan, never fall through to treat the older op as the one to keep.
    const olderOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    await waitPastAMillisecond(); // a real createdAt gap, so "newer" is unambiguous on the newest-first scan
    const newerOperationId = await seedSucceededOperation(operationRepository, projectId, 'PULL');
    for (const operationId of [olderOperationId, newerOperationId]) {
      await execFile('git', ['update-ref', backupReference(operationId), head], { cwd });
      await realStore.writeSnapshot(operationId, { preOpHead: head, branch: 'main' });
    }
    const store = new ReadSnapshotFailsForOneOperation(realStore, newerOperationId);

    const sweeper = createUndoReferenceSweeper({
      storageRoot,
      gitOperationRepository: operationRepository,
      conflictStageStore: store,
      logger: silentLogger,
    });
    await sweeper.sweep(makeRepository(projectId));

    // Conservative abort: BOTH backup refs survive. The newer op's ref is not wrongly pruned down to
    // (i.e. never deleted, since it's meant to be kept), and — critically — the older op's ref is also
    // NOT deleted, because the read failure on the newest op must abort the sweep entirely rather than
    // falling through to pick the older op as "the one to keep" and reclaiming everything else.
    expect(await readReferenceOrNull(cwd, backupReference(newerOperationId))).toBe(head);
    expect(await readReferenceOrNull(cwd, backupReference(olderOperationId))).toBe(head);
  });
});
