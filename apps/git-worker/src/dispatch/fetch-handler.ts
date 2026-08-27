import type {
  DomainError,
  GitCommandRunner,
  GitOperation,
  GitRepositoryRepository,
  Logger,
  ProjectId,
} from '@asciidocollab/domain';
import {
  AuthenticationFailedError,
  RefreshRemoteStatusUseCase,
  RepositoryUnreachableError,
} from '@asciidocollab/domain';
import type { GitErrorCode } from '@asciidocollab/shared';
import type { GitOperationOutcome } from './git-operation-dispatcher.js';

/**
 * The credential store's decrypt-for-execution surface `createFetchHandler` needs — a structural
 * subset of `PrismaGitCredentialStore.loadDecrypted` (`@asciidocollab/infrastructure`). Named
 * separately rather than importing that concrete adapter's type, so this module (and its tests) can
 * be built against a plain fake without depending on the adapter package. Structurally identical to
 * `PullCredentialSource` (`pull-handler.ts`) — kept as its own named interface so this module reads
 * symmetrically alongside it.
 */
export interface FetchCredentialSource {
  /**
   * Reads back and decrypts the stored credential for a project.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token (plus its display hint), or null if the project has none.
   */
  loadDecrypted(projectId: ProjectId): Promise<{ readonly token: string; readonly tokenHint: string | null } | null>;
}

/** Safe, typed error code recorded when a claimed FETCH operation has no `GitRepository` row to fetch against — a disconnect between enqueue and claim, not a user-facing refusal. */
export const FETCH_REPOSITORY_NOT_FOUND_ERROR_CODE = 'FETCH_REPOSITORY_NOT_FOUND';

/** Safe, typed error code recorded when a claimed FETCH operation has no stored credential to decrypt. */
export const FETCH_CREDENTIAL_NOT_FOUND_ERROR_CODE = 'FETCH_CREDENTIAL_NOT_FOUND';

/** Safe, typed error code recorded for any refresh failure not covered by a more specific `GitErrorCode`. Carries no internal detail. */
export const FETCH_FAILED_ERROR_CODE = 'FETCH_FAILED';

/** Every dependency `createFetchHandler` closes over to run a `FETCH` operation. */
export interface FetchHandlerDeps {
  /** Loads the project's repository link (its remote/current branch) and writes back its refreshed sync fields. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Fetches the remote-tracking ref and compares it to the local branch. */
  commandRunner: GitCommandRunner;
  /** Decrypts the stored credential at execution time — never the domain port's ciphertext-only `load()`. */
  credentialSource: FetchCredentialSource;
  /** Optional sink for best-effort diagnostics. Never receives the decrypted token. */
  logger?: Logger;
}

/**
 * Maps a failed refresh's typed domain error to a safe, non-internal wire code: a `GitErrorCode`
 * member (`@asciidocollab/shared`) where one fits the error's category, or a stable
 * `FETCH_FAILED_ERROR_CODE` for anything else — never the error's own message.
 */
function mapFetchErrorToCode(error: DomainError): string {
  if (error instanceof RepositoryUnreachableError) {
    const code: GitErrorCode = 'repository_unreachable';
    return code;
  }
  if (error instanceof AuthenticationFailedError) {
    const code: GitErrorCode = 'authentication_failed';
    return code;
  }
  return FETCH_FAILED_ERROR_CODE;
}

/**
 * Builds the `FETCH` `GitOperationHandler`: runs `RefreshRemoteStatusUseCase` against the project's
 * already-connected `GitRepository` row — a refs-only fetch that recomputes and stores the sync
 * status ("behind by N — pull available") without downloading any file content.
 *
 * ## Why FETCH is a queued `GitOperation` (the serialization mechanism)
 * A background remote refresh MUST NOT run its `git fetch` concurrently with a user's
 * pull/push/branch-switch on the same working tree — two processes contending on `.git/*.lock` can
 * make the USER-facing operation fail with `fatal: Unable to create '.git/…lock'`. Routing the
 * refresh through the ordinary operation queue (the scheduler enqueues a `FETCH`; the run loop's
 * `claimNextQueued` single-flight claims it) reuses the EXACT per-project serialization every other
 * git operation already relies on, rather than inventing a second lock. While a `FETCH` is
 * QUEUED/RUNNING it is the project's one active operation, so a new user op is refused through the
 * normal, clean "operation in progress" path — never a raw git-lock crash. `FETCH` is intentionally
 * NOT in `CONTENT_CHANGING_GIT_OPERATION_KINDS`, so it never trips the file-tree/edit-session
 * write-lock: it blocks only the single-flight slot, briefly, and never file editing.
 *
 * Flow mirrors `createPullHandler`: load the connected `GitRepository` link; decrypt the stored
 * credential; run the use case with only `{ projectId, token }`. Both pre-conditions (missing
 * repository link, missing credential) are reported as a `failed` outcome rather than thrown — a
 * claimed operation must still reach a terminal state. The decrypted token is held no longer than
 * the `execute` call and is never logged, put in an error, or persisted here.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the fetch with.
 * @returns A `GitOperationHandler` ready to register under the `FETCH` `GitOperationKind`.
 */
export function createFetchHandler(deps: FetchHandlerDeps): (operation: GitOperation) => Promise<GitOperationOutcome> {
  const refreshRemoteStatus = new RefreshRemoteStatusUseCase(
    deps.gitRepositoryRepository,
    deps.commandRunner,
    deps.logger,
  );

  return async function fetchHandler(operation: GitOperation): Promise<GitOperationOutcome> {
    const gitRepository = await deps.gitRepositoryRepository.findByProjectId(operation.projectId);
    if (gitRepository === null) {
      return { kind: 'failed', errorCode: FETCH_REPOSITORY_NOT_FOUND_ERROR_CODE };
    }

    const credential = await deps.credentialSource.loadDecrypted(operation.projectId);
    if (credential === null) {
      return { kind: 'failed', errorCode: FETCH_CREDENTIAL_NOT_FOUND_ERROR_CODE };
    }

    const result = await refreshRemoteStatus.execute({ projectId: operation.projectId, token: credential.token });
    if (!result.success) {
      // An authentication failure means the remote rejected the stored credential: keep the
      // repository connected but mark it NEEDS_REAUTH so the background sweep skips it until the
      // credential is rotated. The not-CONFLICTED guard (an unresolved conflict the user must
      // resolve outweighs a re-auth prompt) and the row-gone safety (this multi-second fetch may
      // race a disconnect) both live atomically inside the conditional write itself — never a
      // stale-snapshot `save` upsert, which would rewrite every column from the pre-fetch load and,
      // being an upsert, could recreate a row deleted during the fetch. Every other failure leaves
      // the stored status untouched. The token is never logged, put in an error, or persisted here.
      if (result.error instanceof AuthenticationFailedError) {
        await deps.gitRepositoryRepository.markNeedsReauthUnlessConflicted(operation.projectId);
      }
      return { kind: 'failed', errorCode: mapFetchErrorToCode(result.error) };
    }

    return { kind: 'succeeded' };
  };
}
