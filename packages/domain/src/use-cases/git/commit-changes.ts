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
import { NothingStagedError } from '../../errors/git/nothing-staged';
import { LiveContentFlushFailedError } from '../../errors/git/live-content-flush-failed';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { requireGitRole } from './git-role-guard';
import { resolveCommitAuthorEmail } from './resolve-commit-author-email';
import { resolveDownloadContentSource } from '../project/download-content-source';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_CHANGES_COMMITTED } from '../../audit-actions';

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
 * Commits a project's pending changes, with LIVE-ACCURATE content, staging them itself.
 *
 * A whole-project mutating git action (the authorization matrix lists commit under EDITOR): it
 * self-gates role and takes the project's single-flight guard. The commit stages the project's
 * pending changes itself — there is no separate staging step in the UI: an open document's current
 * collaborative text is captured and handed to the runner to write and re-stage, and a dormant or
 * binary file's on-disk bytes are `git add`ed — so the commit reflects what collaborators currently
 * see rather than the older bytes the index captured when a file was first staged.
 *
 * Every pending change is committable EXCEPT a conflicted one, which is never auto-committed here.
 * An open document (active collaborative session) is flushed with its live text; a dormant
 * (no-session) document or a binary asset is committed from the bytes already on disk (staged first
 * when not yet indexed). If ANY committable open document's live read fails, the whole commit is
 * aborted — no file is written and the runner's commit is never called — so a commit never mixes
 * freshly-read live content with a stale copy of a file that could not be read.
 */
export class CommitChangesUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial.
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param gitOperationRepo - Single-flight guard so this cannot race another git action.
   * @param commandRunner - Reads the pending changes, stages dormant/binary files, and records the
   *   actual commit (write + re-stage + commit).
   * @param fileNodeRepo - Loads the project's file nodes to map pending paths to nodes.
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
   * Commits the project's pending changes, staging them itself and capturing live collaborative
   * content first.
   *
   * @param input - The acting user, the project, and the commit message.
   * @returns The recorded commit on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link EmptyCommitMessageError} when the message is empty,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link NothingStagedError} when there is nothing pending to commit,
   *   {@link LiveContentFlushFailedError} when a committable file's live content could not be read (the
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
   * Reads the pending set, captures live content for each committable open document, stages the
   * dormant/binary files, and records the commit — the part of the flow held under the project's
   * single-flight guard.
   */
  private async commitWhileGuarded(
    input: CommitChangesInput,
  ): Promise<Result<CommitChangesResult, DomainError>> {
    const statusResult = await this.commandRunner.getStatus(input.projectId);
    if (!statusResult.success) return statusResult;

    // Everything pending except conflicts: staged ∪ unstaged ∪ untracked. Conflicted files are
    // never auto-committed here — the user resolves them through the merge flow first.
    const committable = statusResult.value.changes.filter((change) => change.state !== 'conflicted');
    if (committable.length === 0) {
      return { success: false, error: new NothingStagedError() };
    }

    const nodesByPath = new Map<string, FileNode>();
    for (const node of await this.fileNodeRepo.findByProjectId(input.projectId)) {
      nodesByPath.set(node.path.value, node);
    }

    // Resolve every committable file's content source first. An open document contributes a
    // live-content flush entry the commit op writes and re-stages; a dormant document or binary
    // asset whose authoritative bytes are already on disk is staged as-is when it is not already in
    // the index. If ANY committable open document's live read fails, abort without committing so no
    // partial or mixed-freshness write happens.
    const flush: GitCommitFlushEntry[] = [];
    const toStage: string[] = [];
    for (const change of committable) {
      // Git paths carry no leading slash; a FilePath requires one. A path with no file-tree node
      // (for example a managed dotfile) is left in whatever state it is already in — never
      // force-staged.
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
        continue;
      }
      // source.kind === 'stored': a binary asset or a dormant (no live session) document — its
      // authoritative bytes are already on disk. Stage those bytes when they are not yet indexed.
      if (change.state !== 'staged') {
        toStage.push(change.path);
      }
    }

    // Guard against a no-op commit: nothing to flush, nothing new to stage, and nothing already in
    // the index means there is genuinely nothing to record.
    const alreadyStaged = committable.some((change) => change.state === 'staged');
    if (flush.length === 0 && toStage.length === 0 && !alreadyStaged) {
      return { success: false, error: new NothingStagedError() };
    }

    if (toStage.length > 0) {
      const staged = await this.commandRunner.stage(input.projectId, toStage);
      if (!staged.success) return staged;
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

    const commitResult = await this.commandRunner.commit(input.projectId, {
      message: input.message,
      author: { name: user.displayName, email: resolveCommitAuthorEmail(user, preferences) },
      flush,
    });
    if (!commitResult.success) return commitResult;

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_CHANGES_COMMITTED,
        resourceType: 'Project',
        resourceId: input.projectId.value,
        metadata: { hash: commitResult.value.hash, messageLength: input.message.length },
        context: input.context,
      },
      this.logger,
    );

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
