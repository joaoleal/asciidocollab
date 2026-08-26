import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { Email } from '../../value-objects/identity/email';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { UserRepository } from '../../ports/user/user.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { requireGitRole } from './git-role-guard';
import { HistoryCommit } from './get-history';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
// Referenced only from this file's own JSDoc @link tags (never thrown directly here) — each is
// raised inside GitCommandRunner.previewPull; kept imported so the links resolve to real symbols.
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import type { GitCommandFailedError } from '../../errors/git/git-command-failed';

/**
 * Everything `PreviewPullUseCase.execute` needs to preview what pulling a project's current branch
 * would bring in. Like `PullChangesUseCase`, this never touches the credential store — the caller
 * (the git-worker's internal RPC binding) has already loaded and decrypted the stored credential and
 * hands the plaintext token straight through here.
 */
export interface PreviewPullInput {
  /** The user asking for the preview. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose incoming changes to preview. */
  readonly projectId: ProjectId;
  /**
   * The plaintext access token to authenticate the fetch with. Passed straight through to
   * `GitCommandRunner.previewPull` and never persisted or logged here.
   */
  readonly token: string;
  /** The branch to preview. Defaults to the project's current branch when omitted. */
  readonly branch?: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What `PreviewPullUseCase.execute` returns on success. */
export interface PreviewPullResult {
  /**
   * The commits that would land locally, newest first, if the pull actually ran — the same
   * `HistoryCommit` shape `GetHistoryUseCase` returns, so the wire mapping is identical.
   */
  readonly incomingCommits: readonly HistoryCommit[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/**
 * Previews what pulling a project's current branch would bring in: a LIVE fetch (so the preview
 * reflects the remote's current state, exactly like `PullChangesUseCase` itself fetches), then the
 * commits and touched paths between the local branch and the freshly-fetched remote-tracking ref —
 * WITHOUT merging, committing, flushing open documents, or otherwise changing anything. This is a
 * dry run: unlike `PullChangesUseCase`, it never lands a change-set and never records a
 * `GitConflict`.
 *
 * EDITOR-gated, the same tier `PullChangesUseCase` requires: the live fetch authenticates with the
 * project's stored credential exactly like a real pull, so this is NOT a plain read-only
 * status/history/diff/blame check that every project member may run. Read-only and lock-free all the
 * same — a preview never mutates the project, so it takes no single-flight guard.
 */
export class PreviewPullUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial (via `requireGitRole`).
   * @param gitRepositoryRepo - Loads the project's repository link (its remote URL and current branch).
   * @param commandRunner - Runs the fetch and reads the incoming commits/paths.
   * @param userRepo - Resolves a commit author's email to a platform user, when one exists.
   * @param logger - Optional sink for best-effort diagnostics/audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly userRepo: UserRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Previews `input.projectId`'s incoming changes, using `input.token` to authenticate the fetch.
   *
   * @param input - The acting user, the project, the credential to fetch with, and the optional branch.
   * @returns The incoming commits and changed paths on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the fetch could not
   *   reach the remote or the credential was rejected, or a {@link GitCommandFailedError} for any
   *   other failure.
   */
  async execute(input: PreviewPullInput): Promise<Result<PreviewPullResult, DomainError>> {
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

    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const previewResult = await this.commandRunner.previewPull(input.projectId, {
      remoteUrl: repository.remoteUrl,
      token: input.token,
      branch: input.branch ?? repository.currentBranch,
    });
    if (!previewResult.success) return previewResult;

    const authorUserIdByEmail = new Map<string, UserId | undefined>();
    for (const commit of previewResult.value.incoming) {
      if (authorUserIdByEmail.has(commit.authorEmail)) continue;
      authorUserIdByEmail.set(commit.authorEmail, await this.resolveAuthor(commit.authorEmail));
    }

    const incomingCommits: HistoryCommit[] = previewResult.value.incoming.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      authorUserId: authorUserIdByEmail.get(commit.authorEmail),
      authoredAt: commit.authoredAt,
    }));

    return {
      success: true,
      value: { incomingCommits, changedPaths: previewResult.value.changedPaths },
    };
  }

  /**
   * Resolves a single commit author email to a platform `UserId`, or undefined when it maps to no
   * user or is not a well-formed email — a single odd author email (e.g. imported history) never
   * fails the whole preview.
   */
  private async resolveAuthor(authorEmail: string): Promise<UserId | undefined> {
    try {
      const email = Email.create(authorEmail);
      const user = await this.userRepo.findByEmail(email);
      return user?.id;
    } catch (error) {
      this.logger?.warn('Could not resolve commit author email to a platform user', { error, authorEmail });
      return undefined;
    }
  }
}
