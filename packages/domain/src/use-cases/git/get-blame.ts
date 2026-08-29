import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { Email } from '../../value-objects/identity/email';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitReadPort } from '../../ports/git/git-command-runner';
import { UserRepository } from '../../ports/user/user.repository';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { Logger } from '../../ports/observability/logger';
import { Result } from '../../types/result';

/** Everything `GetBlameUseCase.execute` needs to read a single file's per-line authorship. */
export interface GetBlameInput {
  /** The project whose file to blame. */
  readonly projectId: ProjectId;
  /** The project-relative path of the file to blame. */
  readonly path: string;
  /** When given, blames the file as of this commit; without it, the current working-tree file. */
  readonly ref?: string;
}

/**
 * One line of a blamed file, with its git author email already resolved to a platform user where
 * possible. Mirrors the shape of the wire-level `BlameDto` — `authorUserId` is absent/undefined
 * for an author email that maps to no platform user (for example, imported history authored
 * outside the platform).
 */
export interface BlameLine {
  /** 1-based line number in the blamed file. */
  readonly lineNumber: number;
  /** The full hash of the commit that last modified this line. */
  readonly hash: string;
  /** The subject/summary line of that commit (may be empty). */
  readonly message: string;
  /** The platform user the line's author email resolved to, or undefined when unmapped. */
  readonly authorUserId?: UserId;
  /** When the line's commit was authored. */
  readonly authoredAt: Date;
  /** The line's text content. */
  readonly content: string;
}

/** What `GetBlameUseCase.execute` returns on success. */
export interface GetBlameResult {
  /** Every line's authorship, in file order — the same ordering `GitCommandRunner.blame` returns. */
  readonly lines: readonly BlameLine[];
}

/**
 * Reads a single project-relative file's per-line authorship (a "blame"), resolving each line's
 * raw git author email to a platform `UserId` where one exists.
 *
 * Read-only and lock-free — this is a local git-blame read, not a mutating git action, so it
 * takes no single-flight guard and enforces no role beyond what the calling route requires.
 */
export class GetBlameUseCase {
  /**
   * @param gitRepositoryRepo - Loads the project's repository link.
   * @param commandRunner - Reads the file's per-line authorship.
   * @param userRepo - Resolves a line author's email to a platform user, when one exists.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitReadPort,
    private readonly userRepo: UserRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Reads the per-line authorship for `input.path`, optionally as of `input.ref`.
   *
   * @param input - The project, the file path to blame, and the optional commit to blame it as of.
   * @returns Every line's authorship, in file order, on success; a {@link RepositoryNotConnectedError}
   *   when the project has no repository link, or the `GitCommandFailedError` the blame read itself
   *   fails with.
   */
  async execute(input: GetBlameInput): Promise<Result<GetBlameResult, DomainError>> {
    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const blameResult = await this.commandRunner.blame(input.projectId, {
      path: input.path,
      ref: input.ref,
    });
    if (!blameResult.success) return blameResult;

    const authorUserIdByEmail = new Map<string, UserId | undefined>();
    for (const line of blameResult.value) {
      if (authorUserIdByEmail.has(line.authorEmail)) continue;
      authorUserIdByEmail.set(line.authorEmail, await this.resolveAuthor(line.authorEmail));
    }

    const lines: BlameLine[] = blameResult.value.map((line) => ({
      lineNumber: line.lineNumber,
      hash: line.hash,
      message: line.message,
      authorUserId: authorUserIdByEmail.get(line.authorEmail),
      authoredAt: line.authoredAt,
      content: line.content,
    }));

    return { success: true, value: { lines } };
  }

  /**
   * Resolves a single line's author email to a platform `UserId`, or undefined when it maps to no
   * user or is not a well-formed email — a single odd author email (e.g. imported history) never
   * fails the whole blame read.
   */
  private async resolveAuthor(authorEmail: string): Promise<UserId | undefined> {
    try {
      const email = Email.create(authorEmail);
      const user = await this.userRepo.findByEmail(email);
      return user?.id;
    } catch (error) {
      this.logger?.warn('Could not resolve blame line author email to a platform user', { error, authorEmail });
      return undefined;
    }
  }
}
