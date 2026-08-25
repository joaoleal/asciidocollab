import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FilePath } from '../../value-objects/files/file-path';
import { FileNode } from '../../entities/file-node';
import {
  GitCommandRunner,
  GitCommitFlushEntry,
} from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { UserRepository } from '../../ports/user/user.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { EmptyCommitMessageError } from '../../errors/git/empty-commit-message';
import { NothingStagedError } from '../../errors/git/nothing-staged';
import { LiveContentFlushFailedError } from '../../errors/git/live-content-flush-failed';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { requireGitRole } from './git-role-guard';
import { resolveDownloadContentSource } from '../project/download-content-source';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';

/** Everything `CommitChangesUseCase.execute` needs to record one commit. */
export interface CommitChangesInput {
  /** The user asking to commit. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose staged changes to commit. */
  readonly projectId: ProjectId;
  /** The commit message. Rejected if empty or whitespace-only. */
  readonly message: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful commit hands back. */
export interface CommitChangesResult {
  /** The commit that was recorded. */
  readonly commit: {
    /** The new commit's hash. */
    readonly hash: string;
    /** The commit message, as recorded. */
    readonly message: string;
    /** When the commit was authored. */
    readonly authoredAt: Date;
  };
}

/**
 * Commits a project's staged changes, but with LIVE-ACCURATE content.
 *
 * A whole-project mutating git action (the authorization matrix lists commit under EDITOR): it
 * self-gates role and takes the project's single-flight guard. Before committing, it captures each
 * staged open document's current collaborative text and hands that to the runner to write and
 * re-stage, so the commit reflects what collaborators currently see rather than the older bytes the
 * index captured when each file was first staged.
 *
 * Only STAGED files are committed, and only staged files with an ACTIVE collaborative session are
 * flushed: a dormant (no-session) staged file keeps its already-staged bytes, and an unstaged file
 * with a live session is not committed at all. If ANY staged open document's live read fails, the
 * whole commit is aborted — no file is written and the runner's commit is never called — so a
 * commit never mixes freshly-read live content with a stale copy of a file that could not be read.
 */
export class CommitChangesUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param gitOperationRepo - Single-flight guard so this cannot race another git action.
   * @param commandRunner - Records the actual commit (write + re-stage + commit).
   * @param fileNodeRepo - Loads the project's file nodes to map staged paths to nodes.
   * @param documentRepo - Resolves a file node's document to find its live collaborative state.
   * @param collaborativeContentReader - Reads a document's current live text.
   * @param collaborationSessionRepo - Tells whether a document has an active collaborative session.
   * @param userRepo - Resolves the triggering user as the commit author.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly collaborativeContentReader: CollaborativeContentReader,
    private readonly collaborationSessionRepo: CollaborationSessionRepository,
    private readonly userRepo: UserRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Commits the project's currently staged changes, capturing live collaborative content first.
   *
   * @param input - The acting user, the project, and the commit message.
   * @returns The recorded commit on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link EmptyCommitMessageError} when the message is empty,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link NothingStagedError} when nothing is staged,
   *   {@link LiveContentFlushFailedError} when a staged file's live content could not be read (the
   *   commit is aborted with no partial write), the {@link GitCommandFailedError} the underlying git
   *   command fails with, or a {@link GitOperationInProgressError} when another git action is
   *   already in flight for this project.
   */
  async execute(input: CommitChangesInput): Promise<Result<CommitChangesResult, DomainError>> {
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

    if (input.message.trim() === '') {
      return { success: false, error: new EmptyCommitMessageError() };
    }

    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.commitWhileGuarded(input),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Reads the staged set, captures live content for each staged open document, and records the
   * commit — the part of the flow held under the project's single-flight guard.
   */
  private async commitWhileGuarded(
    input: CommitChangesInput,
  ): Promise<Result<CommitChangesResult, DomainError>> {
    const statusResult = await this.commandRunner.getStatus(input.projectId);
    if (!statusResult.success) return statusResult;

    const staged = statusResult.value.changes.filter((change) => change.state === 'staged');
    if (staged.length === 0) {
      return { success: false, error: new NothingStagedError() };
    }

    const nodesByPath = new Map<string, FileNode>();
    for (const node of await this.fileNodeRepo.findByProjectId(input.projectId)) {
      nodesByPath.set(node.path.value, node);
    }

    // Resolve every staged file's content source first, collecting the live-content flush entries;
    // if ANY staged open document's live read failed, abort without committing so no partial or
    // mixed-freshness write happens.
    const flush: GitCommitFlushEntry[] = [];
    for (const change of staged) {
      // Git paths carry no leading slash; a FilePath requires one.
      const node = nodesByPath.get(FilePath.create('/' + change.path).value);
      if (!node) continue;

      const source = await resolveDownloadContentSource(
        {
          documentRepo: this.documentRepo,
          collaborationSessionRepo: this.collaborationSessionRepo,
          collaborativeContentReader: this.collaborativeContentReader,
          logger: this.logger,
        },
        input.projectId,
        node,
        'fail',
      );

      if (source.kind === 'unavailable') {
        return { success: false, error: new LiveContentFlushFailedError(change.path) };
      }
      if (source.kind === 'inline') {
        flush.push({ path: change.path, content: source.bytes.toString('utf8') });
      }
    }

    const user = await this.userRepo.findById(input.actorId);
    if (user === null) {
      // The actor cleared the editor role gate, so a member record exists; a missing user row is a
      // data-integrity fault rather than a normal refusal. Report it without disclosing internals.
      return {
        success: false,
        error: new GitCommandFailedError('The commit author could not be resolved'),
      };
    }

    const commitResult = await this.commandRunner.commit(input.projectId, {
      message: input.message,
      author: { name: user.displayName, email: user.email.value },
      flush,
    });
    if (!commitResult.success) return commitResult;

    return {
      success: true,
      value: {
        commit: {
          hash: commitResult.value.hash,
          message: commitResult.value.message,
          authoredAt: commitResult.value.authoredAt,
        },
      },
    };
  }
}
