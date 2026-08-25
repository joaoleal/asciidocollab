import { randomUUID } from 'crypto';
import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepositoryId } from '../../value-objects/ids/git-repository-id';
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
import { RepositoryAlreadyConnectedError } from '../../errors/git/repository-already-connected';
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
 * Initializes git on an existing (previously non-git) project's working tree and publishes it to
 * a fresh, empty remote: an initial commit of the project's current files, pushed to the given
 * remote. Refuses outright — never overwriting remote history — when the remote already has any
 * commits; the caller is expected to guide the user to import/pull that remote's existing content
 * instead (`ImportRepositoryUseCase`).
 *
 * OWNER-gated (data-model.md's git authorization matrix), for the same reason `ConnectRepository`
 * is: publishing to a remote grants every future EDITOR collaborator the ability to push under
 * this credential, so only the project's OWNER may establish it.
 *
 * All-or-nothing: the `GitRepository` link is created only after `GitCommandRunner
 * .initializeAndPublish` succeeds. Any adapter failure — the remote already has commits, is
 * unreachable, rejects the credential, or any other git-command failure — leaves no
 * `GitRepository` row behind and records no success audit entry.
 */
export class InitializeRepositoryUseCase {
  /**
   * @param gitRepositoryRepo - Loads the project's existing link (if any) and persists the new one.
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
   * @param input - The acting user, the project, and the remote/credential to publish to.
   * @returns The created repository link on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not the project's OWNER, a
   *   {@link ValidationError} for an unrecognized provider or malformed remote URL,
   *   {@link RepositoryAlreadyConnectedError} when the project already has a repository link,
   *   {@link RemoteAlreadyInitializedError} when the remote already has commits,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the publish fails
   *   to reach or authenticate against the remote, a `GitCommandFailedError` for any other git
   *   failure, or {@link GitOperationInProgressError} when another git action is already in flight
   *   for this project.
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

    // Checked here, ahead of any adapter/network work, so a project already linked to a remote is
    // a typed refusal rather than a storage-layer unique-constraint error surfacing from
    // `gitRepositoryRepo.save` (the entity's 1:1 relationship with a project).
    const existing = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (existing !== null) {
      return { success: false, error: new RepositoryAlreadyConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.publishWhileGuarded(input, provider),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Runs the atomic publish and, on success only, creates the repository link — the part of the
   * flow held under the project's single-flight guard. On any adapter failure, nothing is
   * persisted: no `GitRepository` row, no success audit.
   */
  private async publishWhileGuarded(
    input: InitializeRepositoryInput,
    provider: GitProvider,
  ): Promise<Result<InitializeRepositoryResult, DomainError>> {
    const publishResult = await this.commandRunner.initializeAndPublish(input.projectId, {
      remoteUrl: input.remoteUrl,
      token: input.token,
      branch: input.branch,
    });
    if (!publishResult.success) return publishResult;

    const repository = new GitRepository(
      GitRepositoryId.create(randomUUID()),
      input.projectId,
      provider,
      input.remoteUrl,
      // The credential store is keyed by projectId (one credential per project), so the
      // project id itself is the reference the repository link needs to find it back.
      input.projectId.value,
      publishResult.value.defaultBranch,
      'UP_TO_DATE',
      publishResult.value.defaultBranch,
      publishResult.value.headCommit,
      new Date(),
      new Date(),
      input.actorId,
    );
    await this.gitRepositoryRepo.save(repository);

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_REPOSITORY_CONNECTED,
        resourceType: 'GitRepository',
        resourceId: repository.id.value,
        metadata: { provider: provider.value },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { repository } };
  }
}
