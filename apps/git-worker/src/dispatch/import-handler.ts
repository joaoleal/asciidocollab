import type {
  AssetRepository,
  AuditLogRepository,
  DocumentRepository,
  DomainError,
  FileNodeRepository,
  GitCommandRunner,
  GitOperation,
  GitRepositoryRepository,
  Logger,
  ProjectFileStore,
  ProjectId,
  ProjectMemberRepository,
  ProjectRepository,
} from '@asciidocollab/domain';
import {
  AuthenticationFailedError,
  ImportRepositoryUseCase,
  RepositoryTooLargeError,
  RepositoryUnreachableError,
} from '@asciidocollab/domain';
import type { GitErrorCode } from '@asciidocollab/shared';
import type { GitOperationOutcome } from './git-operation-dispatcher.js';

/**
 * The credential store's decrypt-for-execution surface `createImportHandler` needs — a
 * structural subset of `PrismaGitCredentialStore.loadDecrypted` (`@asciidocollab/infrastructure`).
 * Named separately rather than importing that concrete adapter's type, so this module (and its
 * tests) can be built against a plain fake without depending on the adapter package.
 */
export interface ImportCredentialSource {
  /**
   * Reads back and decrypts the stored credential for a project.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token (plus its display hint), or null if the project has none.
   */
  loadDecrypted(projectId: ProjectId): Promise<{ readonly token: string; readonly tokenHint: string | null } | null>;
}

/** Safe, typed error code recorded when a claimed IMPORT operation has no `GitRepository` row to import against — a route/enqueue bug, not a user-facing refusal. */
export const IMPORT_REPOSITORY_NOT_FOUND_ERROR_CODE = 'IMPORT_REPOSITORY_NOT_FOUND';

/** Safe, typed error code recorded when a claimed IMPORT operation has no stored credential to decrypt — a route/enqueue bug, not a user-facing refusal. */
export const IMPORT_CREDENTIAL_NOT_FOUND_ERROR_CODE = 'IMPORT_CREDENTIAL_NOT_FOUND';

/** Safe, typed error code recorded for any import failure not covered by a more specific `GitErrorCode` (validation failures, generic command failures). Carries no internal detail. */
export const IMPORT_FAILED_ERROR_CODE = 'IMPORT_FAILED';

/** Every dependency `createImportHandler` closes over to run an `IMPORT` operation. */
export interface ImportHandlerDeps {
  /** Loads the pre-allocated project and writes it once its root folder is known. */
  projectRepository: ProjectRepository;
  /** Writes the project's root folder and cloned tree. */
  fileNodeRepository: FileNodeRepository;
  /** Writes a row for every cloned AsciiDoc/theme file. */
  documentRepository: DocumentRepository;
  /** Writes a row for every other cloned file. */
  assetRepository: AssetRepository;
  /**
   * Holds the cloned bytes. MUST resolve to the same filesystem location `apps/api`/`apps/collab`
   * read project content from (see `contentStorageRoot` in `config/git-worker-config.ts`) — this is
   * NOT the same root as the git working tree this worker itself manages.
   */
  fileStore: ProjectFileStore;
  /** Loads the pre-created repository link (for its remote/provider) and writes it back completed. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Clones the remote's tracked files. */
  commandRunner: GitCommandRunner;
  /** Writes the owner-membership row that commits the import. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records the successful import. */
  auditLogRepository: AuditLogRepository;
  /** Decrypts the stored credential at execution time — never the domain port's ciphertext-only `load()`. */
  credentialSource: ImportCredentialSource;
  /** Optional sink for best-effort failures that must stay visible. Never receives the decrypted token. */
  logger?: Logger;
}

/**
 * Maps a failed import's typed domain error to a safe, non-internal wire code: a `GitErrorCode`
 * member (`@asciidocollab/shared`) where one fits the error's category, or a stable
 * `IMPORT_FAILED_ERROR_CODE` for anything else (a rejected provider/remote-URL shape, or a
 * generic command failure) — never the error's own message, which may describe internals.
 */
function mapImportErrorToCode(error: DomainError): string {
  if (error instanceof RepositoryUnreachableError) {
    const code: GitErrorCode = 'repository_unreachable';
    return code;
  }
  if (error instanceof AuthenticationFailedError) {
    const code: GitErrorCode = 'authentication_failed';
    return code;
  }
  if (error instanceof RepositoryTooLargeError) {
    const code: GitErrorCode = 'repository_too_large';
    return code;
  }
  return IMPORT_FAILED_ERROR_CODE;
}

/**
 * Builds the `IMPORT` `GitOperationHandler`: runs `ImportRepositoryUseCase` against the `Project`
 * and `GitRepository` rows a route already created before ever enqueuing the operation.
 *
 * Flow: load the pre-created `GitRepository` link (its `provider`/`remoteUrl`); decrypt the stored
 * credential; run the use case with both plus the operation's actor/branch; map its `Result` to a
 * `GitOperationOutcome`. Both pre-conditions (missing repository link, missing credential) are
 * reported as a `failed` outcome rather than thrown — they are a bug in the route's synchronous
 * hand-off, not something this handler is positioned to recover from, but a claimed operation must
 * still reach a terminal state.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the import with.
 * @returns A `GitOperationHandler` ready to register under the `IMPORT` `GitOperationKind`.
 */
export function createImportHandler(deps: ImportHandlerDeps): (operation: GitOperation) => Promise<GitOperationOutcome> {
  const importRepository = new ImportRepositoryUseCase(
    deps.projectRepository,
    deps.fileNodeRepository,
    deps.documentRepository,
    deps.assetRepository,
    deps.fileStore,
    deps.gitRepositoryRepository,
    deps.commandRunner,
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.logger,
  );

  return async function importHandler(operation: GitOperation): Promise<GitOperationOutcome> {
    const gitRepository = await deps.gitRepositoryRepository.findByProjectId(operation.projectId);
    if (gitRepository === null) {
      return { kind: 'failed', errorCode: IMPORT_REPOSITORY_NOT_FOUND_ERROR_CODE };
    }

    const credential = await deps.credentialSource.loadDecrypted(operation.projectId);
    if (credential === null) {
      return { kind: 'failed', errorCode: IMPORT_CREDENTIAL_NOT_FOUND_ERROR_CODE };
    }

    const result = await importRepository.execute({
      actorId: operation.triggeredByUserId,
      projectId: operation.projectId,
      provider: gitRepository.provider.value,
      remoteUrl: gitRepository.remoteUrl,
      token: credential.token,
      branch: operation.branch ?? undefined,
    });

    if (!result.success) {
      return { kind: 'failed', errorCode: mapImportErrorToCode(result.error) };
    }

    return { kind: 'succeeded' };
  };
}
