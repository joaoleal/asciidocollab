import { UserId } from '../../value-objects/ids/user-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitRepository } from '../../entities/git-repository';
import {
  GitCommitFlushEntry,
  GitMutationPort,
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
import { FileChangeReconciler } from './pull-changes';
import { anomalyAuditMetadata, GitReconcileAnomaly } from './git-change-reconciler';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_BRANCH_SWITCH_PARTIALLY_APPLIED } from '../../audit-actions';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
// Referenced only from this file's own JSDoc @link tags; kept imported so the links resolve.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { InsufficientRoleError } from '../../errors/git/insufficient-role';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { GitCommandFailedError } from '../../errors/git/git-command-failed';

/**
 * Everything `SwitchBranchUseCase.execute` needs to switch a project's working tree to another local
 * branch. Unlike a pull, this never touches the credential store or the network — a checkout is a
 * purely local operation, so there is no token here.
 */
export interface SwitchBranchInput {
  /** The user who triggered the switch. Must be at least an EDITOR on the project. */
  readonly actorId: UserId;
  /** The project whose working tree to switch. */
  readonly projectId: ProjectId;
  /**
   * The queued operation this switch is running. A conflicted switch records its unresolved files as
   * `GitConflict` children of this operation.
   */
  readonly operationId: GitOperationId;
  /** The local branch to switch to. */
  readonly targetBranch: string;
  /**
   * Whether to carry the in-progress live edits across the switch (shelve before, re-apply after).
   * Resolved by the caller and passed straight through to the runner.
   */
  readonly stashLocal: boolean;
  /** Request origin, captured into audit metadata for a denial. */
  readonly context?: RequestContext;
}

/**
 * What a switch hands back. A clean switch reports the target branch and the paths it landed; a
 * switch whose carried edits did not re-apply cleanly reports the conflicting paths and leaves the
 * operation awaiting resolution — a conflict is an expected outcome of a switch, never an error.
 */
export type SwitchBranchResult =
  | {
      readonly status: 'switched';
      readonly branch: string;
      readonly changedPaths: readonly string[];
      /**
       * Drift anomalies the reconciler surfaced while landing the switched-in change-set (empty on a
       * clean apply). Carried out — exactly as `PullChanges` does — so the worker handler can surface a
       * drift summary on the operation row, most importantly the `content_dropped_folder_occupies_path`
       * case, where a switched-in change was discarded and the triggering user (no log access) would
       * otherwise have no way to know.
       */
      readonly anomalies: readonly GitReconcileAnomaly[];
    }
  | { readonly status: 'awaiting_conflict'; readonly conflictPaths: readonly string[] };

/**
 * Switches a project's working tree to another local branch: capture live collaborative content as
 * the working-tree state, check out the target branch (optionally carrying that live work across),
 * then either land the resulting change-set into open editors or record the conflicts.
 *
 * Switch is an ASYNC LONG git action, like `PullChanges`: it runs from the git-worker queue, which
 * claims its operation row as `RUNNING` before this use case executes. That claimed row IS the
 * project's single-flight guard for the duration of the switch, so this use case takes NO guard of
 * its own. It still self-gates role as defense-in-depth: membership can change between the route's
 * pre-enqueue check and the worker claiming the operation.
 *
 * Before switching it captures the live collaborative text of every OPEN document and hands it to
 * the checkout as the working-tree side, so the switch preserves what collaborators currently see
 * rather than the stale bytes on disk — the same flush contract `PullChanges` uses. Only
 * active-session documents are flushed; a dormant document already matches the working tree. If ANY
 * open document's live read fails, the whole switch is aborted before any checkout, so a switch
 * never mixes fresh live text with a stale copy of a file that could not be read.
 */
export class SwitchBranchUseCase {
  /**
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial (via `requireGitRole`). Not used on the
   *   success path: the git-worker run loop records the terminal SUCCEEDED audit for an async op.
   * @param gitRepositoryRepo - Loads the project's repository link and writes it back after the switch.
   * @param gitOperationRepo - Records a `GitConflict` per conflicting file on a conflicted switch.
   * @param commandRunner - Runs the checkout.
   * @param fileNodeRepo - Resolves an open document's file node to build its flush entry.
   * @param documentRepo - Resolves an active session's document (and its file node) for the flush.
   * @param collaborativeContentReader - Reads a document's current live text.
   * @param collaborationSessionRepo - Names the documents with an active collaborative session to flush.
   * @param reconciler - Lands a clean switch's change-set into the project.
   * @param logger - Optional sink for best-effort audit-write failures.
   */
  constructor(
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly commandRunner: GitMutationPort,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly collaborativeContentReader: CollaborativeContentReader,
    private readonly collaborationSessionRepo: CollaborationSessionRepository,
    private readonly reconciler: FileChangeReconciler,
    private readonly logger?: Logger,
  ) {}

  /**
   * Switches `input.projectId`'s working tree to `input.targetBranch`.
   *
   * @param input - The acting user, the project, the operation, the target branch, and whether to
   *   carry local edits across the switch.
   * @returns The switched result on a clean switch, or an awaiting-conflict result when the carried
   *   edits left files in conflict; a typed refusal otherwise —
   *   {@link InsufficientRoleError} when the actor is not at least an EDITOR,
   *   {@link RepositoryNotConnectedError} when the project has no connected repository,
   *   {@link LiveContentFlushFailedError} when an open document's live content could not be read (the
   *   switch is aborted before any checkout), or a {@link GitCommandFailedError} for any checkout
   *   failure (for example, an unknown branch) or a failure landing the clean change-set.
   */
  async execute(input: SwitchBranchInput): Promise<Result<SwitchBranchResult, DomainError>> {
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

    // Already on the target branch: nothing to switch, nothing to land, and no drift to report.
    if (input.targetBranch === gitRepository.currentBranch) {
      return { success: true, value: { status: 'switched', branch: input.targetBranch, changedPaths: [], anomalies: [] } };
    }

    const flush = await this.buildFlush(input.projectId);
    if (!flush.success) return flush;

    const checkout = await this.commandRunner.checkout(input.projectId, {
      branch: input.targetBranch,
      flush: flush.value,
      stashLocal: input.stashLocal,
      operationId: input.operationId,
    });
    if (!checkout.success) return checkout;

    if (checkout.value.status === 'conflicted') {
      for (const conflict of checkout.value.conflicts) {
        await this.gitOperationRepo.createConflict({
          operationId: input.operationId,
          path: conflict.path,
          isBinary: conflict.isBinary,
        });
      }
      await this.refreshRow(gitRepository, input.targetBranch, 'CONFLICTED');
      // A conflict is not terminal — the worker loop records the AWAITING_CONFLICT transition, so
      // nothing is audited here. Nothing is landed either: the resolved tree is delivered later by
      // the conflict-completion flow.
      return {
        success: true,
        value: {
          status: 'awaiting_conflict',
          conflictPaths: checkout.value.conflicts.map((conflict) => conflict.path),
        },
      };
    }

    const landed = await this.reconciler.apply(input.projectId, checkout.value.changes);
    if (!landed.success) return landed;

    await this.refreshRow(gitRepository, input.targetBranch, 'UP_TO_DATE');

    // The terminal SUCCEEDED transition is still audited by the git-worker run loop, not here. But like
    // a pull, if the reconciler hit drift the worker discards that detail with the payload, so it is
    // recorded here — otherwise the user (no log access) has no way to learn a switched-in change was
    // auto-repaired or (folder-occupied) dropped.
    if (landed.value.anomalies.length > 0) {
      await recordAuditSuccess(
        this.auditLogRepo,
        {
          actorId: input.actorId,
          projectId: input.projectId,
          action: AUDIT_GIT_BRANCH_SWITCH_PARTIALLY_APPLIED,
          resourceType: 'GitRepository',
          resourceId: gitRepository.id.value,
          metadata: { branch: input.targetBranch, ...anomalyAuditMetadata(landed.value.anomalies) },
          context: input.context,
        },
        this.logger,
      );
    }

    return {
      success: true,
      value: {
        status: 'switched',
        branch: input.targetBranch,
        changedPaths: landed.value.changedPaths,
        anomalies: landed.value.anomalies,
      },
    };
  }

  /**
   * Captures the live collaborative text of every OPEN document as the switch's working-tree side.
   * Only active-session documents are read (a dormant document already matches the working tree); a
   * live read that fails aborts the whole switch rather than switching against stale bytes.
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
   * Rewrites the loaded repository link immutably after the switch, completing only the fields the
   * switch observed: the now-current branch, the new sync status, and a cleared remote head (there
   * is no valid remote head for the new branch until a fetch). `lastSyncAt` is left UNCHANGED — a
   * local switch is not a remote sync — and every other field is carried over from the loaded row.
   */
  private async refreshRow(
    loaded: GitRepository,
    currentBranch: string,
    syncStatus: 'UP_TO_DATE' | 'CONFLICTED',
  ): Promise<void> {
    const updated = new GitRepository(
      loaded.id,
      loaded.projectId,
      loaded.provider,
      loaded.remoteUrl,
      loaded.credentialReference,
      currentBranch,
      syncStatus,
      loaded.defaultBranch,
      null,
      loaded.lastSyncAt,
      loaded.createdAt,
      loaded.connectedByUserId,
    );
    await this.gitRepositoryRepo.save(updated);
  }
}
