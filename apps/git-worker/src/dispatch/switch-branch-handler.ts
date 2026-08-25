import type {
  AuditLogRepository,
  CollaborationSessionRepository,
  CollaborativeContentReader,
  DocumentRepository,
  DomainError,
  FileChangeReconciler,
  FileNodeRepository,
  GitCommandRunner,
  GitOperation,
  GitOperationRepository,
  GitRepositoryRepository,
  Logger,
  ProjectMemberRepository,
} from '@asciidocollab/domain';
import { SwitchBranchUseCase } from '@asciidocollab/domain';
import type { GitOperationOutcome } from './git-operation-dispatcher.js';

/** Safe, typed error code recorded when a claimed BRANCH_SWITCH operation carries no target branch — a route/enqueue bug, not a user-facing refusal. */
export const SWITCH_BRANCH_MISSING_ERROR_CODE = 'SWITCH_BRANCH_MISSING';

/** Safe, typed error code recorded for any switch failure. Carries no internal detail. */
export const SWITCH_FAILED_ERROR_CODE = 'SWITCH_FAILED';

/** Every dependency `createSwitchBranchHandler` closes over to run a `BRANCH_SWITCH` operation. */
export interface SwitchBranchHandlerDeps {
  /** Resolves the actor's role for the use case's own defense-in-depth authorization check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records an authorization denial to the audit trail. Not used on the success path — the run loop records the terminal SUCCEEDED transition for an async op. */
  auditLogRepository: AuditLogRepository;
  /** Loads the project's repository link (for its current branch) and writes it back after the switch. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Records a `GitConflict` per conflicting file on a conflicted switch. */
  gitOperationRepository: GitOperationRepository;
  /** Runs the actual checkout. */
  commandRunner: GitCommandRunner;
  /** Resolves an open document's file node to build its pre-switch flush entry. */
  fileNodeRepository: FileNodeRepository;
  /** Resolves an active session's document (and its file node) for the flush. */
  documentRepository: DocumentRepository;
  /** Reads a document's current live text for the flush. */
  collaborativeContentReader: CollaborativeContentReader;
  /** Names the documents with an active collaborative session to flush before the switch. */
  collaborationSessionRepository: CollaborationSessionRepository;
  /** Lands a clean switch's change-set into the project. */
  reconciler: FileChangeReconciler;
  /** Optional sink for best-effort failures that must stay visible. */
  logger?: Logger;
}

/**
 * Maps a failed switch's typed domain error to a safe, non-internal wire code. Unlike a pull, a
 * switch is a purely LOCAL operation with no network step, so none of the reachability/credential
 * error categories can arise — every failure (a role refusal, a disconnected repository, a
 * live-content flush failure, or a generic checkout command failure) collapses to one stable code,
 * never the error's own message, which may describe internals.
 */
function mapSwitchErrorToCode(_error: DomainError): string {
  return SWITCH_FAILED_ERROR_CODE;
}

/**
 * Builds the `BRANCH_SWITCH` `GitOperationHandler`: runs `SwitchBranchUseCase` against the
 * project's connected `GitRepository` row.
 *
 * The switch is purely local, so — unlike the IMPORT/PULL handlers — there is no credential to load:
 * the use case takes no token. A switch left in conflict is reported as `awaitingConflict`, an
 * expected outcome of a switch, not a failure; the run loop maps it to the `AWAITING_CONFLICT`
 * transition without auditing.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the switch with.
 * @returns A `GitOperationHandler` ready to register under the `BRANCH_SWITCH` `GitOperationKind`.
 */
export function createSwitchBranchHandler(
  deps: SwitchBranchHandlerDeps,
): (operation: GitOperation) => Promise<GitOperationOutcome> {
  const switchBranch = new SwitchBranchUseCase(
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.gitRepositoryRepository,
    deps.gitOperationRepository,
    deps.commandRunner,
    deps.fileNodeRepository,
    deps.documentRepository,
    deps.collaborativeContentReader,
    deps.collaborationSessionRepository,
    deps.reconciler,
    deps.logger,
  );

  return async function switchBranchHandler(operation: GitOperation): Promise<GitOperationOutcome> {
    const targetBranch = operation.branch;
    if (targetBranch === null || targetBranch.length === 0) {
      // A claimed switch that carries no target branch is a route/enqueue bug, but the operation must
      // still reach a terminal state rather than throw.
      return { kind: 'failed', errorCode: SWITCH_BRANCH_MISSING_ERROR_CODE };
    }

    const result = await switchBranch.execute({
      actorId: operation.triggeredByUserId,
      projectId: operation.projectId,
      operationId: operation.id,
      targetBranch,
      // Always preserve the author's in-progress edits across the switch: a queued switch has no way
      // to carry a per-request "keep my edits" choice (the persisted operation has no such field), and
      // silently discarding live work would be the unsafe default. On a tree with nothing flushed the
      // runner's stash step is a no-op, so this costs nothing when there is nothing to preserve.
      stashLocal: true,
    });

    if (!result.success) {
      return { kind: 'failed', errorCode: mapSwitchErrorToCode(result.error) };
    }

    if (result.value.status === 'awaiting_conflict') {
      return { kind: 'awaitingConflict' };
    }

    return { kind: 'succeeded' };
  };
}
