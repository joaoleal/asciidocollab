import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FilePath } from '../../value-objects/files/file-path';
import { FileNode } from '../../entities/file-node';
import {
  GitCommitFlushEntry,
  GitMutationPort,
  GitReadPort,
} from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { UserRepository } from '../../ports/user/user.repository';
import { EditorPreferencesRepository } from '../../ports/user/editor-preferences.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { EmptyCommitMessageError } from '../../errors/git/empty-commit-message';
import { LiveContentFlushFailedError } from '../../errors/git/live-content-flush-failed';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { requireGitRole } from './git-role-guard';
import { resolveCommitAuthorEmail } from './resolve-commit-author-email';
import { resolveDownloadContentSource } from '../project/download-content-source';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_COMMIT_AMENDED } from '../../audit-actions';

/** Everything `AmendCommitUseCase.execute` needs to amend the most-recent commit. */
export interface AmendCommitInput {
  /** The user asking to amend. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose most-recent commit to amend. */
  readonly projectId: ProjectId;
  /**
   * The replacement commit message. When absent, the amended commit keeps its existing message.
   *  Rejected if supplied but empty or whitespace-only.
   */
  readonly message?: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/** What a successful amend hands back. */
export interface AmendCommitResult {
  /** The amended commit. */
  readonly commit: {
    /** The amended commit's new hash. */
    readonly hash: string;
    /** The commit message, as recorded. */
    readonly message: string;
    /** When the commit was authored. */
    readonly authoredAt: Date;
  };
}

/**
 * Amends the project's most-recent commit with LIVE-ACCURATE content — folding any currently staged
 * changes into it and, when a message is supplied, replacing its message.
 *
 * A whole-project mutating git action (the authorization matrix lists amend under EDITOR): it
 * self-gates role and takes the project's single-flight guard. Before amending, it captures each
 * staged open document's current collaborative text and hands that to the runner to write and
 * re-stage, so the amend reflects what collaborators currently see rather than the older bytes the
 * index captured when each file was first staged.
 *
 * Unlike a commit, amending is valid with NOTHING staged — a message-only fix is a legitimate amend —
 * so no "nothing staged" refusal exists here. It is scoped to the most-recent UNPUSHED commit: rewriting
 * a commit already published to the remote would rewrite shared history, so the runner refuses that with
 * a {@link CommitAlreadyPushedError}, which this use case simply propagates.
 *
 * As with commit, only staged files with an ACTIVE collaborative session are flushed: a dormant
 * (no-session) staged file keeps its already-staged bytes, and an unstaged file with a live session is
 * not touched at all. If ANY staged open document's live read fails, the whole amend is aborted — no
 * file is written and the runner's amend is never called.
 */
export class AmendCommitUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param gitOperationRepo - Single-flight guard so this cannot race another git action.
   * @param commandRunner - Records the actual amend (write + re-stage + commit --amend).
   * @param fileNodeRepo - Loads the project's file nodes to map staged paths to nodes.
   * @param documentRepo - Resolves a file node's document to find its live collaborative state.
   * @param collaborativeContentReader - Reads a document's current live text.
   * @param collaborationSessionRepo - Tells whether a document has an active collaborative session.
   * @param userRepo - Resolves the triggering user as the commit author.
   * @param editorPreferencesRepo - Resolves the author's editor preferences, to check whether they
   *   have opted into a privacy-preserving commit email.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly commandRunner: GitReadPort & GitMutationPort,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly collaborativeContentReader: CollaborativeContentReader,
    private readonly collaborationSessionRepo: CollaborationSessionRepository,
    private readonly userRepo: UserRepository,
    private readonly editorPreferencesRepo: EditorPreferencesRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Amends the project's most-recent commit, capturing live collaborative content first.
   *
   * @param input - The acting user, the project, and the optional replacement message.
   * @returns The amended commit on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link EmptyCommitMessageError} when a supplied message is empty,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link LiveContentFlushFailedError} when a staged file's live content could not be read (the
   *   amend is aborted with no partial write), a {@link CommitAlreadyPushedError} when the most-recent
   *   commit has already been pushed, the {@link GitCommandFailedError} the underlying git command
   *   fails with, or a {@link GitOperationInProgressError} when another git action is already in
   *   flight for this project.
   */
  async execute(input: AmendCommitInput): Promise<Result<AmendCommitResult, DomainError>> {
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

    if (input.message !== undefined && input.message.trim() === '') {
      return { success: false, error: new EmptyCommitMessageError() };
    }

    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    const guarded = await this.gitOperationRepo.withGuard(input.projectId, () =>
      this.amendWhileGuarded(input),
    );
    // `withGuard` wraps the inner Result in its own Result (its failure is
    // `GitOperationInProgressError`, a peer of the inner step's own refusals) — unwrap so callers
    // see one flat Result regardless of which layer refused.
    return guarded.success ? guarded.value : guarded;
  }

  /**
   * Reads the staged set (which may be empty), captures live content for each staged open document,
   * and records the amend — the part of the flow held under the project's single-flight guard.
   */
  private async amendWhileGuarded(
    input: AmendCommitInput,
  ): Promise<Result<AmendCommitResult, DomainError>> {
    const statusResult = await this.commandRunner.getStatus(input.projectId);
    if (!statusResult.success) return statusResult;

    const staged = statusResult.value.changes.filter((change) => change.state === 'staged');

    const nodesByPath = new Map<string, FileNode>();
    for (const node of await this.fileNodeRepo.findByProjectId(input.projectId)) {
      nodesByPath.set(node.path.value, node);
    }

    // Resolve every staged file's content source first, collecting the live-content flush entries;
    // if ANY staged open document's live read failed, abort without amending so no partial or
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

    const preferences = await this.editorPreferencesRepo.findByUserId(input.actorId);

    const amendResult = await this.commandRunner.amendCommit(input.projectId, {
      message: input.message,
      author: { name: user.displayName, email: resolveCommitAuthorEmail(user, preferences) },
      flush,
    });
    if (!amendResult.success) return amendResult;

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_COMMIT_AMENDED,
        resourceType: 'Project',
        resourceId: input.projectId.value,
        metadata: { hash: amendResult.value.hash },
        context: input.context,
      },
      this.logger,
    );

    return {
      success: true,
      value: {
        commit: {
          hash: amendResult.value.hash,
          message: amendResult.value.message,
          authoredAt: amendResult.value.authoredAt,
        },
      },
    };
  }
}
