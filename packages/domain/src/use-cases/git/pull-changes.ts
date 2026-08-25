import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitRepository } from '../../entities/git-repository';
import {
  GitCommandRunner,
  GitCommitFlushEntry,
  GitMergeFileChange,
} from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { LiveContentFlushFailedError } from '../../errors/git/live-content-flush-failed';
import { requireGitRole } from './git-role-guard';
import { resolveDownloadContentSource } from '../project/download-content-source';
import { GitChangeReconcileResult } from './git-change-reconciler';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_OPERATION_SUCCEEDED } from '../../audit-actions';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
// Referenced only from this file's own JSDoc @link tags — raised inside GitCommandRunner.fetch;
// kept imported so the links resolve to real symbols.
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import type { GitCommandFailedError } from '../../errors/git/git-command-failed';

/**
 * The one behaviour this use case needs from a change-set landing service: apply a clean merge's
 * file changes to a project. `GitChangeReconciler` satisfies this exactly, so depending on the
 * one-method interface keeps this a clean DI boundary — a test can hand over a plain stub without
 * reproducing the reconciler's collaborators, and this use case never reaches into how a merge is
 * landed.
 */
export interface FileChangeReconciler {
  apply(
    projectId: ProjectId,
    changes: readonly GitMergeFileChange[],
  ): Promise<Result<GitChangeReconcileResult, DomainError>>;
}

/**
 * Everything `PullChangesUseCase.execute` needs to pull a project's current branch from its remote.
 * Like `PushChanges`, this never touches the credential store — the git-worker run loop (for a
 * `PULL` `GitOperation`) has already loaded and decrypted the stored credential and hands the
 * plaintext token straight through here.
 */
export interface PullChangesInput {
  /** The user who triggered the pull. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose current branch to pull. */
  readonly projectId: ProjectId;
  /**
   * The queued `PULL` operation this pull is running. A conflicted merge records its unresolved
   * files as `GitConflict` children of this operation.
   */
  readonly operationId: GitOperationId;
  /**
   * The plaintext access token to authenticate the fetch with. Passed straight through to
   * `GitCommandRunner.fetch` and never persisted or logged here.
   */
  readonly token: string;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/**
 * What a pull hands back. A clean merge reports the new local head and the paths it landed; a merge
 * left with conflicts reports the conflicting paths and leaves the operation awaiting resolution —
 * a conflict is an expected outcome of a pull, never an error.
 */
export type PullChangesResult =
  | { readonly status: 'merged'; readonly headCommit: string; readonly changedPaths: readonly string[] }
  | { readonly status: 'awaiting_conflict'; readonly conflictPaths: readonly string[] };

/**
 * Pulls a project's current branch from its remote: fetch, then a local three-way merge whose local
 * side reflects live collaborative content, then either land the clean change-set or record the
 * conflicts.
 *
 * Pull is an ASYNC LONG git action, like `PushChanges`: it runs from the git-worker queue, which
 * claims its `GitOperation` row as `RUNNING` before this use case executes. That claimed row IS the
 * project's single-flight guard for the duration of the pull, so this use case takes NO guard of its
 * own. It still self-gates role as defense-in-depth: membership can change between the route's
 * pre-enqueue check and the worker claiming the operation.
 *
 * Before fetching it captures the live collaborative text of every OPEN document and hands it to the
 * merge as the local side, so the merge reflects what collaborators currently see rather than the
 * stale bytes on disk — the same flush contract `CommitChanges` uses. Only active-session documents
 * are flushed; a dormant document already matches the working tree. If ANY open document's live read
 * fails, the whole pull is aborted before any fetch or merge, so a merge never mixes fresh live text
 * with a stale copy of a file that could not be read.
 */
export class PullChangesUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the success outcome.
   * @param gitRepositoryRepo - Loads the project's repository link and writes it back after the merge.
   * @param gitOperationRepo - Records a `GitConflict` per conflicting file on a conflicted merge.
   * @param commandRunner - Runs the fetch and the merge.
   * @param fileNodeRepo - Resolves an open document's file node to build its flush entry.
   * @param documentRepo - Resolves an active session's document (and its file node) for the flush.
   * @param collaborativeContentReader - Reads a document's current live text.
   * @param collaborationSessionRepo - Names the documents with an active collaborative session to flush.
   * @param reconciler - Lands a clean merge's change-set into the project.
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
    private readonly reconciler: FileChangeReconciler,
    private readonly logger?: Logger,
  ) {}

  /**
   * Pulls `input.projectId`'s current branch from its remote, using `input.token` to authenticate.
   *
   * @param input - The acting user, the project, the `PULL` operation, and the credential to fetch with.
   * @returns The merged result on a clean merge, or an awaiting-conflict result when the merge left
   *   files in conflict; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link LiveContentFlushFailedError} when an open document's live content could not be read (the
   *   pull is aborted before any fetch or merge),
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the fetch could not
   *   reach the remote or the credential was rejected, or a {@link GitCommandFailedError} for any
   *   other fetch/merge failure or a failure landing the clean change-set.
   */
  async execute(input: PullChangesInput): Promise<Result<PullChangesResult, DomainError>> {
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

    const flush = await this.buildFlush(input.projectId);
    if (!flush.success) return flush;

    const fetchResult = await this.commandRunner.fetch(input.projectId, {
      remoteUrl: gitRepository.remoteUrl,
      token: input.token,
      branch: gitRepository.currentBranch,
    });
    if (!fetchResult.success) return fetchResult;

    const merge = await this.commandRunner.merge(input.projectId, {
      branch: gitRepository.currentBranch,
      flush: flush.value,
    });
    if (!merge.success) return merge;

    if (merge.value.status === 'conflicted') {
      for (const conflict of merge.value.conflicts) {
        await this.gitOperationRepo.createConflict({
          operationId: input.operationId,
          path: conflict.path,
          isBinary: conflict.isBinary,
        });
      }
      await this.refreshRow(gitRepository, 'CONFLICTED', fetchResult.value.remoteHead);
      // A conflict is not terminal — the worker loop records the AWAITING_CONFLICT transition, so
      // nothing is audited here.
      return {
        success: true,
        value: {
          status: 'awaiting_conflict',
          conflictPaths: merge.value.conflicts.map((conflict) => conflict.path),
        },
      };
    }

    const landed = await this.reconciler.apply(input.projectId, merge.value.changes);
    if (!landed.success) return landed;

    await this.refreshRow(gitRepository, 'UP_TO_DATE', fetchResult.value.remoteHead);

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_OPERATION_SUCCEEDED,
        resourceType: 'GitRepository',
        resourceId: gitRepository.id.value,
        metadata: { kind: 'PULL' },
        context: input.context,
      },
      this.logger,
    );

    return {
      success: true,
      value: { status: 'merged', headCommit: merge.value.headCommit, changedPaths: landed.value.changedPaths },
    };
  }

  /**
   * Captures the live collaborative text of every OPEN document as the merge's local side. Only
   * active-session documents are read (a dormant document already matches the working tree); a live
   * read that fails aborts the whole pull rather than merging against stale bytes.
   */
  private async buildFlush(
    projectId: ProjectId,
  ): Promise<Result<GitCommitFlushEntry[], LiveContentFlushFailedError>> {
    const flush: GitCommitFlushEntry[] = [];

    for (const documentId of await this.collaborationSessionRepo.findActiveDocumentIds(projectId)) {
      const document = await this.documentRepo.findById(documentId);
      if (!document) continue;

      const node = await this.fileNodeRepo.findById(document.fileNodeId);
      if (!node) continue;

      // Git paths carry no leading slash; a FilePath always begins with one — strip it.
      const gitPath = node.path.value.replace(/^\/+/, '');

      const source = await resolveDownloadContentSource(
        {
          documentRepo: this.documentRepo,
          collaborationSessionRepo: this.collaborationSessionRepo,
          collaborativeContentReader: this.collaborativeContentReader,
          logger: this.logger,
        },
        projectId,
        node,
        'fail',
      );

      if (source.kind === 'unavailable') {
        return { success: false, error: new LiveContentFlushFailedError(gitPath) };
      }
      if (source.kind === 'inline') {
        flush.push({ path: gitPath, content: source.bytes.toString('utf8') });
      }
    }

    return { success: true, value: flush };
  }

  /**
   * Rewrites the loaded repository link immutably after the merge, completing only the fields the
   * pull observed: the new sync status, the remote head the fetch reported, and the sync timestamp.
   * Every other field is carried over from the loaded row.
   */
  private async refreshRow(
    loaded: GitRepository,
    syncStatus: 'UP_TO_DATE' | 'CONFLICTED',
    remoteHead: string,
  ): Promise<void> {
    const updated = new GitRepository(
      loaded.id,
      loaded.projectId,
      loaded.provider,
      loaded.remoteUrl,
      loaded.credentialReference,
      loaded.currentBranch,
      syncStatus,
      loaded.defaultBranch,
      remoteHead,
      new Date(),
      loaded.createdAt,
      loaded.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updated);
  }
}
