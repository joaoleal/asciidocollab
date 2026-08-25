import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { Email } from '../../value-objects/identity/email';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitCommandRunner } from '../../ports/git/git-command-runner';
import { UserRepository } from '../../ports/user/user.repository';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';

/** Everything `GetHistoryUseCase.execute` needs to read a project's (or a single file's) commit history. */
export interface GetHistoryInput {
  /** The project whose history to read. */
  readonly projectId: ProjectId;
  /** When given, restricts the history to the commits that touched this single project-relative file. */
  readonly path?: string;
  /** When given, caps the number of commits returned. */
  readonly limit?: number;
}

/**
 * One commit in a project's (or a single file's) history, with its git author email already
 * resolved to a platform user where possible. Mirrors the shape of the wire-level `CommitDto` —
 * `authorUserId` is absent/undefined for an author email that maps to no platform user (for
 * example, imported history authored outside the platform).
 */
export interface HistoryCommit {
  /** The commit hash. */
  readonly hash: string;
  /** The commit message. */
  readonly message: string;
  /** The platform user the commit's author email resolved to, or undefined when unmapped. */
  readonly authorUserId?: UserId;
  /** When the commit was authored. */
  readonly authoredAt: Date;
}

/** What `GetHistoryUseCase.execute` returns on success. */
export interface GetHistoryResult {
  /** The matching commits, newest first — the same ordering `GitCommandRunner.log` returns. */
  readonly commits: readonly HistoryCommit[];
}

/**
 * Reads a project's commit history (or, with `path`, a single file's history), resolving each
 * commit's raw git author email to a platform `UserId` where one exists.
 *
 * Read-only and lock-free — this is a local git-log read, not a mutating git action, so it
 * takes no single-flight guard and enforces no role beyond what the calling route requires.
 */
export class GetHistoryUseCase {
  /**
   * @param gitRepositoryRepo - Loads the project's repository link.
   * @param commandRunner - Reads the project's (or a single file's) commit history.
   * @param userRepo - Resolves a commit author's email to a platform user, when one exists.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly userRepo: UserRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Reads the commit history for `input.projectId`, optionally scoped to `input.path` and capped
   * at `input.limit`.
   *
   * @param input - The project (and optional path/limit) whose history to read.
   * @returns The matching commits, newest first, on success; a {@link RepositoryNotConnectedError}
   *   when the project has no repository link, or the `GitCommandFailedError` the history read
   *   itself fails with.
   */
  async execute(input: GetHistoryInput): Promise<Result<GetHistoryResult, DomainError>> {
    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const logResult = await this.commandRunner.log(input.projectId, {
      path: input.path,
      limit: input.limit,
    });
    if (!logResult.success) return logResult;

    const authorUserIdByEmail = new Map<string, UserId | undefined>();
    for (const commit of logResult.value) {
      if (authorUserIdByEmail.has(commit.authorEmail)) continue;
      authorUserIdByEmail.set(commit.authorEmail, await this.resolveAuthor(commit.authorEmail));
    }

    const commits: HistoryCommit[] = logResult.value.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      authorUserId: authorUserIdByEmail.get(commit.authorEmail),
      authoredAt: commit.authoredAt,
    }));

    return { success: true, value: { commits } };
  }

  /**
   * Resolves a single commit author email to a platform `UserId`, or undefined when it maps to no
   * user or is not a well-formed email — a single odd author email (e.g. imported history) never
   * fails the whole history read.
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
