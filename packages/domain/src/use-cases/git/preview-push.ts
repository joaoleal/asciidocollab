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
// Referenced only from this file's own JSDoc @link tag (never thrown directly here) — raised inside
// GitCommandRunner.previewPush; kept imported so the link resolves to a real symbol.
import type { GitCommandFailedError } from '../../errors/git/git-command-failed';

/** Everything `PreviewPushUseCase.execute` needs to preview what pushing a project's current branch would send out. */
export interface PreviewPushInput {
  /** The user asking for the preview. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose outgoing changes to preview. */
  readonly projectId: ProjectId;
  /** The branch to preview. Defaults to the project's current branch when omitted. */
  readonly branch?: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What `PreviewPushUseCase.execute` returns on success. */
export interface PreviewPushResult {
  /**
   * The commits that would land on the remote, newest first, if the push actually ran — the same
   * `HistoryCommit` shape `GetHistoryUseCase` returns, so the wire mapping is identical.
   */
  readonly outgoingCommits: readonly HistoryCommit[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/**
 * Previews what pushing a project's current branch would send out: the commits and touched paths
 * between the already-fetched remote-tracking ref and the local branch — WITHOUT pushing,
 * committing, or otherwise changing anything. Purely local: no network, no credential, unlike
 * `PreviewPullUseCase`. This is a dry run; unlike `PushChangesUseCase`, it never contacts the remote
 * and never updates the project's `GitRepository` link.
 *
 * Still EDITOR-gated, the same tier `PushChangesUseCase` requires — kept consistent with the pull
 * preview even though this preview itself needs no credential. Read-only and lock-free — a preview
 * never mutates the project, so it takes no single-flight guard.
 */
export class PreviewPushUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial (via `requireGitRole`).
   * @param gitRepositoryRepo - Loads the project's repository link (its current branch).
   * @param commandRunner - Reads the outgoing commits/paths.
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
   * Previews `input.projectId`'s outgoing changes.
   *
   * @param input - The acting user, the project, and the optional branch.
   * @returns The outgoing commits and changed paths on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository, or the
   *   `GitCommandFailedError` the preview read itself fails with.
   */
  async execute(input: PreviewPushInput): Promise<Result<PreviewPushResult, DomainError>> {
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

    const previewResult = await this.commandRunner.previewPush(input.projectId, {
      branch: input.branch ?? repository.currentBranch,
    });
    if (!previewResult.success) return previewResult;

    const authorUserIdByEmail = new Map<string, UserId | undefined>();
    for (const commit of previewResult.value.outgoing) {
      if (authorUserIdByEmail.has(commit.authorEmail)) continue;
      authorUserIdByEmail.set(commit.authorEmail, await this.resolveAuthor(commit.authorEmail));
    }

    const outgoingCommits: HistoryCommit[] = previewResult.value.outgoing.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      authorUserId: authorUserIdByEmail.get(commit.authorEmail),
      authoredAt: commit.authoredAt,
    }));

    return {
      success: true,
      value: { outgoingCommits, changedPaths: previewResult.value.changedPaths },
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
