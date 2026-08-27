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
  ProjectId,
  ProjectMemberRepository,
} from '@asciidocollab/domain';
import { AuthenticationFailedError, PullChangesUseCase, RepositoryUnreachableError, buildGitDriftSummary } from '@asciidocollab/domain';
import type { GitErrorCode } from '@asciidocollab/shared';
import type { GitOperationOutcome } from './git-operation-dispatcher.js';

/**
 * The credential store's decrypt-for-execution surface `createPullHandler` needs — a structural
 * subset of `PrismaGitCredentialStore.loadDecrypted` (`@asciidocollab/infrastructure`). Named
 * separately rather than importing that concrete adapter's type, so this module (and its tests)
 * can be built against a plain fake without depending on the adapter package. Structurally
 * identical to `PushCredentialSource` (`push-handler.ts`) — kept as its own named interface so
 * this module reads symmetrically alongside it.
 */
export interface PullCredentialSource {
  /**
   * Reads back and decrypts the stored credential for a project.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token (plus its display hint), or null if the project has none.
   */
  loadDecrypted(projectId: ProjectId): Promise<{ readonly token: string; readonly tokenHint: string | null } | null>;
}

/** Safe, typed error code recorded when a claimed PULL operation has no `GitRepository` row to pull against — a route/enqueue bug, not a user-facing refusal. */
export const PULL_REPOSITORY_NOT_FOUND_ERROR_CODE = 'PULL_REPOSITORY_NOT_FOUND';

/** Safe, typed error code recorded when a claimed PULL operation has no stored credential to decrypt — a route/enqueue bug, not a user-facing refusal. */
export const PULL_CREDENTIAL_NOT_FOUND_ERROR_CODE = 'PULL_CREDENTIAL_NOT_FOUND';

/** Safe, typed error code recorded for any pull failure not covered by a more specific `GitErrorCode`. Carries no internal detail. */
export const PULL_FAILED_ERROR_CODE = 'PULL_FAILED';

/** Every dependency `createPullHandler` closes over to run a `PULL` operation. */
export interface PullHandlerDeps {
  /** Resolves the actor's role for the use case's own defense-in-depth authorization check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records an authorization denial to the audit trail. Not used on the success path — the run loop records the terminal SUCCEEDED transition for an async op. */
  auditLogRepository: AuditLogRepository;
  /** Loads the project's repository link (for its remote/current branch) and writes it back after the merge. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Records a `GitConflict` per conflicting file on a conflicted merge. */
  gitOperationRepository: GitOperationRepository;
  /** Runs the actual fetch and merge. */
  commandRunner: GitCommandRunner;
  /** Resolves an open document's file node to build its pre-merge flush entry. */
  fileNodeRepository: FileNodeRepository;
  /** Resolves an active session's document (and its file node) for the flush. */
  documentRepository: DocumentRepository;
  /** Reads a document's current live text for the flush. */
  collaborativeContentReader: CollaborativeContentReader;
  /** Names the documents with an active collaborative session to flush before the merge. */
  collaborationSessionRepository: CollaborationSessionRepository;
  /** Lands a clean merge's change-set into the project. */
  reconciler: FileChangeReconciler;
  /** Decrypts the stored credential at execution time — never the domain port's ciphertext-only `load()`. */
  credentialSource: PullCredentialSource;
  /** Optional sink for best-effort failures that must stay visible. Never receives the decrypted token. */
  logger?: Logger;
}

/**
 * Maps a failed pull's typed domain error to a safe, non-internal wire code: a `GitErrorCode`
 * member (`@asciidocollab/shared`) where one fits the error's category, or a stable
 * `PULL_FAILED_ERROR_CODE` for anything else (a role/flush/generic command failure) — never the
 * error's own message, which may describe internals. A merge conflict never reaches this
 * function: it is reported as `awaitingConflict`, not a `!success` error.
 */
function mapPullErrorToCode(error: DomainError): string {
  if (error instanceof RepositoryUnreachableError) {
    const code: GitErrorCode = 'repository_unreachable';
    return code;
  }
  if (error instanceof AuthenticationFailedError) {
    const code: GitErrorCode = 'authentication_failed';
    return code;
  }
  return PULL_FAILED_ERROR_CODE;
}

/**
 * Builds the `PULL` `GitOperationHandler`: runs `PullChangesUseCase` against the project's
 * already-connected `GitRepository` row.
 *
 * Flow: load the connected `GitRepository` link; decrypt the stored credential; run the use case
 * with both plus the operation's actor and its own id. Both pre-conditions (missing repository
 * link, missing credential) are reported as a `failed` outcome rather than thrown — they are a bug
 * in the route's synchronous hand-off (or a repository that was disconnected between enqueue and
 * claim), not something this handler is positioned to recover from, but a claimed operation must
 * still reach a terminal state. A merge left in conflict is reported as `awaitingConflict` — an
 * expected outcome of a pull, not a failure; the run loop maps it to the `AWAITING_CONFLICT`
 * transition without auditing.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the pull with.
 * @returns A `GitOperationHandler` ready to register under the `PULL` `GitOperationKind`.
 */
export function createPullHandler(deps: PullHandlerDeps): (operation: GitOperation) => Promise<GitOperationOutcome> {
  const pullChanges = new PullChangesUseCase(
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

  return async function pullHandler(operation: GitOperation): Promise<GitOperationOutcome> {
    const gitRepository = await deps.gitRepositoryRepository.findByProjectId(operation.projectId);
    if (gitRepository === null) {
      return { kind: 'failed', errorCode: PULL_REPOSITORY_NOT_FOUND_ERROR_CODE };
    }

    const credential = await deps.credentialSource.loadDecrypted(operation.projectId);
    if (credential === null) {
      return { kind: 'failed', errorCode: PULL_CREDENTIAL_NOT_FOUND_ERROR_CODE };
    }

    const result = await pullChanges.execute({
      actorId: operation.triggeredByUserId,
      projectId: operation.projectId,
      operationId: operation.id,
      token: credential.token,
    });

    if (!result.success) {
      return { kind: 'failed', errorCode: mapPullErrorToCode(result.error) };
    }

    if (result.value.status === 'awaiting_conflict') {
      return { kind: 'awaitingConflict' };
    }

    // Carry any reconcile drift onto the terminal outcome so the run loop persists it on the row and
    // the triggering user is warned — the pull result is otherwise discarded here.
    const driftSummary = buildGitDriftSummary(result.value.anomalies);
    return driftSummary ? { kind: 'succeeded', driftSummary } : { kind: 'succeeded' };
  };
}
