import {
  ConnectRepositoryUseCase,
  PreviewPullUseCase,
  PreviewPushUseCase,
  RepositoryNotConnectedError,
  ProjectId,
  UserId,
  type GitRepositoryRepository,
  type GitCredentialStore,
  type GitCommandRunner,
  type GitOperationRepository,
  type ProjectMemberRepository,
  type UserRepository,
  type AuditLogRepository,
  type Logger,
  type DomainError,
  type Result,
} from '@asciidocollab/domain';
import type {
  ConnectRepositoryWireResult,
  ConnectRequest,
  PreviewRequest,
  PreviewPullWireResult,
  PreviewPushWireResult,
} from './internal-git-server.js';
import { mapGitRepositoryToWire, mapHistoryCommitsToWire } from './git-wire-mappers.js';

/**
 * The internal RPC server's op-fn adapters: each constructs its use case from injected deps, runs
 * it against a validated wire request, and maps a success onto the wire-shaped result the domain
 * result itself can't safely `JSON.stringify` (value-object ids, `Date`s) — see
 * `internal-git-wire.ts` for why that mapping exists. `composition-root.ts` calls these factories
 * with the real adapters; tests call them with fakes, without needing a real database.
 */

/** Every dependency the connect op fn needs to construct and run `ConnectRepositoryUseCase`. */
export interface ConnectOpDeps {
  /** Persists the project's `GitRepository` link. */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Encrypts and persists the access credential. */
  gitCredentialStore: GitCredentialStore;
  /** Runs the connectivity/authentication check against the remote. */
  gitCommandRunner: GitCommandRunner;
  /** Single-flight guard so a connect cannot race another git action. */
  gitOperationRepository: GitOperationRepository;
  /** Resolves the actor's role for the use case's own OWNER-gate check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records the authorization denial and the successful connection. */
  auditLogRepository: AuditLogRepository;
  /** Optional sink for best-effort audit-write failures. */
  logger?: Logger;
}

/**
 * Builds the connect internal-RPC op fn: constructs `ConnectRepositoryUseCase` from the given
 * deps, runs it, and maps a success onto the wire-shaped `{ repository }` envelope via
 * {@link mapGitRepositoryToWire}. Separated from {@link compositionRoot} (mirroring
 * `createInitializeHandler`'s own deps-taking factory) so it can be exercised directly against
 * fakes in tests, without needing a real database.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the connect with.
 * @returns The op fn ready to bind onto `GitOpsHandlerDeps.connect`.
 */
export function createConnectOpFunction(
  deps: ConnectOpDeps,
): (request: ConnectRequest) => Promise<Result<ConnectRepositoryWireResult, DomainError>> {
  const connectRepository = new ConnectRepositoryUseCase(
    deps.gitRepositoryRepository,
    deps.gitCredentialStore,
    deps.gitCommandRunner,
    deps.gitOperationRepository,
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.logger,
  );

  return async (request: ConnectRequest): Promise<Result<ConnectRepositoryWireResult, DomainError>> => {
    const result = await connectRepository.execute({
      actorId: UserId.create(request.actorId),
      projectId: ProjectId.create(request.projectId),
      provider: request.provider,
      remoteUrl: request.remoteUrl,
      token: request.token,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
    });
    if (!result.success) return result;
    return { success: true, value: { repository: mapGitRepositoryToWire(result.value.repository) } };
  };
}

/**
 * The credential store's decrypt-for-execution surface the preview-pull op fn needs — a structural
 * subset of `PrismaGitCredentialStore.loadDecrypted` (`@asciidocollab/infrastructure`), matching
 * `PullCredentialSource`/`PushCredentialSource` (`dispatch/pull-handler.ts`/`dispatch/push-handler.ts`).
 * Named separately, rather than importing that concrete adapter's type or the domain port (whose
 * `load()` never hands back plaintext), so this module (and its tests) can be built against a plain
 * fake without depending on the adapter package. A pull preview has no separate dispatch handler to
 * resolve this ahead of time (it is a sync RPC, not a queued `GitOperation`) — this op fn IS that
 * resolving step.
 */
export interface PreviewPullCredentialSource {
  /**
   * Reads back and decrypts the stored credential for a project.
   *
   * @param projectId - The project whose credential to decrypt.
   * @returns The decrypted token (plus its display hint), or null if the project has none.
   */
  loadDecrypted(projectId: ProjectId): Promise<{ readonly token: string; readonly tokenHint: string | null } | null>;
}

/** Every dependency the preview-pull op fn needs to construct and run `PreviewPullUseCase`. */
export interface PreviewPullOpDeps {
  /** Resolves the actor's role for the use case's own editor-gate check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records the authorization denial. */
  auditLogRepository: AuditLogRepository;
  /** Loads the project's repository link (its remote URL and current branch). */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Runs the fetch and reads the incoming commits/paths. */
  gitCommandRunner: GitCommandRunner;
  /** Resolves a commit author's email to a platform user, when one exists. */
  userRepository: UserRepository;
  /** Decrypts the stored credential at execution time — never the domain port's ciphertext-only `load()`. */
  gitCredentialStore: PreviewPullCredentialSource;
  /** Optional sink for best-effort diagnostics/audit-write failures. */
  logger?: Logger;
}

/**
 * Builds the preview-pull internal-RPC op fn: decrypts the project's stored credential, constructs
 * `PreviewPullUseCase` from the given deps, runs it, and maps a success onto the wire-shaped result
 * via {@link mapHistoryCommitsToWire}. A missing stored credential (a project with no connected
 * repository, or one whose credential was somehow lost) is reported the same way the use case itself
 * reports a missing `GitRepository` link — `RepositoryNotConnectedError` — since a repository link
 * without a usable credential cannot preview a pull either way.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the preview with.
 * @returns The op fn ready to bind onto `GitOpsHandlerDeps.previewPull`.
 */
export function createPreviewPullOpFunction(
  deps: PreviewPullOpDeps,
): (request: PreviewRequest) => Promise<Result<PreviewPullWireResult, DomainError>> {
  const previewPull = new PreviewPullUseCase(
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.gitRepositoryRepository,
    deps.gitCommandRunner,
    deps.userRepository,
    deps.logger,
  );

  return async (request: PreviewRequest): Promise<Result<PreviewPullWireResult, DomainError>> => {
    const projectId = ProjectId.create(request.projectId);

    const credential = await deps.gitCredentialStore.loadDecrypted(projectId);
    if (credential === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const result = await previewPull.execute({
      actorId: UserId.create(request.actorId),
      projectId,
      token: credential.token,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
    });
    if (!result.success) return result;

    return {
      success: true,
      value: {
        incomingCommits: mapHistoryCommitsToWire(result.value.incomingCommits),
        changedPaths: [...result.value.changedPaths],
      },
    };
  };
}

/** Every dependency the preview-push op fn needs to construct and run `PreviewPushUseCase`. */
export interface PreviewPushOpDeps {
  /** Resolves the actor's role for the use case's own editor-gate check. */
  projectMemberRepository: ProjectMemberRepository;
  /** Records the authorization denial. */
  auditLogRepository: AuditLogRepository;
  /** Loads the project's repository link (its current branch). */
  gitRepositoryRepository: GitRepositoryRepository;
  /** Reads the outgoing commits/paths. */
  gitCommandRunner: GitCommandRunner;
  /** Resolves a commit author's email to a platform user, when one exists. */
  userRepository: UserRepository;
  /** Optional sink for best-effort diagnostics/audit-write failures. */
  logger?: Logger;
}

/**
 * Builds the preview-push internal-RPC op fn: constructs `PreviewPushUseCase` from the given deps,
 * runs it, and maps a success onto the wire-shaped result via {@link mapHistoryCommitsToWire}. Needs
 * no credential — purely local, unlike the pull preview.
 *
 * @param deps - The adapters (real, in the composition root; fakes, in tests) to run the preview with.
 * @returns The op fn ready to bind onto `GitOpsHandlerDeps.previewPush`.
 */
export function createPreviewPushOpFunction(
  deps: PreviewPushOpDeps,
): (request: PreviewRequest) => Promise<Result<PreviewPushWireResult, DomainError>> {
  const previewPush = new PreviewPushUseCase(
    deps.projectMemberRepository,
    deps.auditLogRepository,
    deps.gitRepositoryRepository,
    deps.gitCommandRunner,
    deps.userRepository,
    deps.logger,
  );

  return async (request: PreviewRequest): Promise<Result<PreviewPushWireResult, DomainError>> => {
    const result = await previewPush.execute({
      actorId: UserId.create(request.actorId),
      projectId: ProjectId.create(request.projectId),
      ...(request.branch === undefined ? {} : { branch: request.branch }),
    });
    if (!result.success) return result;

    return {
      success: true,
      value: {
        outgoingCommits: mapHistoryCommitsToWire(result.value.outgoingCommits),
        changedPaths: [...result.value.changedPaths],
      },
    };
  };
}
