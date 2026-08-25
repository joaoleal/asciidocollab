import type {
  AuditLogRepository,
  DomainError,
  GitCommandRunner,
  GitOperation,
  GitRepositoryRepository,
  Logger,
  ProjectId,
  ProjectMemberRepository,
} from '@asciidocollab/domain';
import { AuthenticationFailedError, NonFastForwardError, PushChangesUseCase, RepositoryUnreachableError } from '@asciidocollab/domain';
import type { GitErrorCode } from '@asciidocollab/shared';
import type { GitOperationOutcome } from './git-operation-dispatcher.js';

/**
 * The credential store's decrypt-for-execution surface `createPushHandler` needs — a structural
 * subset of `PrismaGitCredentialStore.loadDecrypted` (`@asciidocollab/infrastructure`). Named
 * separately rather than importing that concrete adapter's type, so this module (and its tests)
 * can be built against a plain fake without depending on the adapter package.
 */
export interface PushCredentialSource {
  /**
   * Reads back and decrypts the stored credential for a project.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token (plus its display hint), or null if the project has none.
   */
  loadDecrypted(projectId: ProjectId): Promise<{ readonly token: string; readonly tokenHint: string | null } | null>;
}

/** Safe, typed error code recorded when a claimed PUSH operation has no `GitRepository` row to push against — a route/enqueue bug, not a user-facing refusal. */
export const PUSH_REPOSITORY_NOT_FOUND_ERROR_CODE = 'PUSH_REPOSITORY_NOT_FOUND';

/** Safe, typed error code recorded when a claimed PUSH operation has no stored credential to decrypt — a route/enqueue bug, not a user-facing refusal. */
export const PUSH_CREDENTIAL_NOT_FOUND_ERROR_CODE = 'PUSH_CREDENTIAL_NOT_FOUND';

/** Safe, typed error code recorded for any push failure not covered by a more specific `GitErrorCode` (role/connection refusals, generic command failures). Carries no internal detail. */
export const PUSH_FAILED_ERROR_CODE = 'PUSH_FAILED';

/** Every dependency `createPushHandler` closes over to run a `PUSH` operation. */
export interface PushHandlerDeps {
  /** Resolves the actor's role for the use case's own defense-in-depth authorization check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records an authorization denial, or the completed push, to the audit trail. */
  auditLogRepository: AuditLogRepository;
  /** Loads the project's repository link (for its remote/current branch) and writes it back on success. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Runs the actual push. */
  commandRunner: GitCommandRunner;
  /** Decrypts the stored credential at execution time — never the domain port's ciphertext-only `load()`. */
  credentialSource: PushCredentialSource;
  /** Optional sink for best-effort failures that must stay visible. Never receives the decrypted token. */
  logger?: Logger;
}

/**
 * Maps a failed push's typed domain error to a safe, non-internal wire code: a `GitErrorCode`
 * member (`@asciidocollab/shared`) where one fits the error's category, or a stable
 * `PUSH_FAILED_ERROR_CODE` for anything else (a role/connection refusal, or a generic command
 * failure) — never the error's own message, which may describe internals.
 */
function mapPushErrorToCode(error: DomainError): string {
  if (error instanceof RepositoryUnreachableError) {
    const code: GitErrorCode = 'repository_unreachable';
    return code;
  }
  if (error instanceof AuthenticationFailedError) {
    const code: GitErrorCode = 'authentication_failed';
    return code;
  }
  if (error instanceof NonFastForwardError) {
    const code: GitErrorCode = 'non_fast_forward';
    return code;
  }
  return PUSH_FAILED_ERROR_CODE;
}

/**
 * Builds the `PUSH` `GitOperationHandler`: runs `PushChangesUseCase` against the project's
 * already-connected `GitRepository` row.
 *
 * Flow: load the connected `GitRepository` link; decrypt the stored credential; run the use case
 * with both plus the operation's actor. Both pre-conditions (missing repository link, missing
 * credential) are reported as a `failed` outcome rather than thrown — they are a bug in the
 * route's synchronous hand-off (or a repository that was disconnected between enqueue and claim),
 * not something this handler is positioned to recover from, but a claimed operation must still
 * reach a terminal state.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the push with.
 * @returns A `GitOperationHandler` ready to register under the `PUSH` `GitOperationKind`.
 */
export function createPushHandler(deps: PushHandlerDeps): (operation: GitOperation) => Promise<GitOperationOutcome> {
  const pushChanges = new PushChangesUseCase(
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.gitRepositoryRepository,
    deps.commandRunner,
    deps.logger,
  );

  return async function pushHandler(operation: GitOperation): Promise<GitOperationOutcome> {
    const gitRepository = await deps.gitRepositoryRepository.findByProjectId(operation.projectId);
    if (gitRepository === null) {
      return { kind: 'failed', errorCode: PUSH_REPOSITORY_NOT_FOUND_ERROR_CODE };
    }

    const credential = await deps.credentialSource.loadDecrypted(operation.projectId);
    if (credential === null) {
      return { kind: 'failed', errorCode: PUSH_CREDENTIAL_NOT_FOUND_ERROR_CODE };
    }

    const result = await pushChanges.execute({
      actorId: operation.triggeredByUserId,
      projectId: operation.projectId,
      token: credential.token,
    });

    if (!result.success) {
      return { kind: 'failed', errorCode: mapPushErrorToCode(result.error) };
    }

    return { kind: 'succeeded' };
  };
}
