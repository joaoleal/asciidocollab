import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitRepository } from '../../entities/git-repository';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
// Referenced only from this file's own JSDoc @link tags (never thrown directly here) — each is
// raised inside GitCommandRunner.push; kept imported so the links resolve to real symbols.
import type { NonFastForwardError } from '../../errors/git/non-fast-forward';
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import type { GitCommandFailedError } from '../../errors/git/git-command-failed';

/**
 * Everything `PushChangesUseCase.execute` needs to push a project's current branch to its remote.
 * Unlike `ConnectRepository`/`ImportRepository`, this use case never touches the credential store —
 * the caller (the git-worker run loop, for a `PUSH` `GitOperation`) has already loaded and decrypted
 * the stored credential by the time this runs, and hands the plaintext token straight through here.
 */
export interface PushChangesInput {
  /** The user who triggered the push. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose current branch to push. */
  readonly projectId: ProjectId;
  /**
   * The plaintext access token to authenticate with. Passed straight through to
   * `GitCommandRunner.push` and never persisted or logged here.
   */
  readonly token: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful push hands back. */
export interface PushChangesResult {
  /** The commit now at the tip of the remote branch, after the push landed. */
  readonly headCommit: string;
}

/**
 * Pushes a project's current branch to its remote.
 *
 * Push is an ASYNC LONG git action, unlike `StageChanges`/`CommitChanges` (synchronous short/whole-
 * project ops): it runs from the git-worker queue, which claims its `GitOperation` row as `RUNNING`
 * before this use case ever executes. That claimed row IS the project's single-flight guard for the
 * duration of the push — a `RUNNING` push already makes `StageChanges`/`CommitChanges`'s own
 * `withGuard` call return `GitOperationInProgressError` — so this use case takes NO guard of its
 * own, exactly as `ImportRepositoryUseCase` does not (the difference there is the route's
 * synchronous project allocation; here it is the queue claim).
 *
 * Still self-gates role (data-model.md lists push under EDITOR) as defense-in-depth: the route
 * gates before enqueuing, but project membership can change in the time between enqueue and the
 * worker actually claiming and running the operation.
 */
export class PushChangesUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Loads the project's repository link and writes it back on success.
   * @param commandRunner - Runs the actual push.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly logger?: Logger,
  ) {}

  /**
   * Pushes `input.projectId`'s current branch to its remote, using `input.token` to authenticate.
   *
   * @param input - The acting user, the project, and the credential to push with.
   * @returns The remote branch's new tip commit on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link NonFastForwardError} when the remote has commits this branch does not,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the remote could not
   *   be reached or rejected the credential, or a {@link GitCommandFailedError} for any other
   *   failure. Every failure leaves the project's `GitRepository` link untouched.
   */
  async execute(input: PushChangesInput): Promise<Result<PushChangesResult, DomainError>> {
    const roleCheck = await requireGitRole(
      this.projectMemberRepo,
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        requiredRole: 'editor',
        context: input.context,
      },
      this.logger,
    );
    if (!roleCheck.success) return roleCheck;

    const gitRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (gitRepository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const pushResult = await this.commandRunner.push(input.projectId, {
      remoteUrl: gitRepository.remoteUrl,
      token: input.token,
      branch: gitRepository.currentBranch,
    });
    if (!pushResult.success) return pushResult;

    // Reuses the loaded row's own id, provider, remote URL, credential reference, branch, default
    // branch, and creation metadata — this write only completes the fields the push observed.
    const updatedRepository = new GitRepository(
      gitRepository.id,
      gitRepository.projectId,
      gitRepository.provider,
      gitRepository.remoteUrl,
      gitRepository.credentialReference,
      gitRepository.currentBranch,
      'UP_TO_DATE',
      gitRepository.defaultBranch,
      pushResult.value.headCommit,
      new Date(),
      gitRepository.createdAt,
      gitRepository.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updatedRepository);

    return { success: true, value: { headCommit: pushResult.value.headCommit } };
  }
}
