import type {
  AuditLogRepository,
  DomainError,
  GitCommandRunner,
  GitOperation,
  GitOperationRepository,
  GitRepositoryRepository,
  Logger,
  ProjectId,
  ProjectMemberRepository,
} from '@asciidocollab/domain';
import {
  AuthenticationFailedError,
  InitializeRepositoryUseCase,
  RemoteAlreadyInitializedError,
  RepositoryUnreachableError,
} from '@asciidocollab/domain';
import type { GitErrorCode } from '@asciidocollab/shared';
import type { GitOperationOutcome } from './git-operation-dispatcher.js';

/**
 * The credential store's decrypt-for-execution and removal surface `createInitializeHandler`
 * needs — a structural subset of `PrismaGitCredentialStore` (`@asciidocollab/infrastructure`),
 * which already implements both. Named separately, mirroring `ImportCredentialSource`, so this
 * module (and its tests) can be built against a plain fake without depending on the adapter
 * package.
 */
export interface InitializeCredentialSource {
  /**
   * Reads back and decrypts the stored credential for a project.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token (plus its display hint), or null if the project has none.
   */
  loadDecrypted(projectId: ProjectId): Promise<{ readonly token: string; readonly tokenHint: string | null } | null>;

  /**
   * Removes the stored credential for a project. Used by this handler's own abandoned-cleanup
   * when a claimed initialize fails.
   *
   * @param projectId - The project whose credential should be removed.
   * @returns A promise that resolves once the credential has been removed.
   */
  delete(projectId: ProjectId): Promise<void>;
}

/** Safe, typed error code recorded when a claimed INITIALIZE operation has no `GitRepository` placeholder row to complete — a route/enqueue bug, not a user-facing refusal. */
export const INITIALIZE_REPOSITORY_NOT_FOUND_ERROR_CODE = 'INITIALIZE_REPOSITORY_NOT_FOUND';

/** Safe, typed error code recorded when a claimed INITIALIZE operation has no stored credential to decrypt — a route/enqueue bug, not a user-facing refusal. */
export const INITIALIZE_CREDENTIAL_NOT_FOUND_ERROR_CODE = 'INITIALIZE_CREDENTIAL_NOT_FOUND';

/** Safe, typed error code recorded for any initialize failure not covered by a more specific `GitErrorCode` (validation failures, an authorization refusal, or a generic command failure). Carries no internal detail. */
export const INITIALIZE_FAILED_ERROR_CODE = 'INITIALIZE_FAILED';

/** Every dependency `createInitializeHandler` closes over to run an `INITIALIZE` operation. */
export interface InitializeHandlerDeps {
  /** Loads the pre-created placeholder repository link (for its remote/provider) and writes it back completed; deleted again on a failed initialize. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Runs the atomic init → remote-add → initial-commit → push sequence against the remote. */
  commandRunner: GitCommandRunner;
  /** Single-flight guard so an initialize cannot race another git action for the same project. */
  gitOperationRepository: GitOperationRepository;
  /** Resolves the actor's role for the use case's own OWNER-gate check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records the authorization denial and the successful publish. */
  auditLogRepository: AuditLogRepository;
  /** Decrypts the stored credential at execution time, and removes it on a failed initialize. */
  credentialSource: InitializeCredentialSource;
  /** Optional sink for best-effort failures that must stay visible. Never receives the decrypted token. */
  logger?: Logger;
}

/**
 * Maps a failed initialize's typed domain error to a safe, non-internal wire code: a
 * `GitErrorCode` member (`@asciidocollab/shared`) where one fits the error's category, or a stable
 * `INITIALIZE_FAILED_ERROR_CODE` for anything else (an authorization refusal, a rejected
 * provider/remote-URL shape, or a generic command failure) — never the error's own message, which
 * may describe internals.
 */
function mapInitializeErrorToCode(error: DomainError): string {
  if (error instanceof RemoteAlreadyInitializedError) {
    const code: GitErrorCode = 'remote_already_initialized';
    return code;
  }
  if (error instanceof RepositoryUnreachableError) {
    const code: GitErrorCode = 'repository_unreachable';
    return code;
  }
  if (error instanceof AuthenticationFailedError) {
    const code: GitErrorCode = 'authentication_failed';
    return code;
  }
  return INITIALIZE_FAILED_ERROR_CODE;
}

/**
 * Builds the `INITIALIZE` `GitOperationHandler`: runs `InitializeRepositoryUseCase` against the
 * pre-created `GitRepository` placeholder row a route already created before ever enqueuing the
 * operation.
 *
 * Flow: load the pre-created `GitRepository` link (its `provider`/`remoteUrl`); decrypt the stored
 * credential; run the use case with both plus the operation's actor/branch; map its `Result` to a
 * `GitOperationOutcome`. Both pre-conditions (missing repository link, missing credential) are
 * reported as a `failed` outcome rather than thrown — they are a bug in the route's synchronous
 * hand-off, not something this handler is positioned to recover from, but a claimed operation must
 * still reach a terminal state.
 *
 * Unlike `createImportHandler`, a failed run here does its own abandoned-cleanup: the use case
 * itself deliberately leaves the pre-created placeholder row untouched on ANY failure (so its own
 * all-or-nothing boundary stays simple), which would otherwise strand a `GitRepository` row (and
 * its stored credential) attached to a project that never actually got published — silently
 * looking "connected" to nothing. This handler removes both, reverting the project to genuinely
 * non-git and free to retry a fresh connect/import/initialize.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the
 *   initialize with.
 * @returns A `GitOperationHandler` ready to register under the `INITIALIZE` `GitOperationKind`.
 */
export function createInitializeHandler(
  deps: InitializeHandlerDeps,
): (operation: GitOperation) => Promise<GitOperationOutcome> {
  const initializeRepository = new InitializeRepositoryUseCase(
    deps.gitRepositoryRepository,
    deps.commandRunner,
    deps.gitOperationRepository,
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.logger,
  );

  return async function initializeHandler(operation: GitOperation): Promise<GitOperationOutcome> {
    const gitRepository = await deps.gitRepositoryRepository.findByProjectId(operation.projectId);
    if (gitRepository === null) {
      return { kind: 'failed', errorCode: INITIALIZE_REPOSITORY_NOT_FOUND_ERROR_CODE };
    }

    const credential = await deps.credentialSource.loadDecrypted(operation.projectId);
    if (credential === null) {
      return { kind: 'failed', errorCode: INITIALIZE_CREDENTIAL_NOT_FOUND_ERROR_CODE };
    }

    const result = await initializeRepository.execute({
      actorId: operation.triggeredByUserId,
      projectId: operation.projectId,
      provider: gitRepository.provider.value,
      remoteUrl: gitRepository.remoteUrl,
      token: credential.token,
      branch: operation.branch ?? undefined,
    });

    if (!result.success) {
      // Abandoned-cleanup: the use case itself leaves the placeholder row untouched on failure, so
      // this handler removes it (and the now-orphaned stored credential) itself — a failed
      // initialize must never leave a dangling repository link or an orphaned credential behind.
      await deps.gitRepositoryRepository.delete(gitRepository.id);
      await deps.credentialSource.delete(operation.projectId);
      return { kind: 'failed', errorCode: mapInitializeErrorToCode(result.error) };
    }

    return { kind: 'succeeded' };
  };
}
