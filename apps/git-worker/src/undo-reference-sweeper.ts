import {
  GitOperationId,
  TERMINAL_GIT_OPERATION_STATES,
  type ConflictStageStore,
  type GitOperationKind,
  type GitOperationRepository,
  type GitRepository,
} from '@asciidocollab/domain';
import { deleteBackupReferenceAndClearSnapshot, listBackupReferenceOperationIds } from './git/backup-references.js';
import { resolveWorkingTreePath } from './git/working-tree.js';
import type { RemoteRefreshLogger } from './remote-refresh-scheduler.js';

/**
 * The content-op kinds whose undo point is retained and undoable — a `PULL` or a `BRANCH_SWITCH`
 * (the same set `UndoPullUseCase` treats as undoable). `IMPORT`, the third content-changing kind,
 * is excluded throughout the revert feature: it clones fresh into an empty project and records no
 * pre-operation undo snapshot, so it has no backup ref to keep.
 */
const SWEEPABLE_UNDO_KINDS: readonly GitOperationKind[] = ['PULL', 'BRANCH_SWITCH'];

/**
 * How many of the project's most-recent content ops the sweep scans to find the one undo point to
 * keep — the newest that SUCCEEDED and still has a retained snapshot. Bounds the per-sweep query and snapshot
 * reads while comfortably covering a realistic straggler backlog: the inline prune keeps this to one
 * in the normal case, so more than a handful only accumulates if several prunes crashed in a row.
 */
const KEEP_LOOKBACK = 10;

/** Everything {@link createUndoReferenceSweeper} needs to sweep a project's stale undo refs. */
export interface UndoReferenceSweeperDeps {
  /** Root directory for per-project working trees; the sweeper resolves each project's `cwd` under it. */
  storageRoot: string;
  /** Scans the project's recent undoable content ops for the one undo point to keep (newest SUCCEEDED op with a snapshot). */
  gitOperationRepository: GitOperationRepository;
  /** Clears the off-tree snapshot alongside each stale backup ref the sweep deletes. */
  conflictStageStore: ConflictStageStore;
  /** Structured sink for per-repo diagnostics (shared with the remote-refresh scheduler). */
  logger: RemoteRefreshLogger;
}

/** A best-effort, per-repository sweep of orphaned `refs/adc/undo/*` undo points. */
export interface UndoReferenceSweeper {
  /**
   * Sweeps one connected repository's stale undo refs. Best-effort and self-contained: every failure
   * is caught and logged, and one repo's failure never propagates — a caller iterating the connected
   * set can call this per repo inside its own error boundary and keep going.
   *
   * @param repository - The connected repository whose backup refs to sweep.
   * @returns Resolves once the repository has been swept (or skipped).
   */
  sweep(repository: GitRepository): Promise<void>;
}

/**
 * Builds the belt-and-braces backstop to the inline prune `MergeConflictOps` runs when a content op
 * records its undo snapshot: it removes any `refs/adc/undo/*` straggler a crash left between that
 * snapshot write and its prune, keeping only the ref for the project's MOST-RECENT undoable content
 * op that SUCCEEDED and whose snapshot is still retained (a failed op's early-written snapshot is not
 * a valid undo point, so it is never elected). The result is the same "exactly
 * one retained undo point per project" invariant the inline prune enforces, made durable against a
 * mid-op crash.
 *
 * Retention is enforced at the git-ref level in each PROJECT's own repo — where each op's backup ref
 * lives — NOT by scanning the conflict-stage store (which is keyed by operation under a shared root,
 * not scoped per project).
 *
 * @param deps - The sweeper's collaborators; see {@link UndoReferenceSweeperDeps}.
 * @returns A sweeper whose {@link UndoReferenceSweeper.sweep} the scheduler runs per connected repo.
 */
export function createUndoReferenceSweeper(deps: UndoReferenceSweeperDeps): UndoReferenceSweeper {
  /**
   * The operation id value whose undo point must be KEPT for this project: its most-recent undoable
   * content op that SUCCEEDED and STILL has a retained snapshot. A valid retained undo point is a
   * SUCCEEDED op with a retained snapshot — NOT merely any op that has a snapshot: a content op writes
   * its undo snapshot EARLY (before its fallible merge/checkout), so a crashed/failed op can leave an
   * orphaned snapshot behind. Electing such an op as `keep` would then sweep the genuine SUCCEEDED
   * undo point's ref, so any op that is not `SUCCEEDED` is scanned past outright (its snapshot is not
   * even read). This is the SAME selection undo Case B makes, so the sweeper never deletes a point
   * undo would reach. The sweep only ever runs on a quiescent repo, so an `AWAITING_CONFLICT` op is
   * never among these (it would be the active op, which makes the sweep skip entirely).
   *
   * Scans recent content ops newest-first and returns the first SUCCEEDED op whose snapshot is
   * present, so a SUCCEEDED op whose snapshot was already cleared is skipped rather than taken as
   * "nothing to keep" — which would let the caller mistake a still-valid older undo point for a
   * straggler and delete it. Null when NONE of the recent content ops is a SUCCEEDED-with-snapshot,
   * OR when a `readSnapshot` call on a SUCCEEDED candidate itself FAILS (e.g. a half-written/corrupt
   * snapshot left by a crash — exactly the scenario this sweeper exists to clean up after): a read
   * failure is NOT the same as a confirmed-absent snapshot, so it must not be treated as "skip this
   * op and consider an older one" — that could make the caller delete the newest op's still-real
   * backup ref out from under a snapshot that merely failed to read this pass. Only a CONFIRMED-absent
   * snapshot (`success: true, value: null`) is skipped to consider an older op; a failed read aborts
   * the whole scan immediately. Either way the caller treats null as "keep everything", never "delete
   * everything".
   */
  async function keepOperationIdValue(repository: GitRepository): Promise<string | null> {
    const recent = await deps.gitOperationRepository.findRecentByKinds(
      repository.projectId,
      SWEEPABLE_UNDO_KINDS,
      KEEP_LOOKBACK,
    );
    for (const operation of recent) {
      // A valid retained undo point requires SUCCEEDED, not just a snapshot: an op that failed before
      // its merge/checkout can orphan a snapshot it wrote early, and electing it would sweep the real
      // undo point's ref. Scan past any non-SUCCEEDED op without even reading its snapshot.
      if (operation.state !== 'SUCCEEDED') continue;
      const snapshot = await deps.conflictStageStore.readSnapshot(operation.id);
      if (!snapshot.success) return null;
      if (snapshot.value !== null) return operation.id.value;
    }
    return null;
  }

  /**
   * Whether the operation a backup ref belongs to is in a TERMINAL state (SUCCEEDED/FAILED/ABORTED)
   * — the only refs the sweep may reclaim. Closes a never-lose-work TOCTOU: the sweep's active-repo
   * early-skip and `keep` selection are computed from a snapshot taken moments before the delete
   * loop, so a PULL/BRANCH_SWITCH that starts in that window and pins `refs/adc/undo/<newOpId>` would
   * — since `keep` (computed earlier) does not elect it — otherwise have its just-pinned undo artifact
   * deleted. Confirming THIS ref's op is terminal before deleting refuses to touch a concurrently
   * active (QUEUED/RUNNING/AWAITING_CONFLICT) op's ref.
   *
   * Conservative on every uncertainty, mirroring the keep/read-failure stance: a suffix that does not
   * parse as an operation id, an operation the lookup cannot find, and a lookup that itself throws all
   * return `false` (do NOT delete) — none is a CONFIRMED terminal state, and the sweep is best-effort
   * cleanup that must never destroy a live never-lose-work ref on a doubtful reading.
   */
  async function backupReferenceOperationIsTerminal(operationIdValue: string): Promise<boolean> {
    let operationId: GitOperationId;
    try {
      operationId = GitOperationId.create(operationIdValue);
    } catch {
      return false;
    }
    try {
      const operation = await deps.gitOperationRepository.findById(operationId);
      if (operation === null) return false;
      return TERMINAL_GIT_OPERATION_STATES.includes(operation.state);
    } catch {
      return false;
    }
  }

  return {
    async sweep(repository: GitRepository): Promise<void> {
      try {
        // Only sweep a quiescent repository. A concurrent operation owns the project's single-flight
        // slot and its own inline prune already keeps retention tidy; skipping here avoids ever
        // racing an in-flight pull/switch on the ref database.
        const active = await deps.gitOperationRepository.findActiveOperation(repository.projectId);
        if (active !== null) return;

        const cwd = resolveWorkingTreePath(deps.storageRoot, repository.projectId);
        const operationIdValues = await listBackupReferenceOperationIds(cwd);
        if (operationIdValues.length === 0) return;

        const keep = await keepOperationIdValue(repository);
        // Conservative backstop: when NO recent content op has a retained snapshot (`keep` is null),
        // reclaim NOTHING. Every backup ref present may still pin recoverable moved work, and there
        // is no confirmed newer undo point to prune down to — so deleting them all on a transient or
        // partial "no snapshot yet" reading is exactly the never-lose-work regression this guards
        // against. The normal case (a real undo point exists) keeps that one and sweeps the rest.
        if (keep === null) return;

        for (const operationIdValue of operationIdValues) {
          if (operationIdValue === keep) continue;
          // Never delete a ref whose operation is still active: a pull/switch that started AFTER
          // `keep` was elected (in the window between the active-repo check above and this loop) pins
          // its own `refs/adc/undo/<newOpId>` that `keep` cannot have elected, and deleting it would
          // destroy that op's never-lose-work artifact. Confirm THIS ref's op is terminal first; skip
          // a non-terminal, missing, or unreadable one (conservative, as {@link
          // backupReferenceOperationIsTerminal} documents).
          if (!(await backupReferenceOperationIsTerminal(operationIdValue))) continue;
          // Delete the ref and clear its snapshot as independent best-effort steps (see
          // {@link deleteBackupReferenceAndClearSnapshot}); each failure is logged and swallowed so one
          // stale entry never stops the sweep of the rest.
          await deleteBackupReferenceAndClearSnapshot(
            cwd,
            operationIdValue,
            deps.conflictStageStore,
            (error, stage) => {
              deps.logger.error(
                { projectId: repository.projectId.value, err: error },
                stage === 'delete-ref'
                  ? 'undo-ref-sweep: failed to remove a stale undo ref'
                  : 'undo-ref-sweep: failed to clear a stale undo snapshot',
              );
            },
          );
        }
      } catch (error) {
        // Swallow so one repo's unexpected failure never stops the caller's sweep of the rest.
        deps.logger.error(
          { projectId: repository.projectId.value, err: error },
          'undo-ref-sweep: unexpected failure sweeping a repository',
        );
      }
    },
  };
}
