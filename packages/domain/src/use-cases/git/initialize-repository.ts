import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitProvider } from '../../value-objects/project/git-provider';
import { GitRepository } from '../../entities/git-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { ValidationError } from '../../errors/common/validation-error';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { GitOperationInProgressError } from '../../errors/git/git-operation-in-progress';
import { InsufficientRoleError } from '../../errors/git/insufficient-role';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_REPOSITORY_CONNECTED } from '../../audit-actions';
// Referenced only from this file's own JSDoc @link tags (never thrown directly here) — all three
// are raised inside GitCommandRunner.initializeAndPublish, kept imported so the links resolve.
import type { RemoteAlreadyInitializedError } from '../../errors/git/remote-already-initialized';
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';

/**
 * A remote URL this use case will accept, identical to `ConnectRepository`'s own check (a
 * defense-in-depth boundary check; the Fastify route schema and the git-worker runner each
 * validate independently before the value reaches an actual `git` invocation).
 */
const VALID_REMOTE_URL_PATTERN = /^(?:https?:\/\/|git@)[^\s;|&`$]+$/;

/** Everything `InitializeRepositoryUseCase.execute` needs to publish an existing project to a fresh remote. */
export interface InitializeRepositoryInput {
  /** The user asking to initialize and publish the project. Must be the project's OWNER. */
  readonly actorId: UserId;
  /** The project to publish. Must not already have a `GitRepository` link. */
  readonly projectId: ProjectId;
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  readonly provider: string;
  /** The remote repository's URL. Must be empty (no commits) — a non-empty remote is refused. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Never persisted here — the route/worker hand-off owns the credential store. */
  readonly token: string;
  /** The branch to publish under. Defaults to `'main'` when omitted. */
  readonly branch?: string;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/** What a successful initialize-and-publish hands back to its caller. */
export interface InitializeRepositoryResult {
  /** The newly created repository link, reflecting what the publish observed. */
  readonly repository: GitRepository;
}

/**
 * Runs an already-enqueued initialize to completion: initializes git on an existing (previously
 * non-git) project's working tree and publishes it to a fresh, empty remote — an initial commit of
 * the project's current files, pushed to the given remote. Refuses outright — never overwriting
 * remote history — when the remote already has any commits; the caller is expected to guide the
 * user to import/pull that remote's existing content instead (`ImportRepositoryUseCase`).
 *
 * Mirrors `ImportRepositoryUseCase`'s pre-created-row contract: `initialize` is asynchronous
 * (`202 {operationId}`, per the REST contract) because init+push is network-bound, so this runs in
 * a later worker turn, not synchronously in the route. A `GitOperation` carries only
 * `{projectId, kind, triggeredByUserId, branch}` across that hand-off — no `remoteUrl`/`provider` —
 * so the route pre-creates a `GitRepository` placeholder row (exactly as it pre-creates import's
 * `Project`/`GitRepository` rows) before ever enqueuing the operation; a worker handler loads it,
 * decrypts the stored credential, and passes both into this use case's `input`. This use case UPDATES
 * that pre-created row in place on success — it never inserts a second row — and treats the row's
 * absence as a route/enqueue bug (a `GitCommandFailedError`), not a user-facing refusal.
 *
 * OWNER-gated (data-model.md's git authorization matrix), for the same reason `ConnectRepository`
 * is: publishing to a remote grants every future EDITOR collaborator the ability to push under this
 * credential, so only the project's OWNER may establish it. The route (defense-in-depth) is
 * expected to gate the same way before ever pre-creating the placeholder row or enqueuing.
 *
 * All-or-nothing: the pre-created row is written back to its connected state only after
 * `GitCommandRunner.initializeAndPublish` succeeds. Any adapter failure — the remote already has
 * commits, is unreachable, rejects the credential, or any other git-command failure — leaves the
 * placeholder row untouched and records no success audit entry; cleaning it up (or leaving it
 * retryable) is the worker handler's job, mirroring import's abandoned-run handling.
 */
export class InitializeRepositoryUseCase {
  /**
   * @param gitRepositoryRepo - Loads the pre-created placeholder link and writes it back completed.
   * @param commandRunner - Runs the atomic init → remote-add → initial-commit → push sequence
   *   against the remote.
   * @param gitOperationRepo - Single-flight guard so an initialize cannot race another git action.
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful publish.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Initializes and publishes the project to the given remote.
   *
   * @param input - The acting user, the project, and the remote/credential to publish to (the
   *   remote/provider are expected to match the pre-created row's own fields — the worker handler
   *   reads them off that row and passes them straight through).
   * @returns The updated repository link on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not the project's OWNER, a
   *   {@link ValidationError} for an unrecognized provider or malformed remote URL, a
   *   {@link GitCommandFailedError} when no pre-created repository link exists for the project (a
   *   route/enqueue bug) or for any other git-command failure,
   *   {@link RemoteAlreadyInitializedError} when the remote already has commits,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the publish fails to
   *   reach or authenticate against the remote, or {@link GitOperationInProgressError} when another
   *   git action is already in flight for this project.
   */
  async execute(
    input: InitializeRepositoryInput,
  ): Promise<Result<InitializeRepositoryResult, DomainError>> {
    const roleCheck = await requireGitRole(
      this.projectMemberRepo,
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        requiredRole: 'owner',
        context: input.context,
      },
      this.logger,
    );
    if (!roleCheck.success) return roleCheck;

    let provider: GitProvider;
    try {
      provider = GitProvider.create(input.provider);
    } catch (error) {
      if (error instanceof DomainError) return { success: false, error };
      throw error;
    }

    if (!VALID_REMOTE_URL_PATTERN.test(input.remoteUrl)) {
      return {
        success: false,
        error: new ValidationError(`Invalid Git remote URL: ${input.remoteUrl}`),
      };
    }

    // The route pre-creates this placeholder row before ever enqueuing the operation (the only
    // no-migration way to carry `remoteUrl`/`provider` across the enqueue boundary to this later
    // worker turn — a `GitOperation` carries neither). Its absence here is a bug in that hand-off,
    // not a user-facing refusal, and nothing has been written yet for a failure at this point to
    // clean up.
    const existing = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (existing === null) {
      return {
        success: false,
        error: new GitCommandFailedError(
          `No pre-created repository link exists for project ${input.projectId.value}`,
        ),
      };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.publishWhileGuarded(input, provider, existing),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Runs the atomic publish and, on success only, writes the pre-created repository link back to
   * its connected state — the part of the flow held under the project's single-flight guard. On
   * any adapter failure, the placeholder row is left exactly as it was: no success audit either.
   */
  private async publishWhileGuarded(
    input: InitializeRepositoryInput,
    provider: GitProvider,
    existing: GitRepository,
  ): Promise<Result<InitializeRepositoryResult, DomainError>> {
    const publishResult = await this.commandRunner.initializeAndPublish(input.projectId, {
      remoteUrl: input.remoteUrl,
      token: input.token,
      branch: input.branch,
    });
    if (!publishResult.success) return publishResult;

    // Reuses the loaded row's own id, provider, remote URL, and credential reference — the link
    // itself already exists; this write is what completes it with what the publish observed.
    const updatedRepository = new GitRepository(
      existing.id,
      existing.projectId,
      existing.provider,
      existing.remoteUrl,
      existing.credentialReference,
      publishResult.value.defaultBranch,
      'UP_TO_DATE',
      publishResult.value.defaultBranch,
      publishResult.value.headCommit,
      new Date(),
      existing.createdAt,
      existing.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updatedRepository);

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_REPOSITORY_CONNECTED,
        resourceType: 'GitRepository',
        resourceId: updatedRepository.id.value,
        metadata: { provider: provider.value },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { repository: updatedRepository } };
  }
}
