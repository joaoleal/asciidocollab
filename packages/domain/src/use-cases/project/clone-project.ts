import { randomUUID } from 'crypto';
import { Project } from '../../entities/project';
import { ProjectMember } from '../../entities/project-member';
import { FileNode } from '../../entities/file-node';
import { Document } from '../../entities/document';
import { Asset } from '../../entities/asset';
import { ProjectRenderConfig } from '../../entities/project-render-config';
import { ProjectDictionaryTerm } from '../../entities/project-dictionary-term';
import { ProjectId } from '../../value-objects/ids/project-id';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { DocumentId } from '../../value-objects/ids/document-id';
import { ContentId } from '../../value-objects/ids/content-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { ProjectRenderConfigId } from '../../value-objects/ids/project-render-config-id';
import { ProjectDictionaryTermId } from '../../value-objects/ids/project-dictionary-term-id';
import { UserId } from '../../value-objects/ids/user-id';
import { ProjectName } from '../../value-objects/project/project-name';
import { Role } from '../../value-objects/identity/role';
import { MimeType } from '../../value-objects/files/mime-type';
import { Timestamps } from '../../value-objects/common/timestamps';
import { ProjectRepository } from '../../ports/project/project.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { AssetRepository } from '../../ports/file-tree/asset.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { ProjectRenderConfigRepository } from '../../ports/project/project-render-config.repository';
import { ProjectDictionaryRepository } from '../../ports/grammar/project-dictionary.repository';
import { ActiveCloneRegistry } from '../../ports/project/active-clone-registry';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { PermissionDeniedError } from '../../errors/common/permission-denied';
import { CloneAlreadyInProgressError } from '../../errors/project/clone-already-in-progress';
import { LiveContentUnavailableError } from '../../errors/project/live-content-unavailable';
import { CloneFailedError } from '../../errors/project/clone-failed';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess, recordAuthorizationDenial } from '../audit-recording';
import { AUDIT_PROJECT_CLONED, AUDIT_PROJECT_CLONE_REQUESTED } from '../../audit-actions';
import {
  ResolveDownloadContentSourceDeps,
  resolveDownloadContentSource,
} from './download-content-source';

/** The path every project's root folder occupies, and the only one that can. */
const ROOT_FOLDER_PATH = '/';

/**
 * What a copied binary file is recorded as when the source has no asset row to
 * name its type — the same "unknown bytes" type the web serves such a file as.
 */
const DEFAULT_ASSET_MIME_TYPE = 'application/octet-stream';

/** One node still to copy, paired with the clone-side parent it belongs under. */
interface PendingNodeCopy {
  /** The node in the source tree being reproduced. */
  readonly sourceNode: FileNode;
  /** The already-written copy of that node's parent, or null for the root. */
  readonly cloneParentId: FileNodeId | null;
}

/** A source node paired with the copy that now stands for it in the clone. */
interface CopiedNode {
  /** The node in the source tree. */
  readonly sourceNode: FileNode;
  /** The id of the row written for it under the clone. */
  readonly cloneNodeId: FileNodeId;
}

/** The clone's file tree, and the means to translate source ids into it. */
interface ClonedFileTree {
  /**
   * Maps each source file-node id to the id of its copy. The later copy steps —
   * documents, assets, the main-file pointer — all address the clone through
   * this map, so it is carried for the whole run rather than rebuilt per step.
   */
  readonly nodeIdMap: ReadonlyMap<string, FileNodeId>;
  /** The copy of the node at the root path, or null if the source tree had none. */
  readonly rootFolderId: FileNodeId | null;
  /**
   * Every copied node in the order it was written — parent before child. The
   * content pass replays that order so a folder in the clone's storage always
   * exists before anything is written inside it.
   */
  readonly copiedNodes: readonly CopiedNode[];
}

/**
 * What the guarded stretch of the copy ended in: a committed project, or the
 * refusal to answer with. Carried as one value rather than two locals so that a
 * built copy and the failure that would discard it cannot both be set, and so
 * the caller needs no fallback for the impossible pairing of neither.
 */
type CloneOutcome =
  | { readonly built: true; readonly clone: Project }
  | { readonly built: false; readonly error: DomainError };

/** Everything the steps between the project row and the membership row work from. */
interface CloneBuild {
  /** The user who asked for the copy and will own it. */
  readonly actorId: UserId;
  /** The project being copied. */
  readonly sourceProjectId: ProjectId;
  /** The source's project row as it stood when the copy began, or null if it is gone. */
  readonly sourceProject: Project | null;
  /** The copy's own project entity, already written as a memberless row. */
  readonly clone: Project;
  /** The copy's name, which its root folder takes. */
  readonly cloneName: ProjectName;
  /** Request origin recorded with the audit trail, when the caller supplied one. */
  readonly context: RequestContext | undefined;
}

/**
 * Describes a source file whose row exists but whose bytes the store no longer
 * holds. Carried only as a `CloneFailedError` cause, for the log — never shown.
 */
function missingSourceBytes(path: string): Error {
  return new Error(`The source project has no stored bytes for ${path}`);
}

/** What a completed clone hands back to its caller. */
export interface CloneProjectResult {
  /**
   * The project the clone produced, carrying the values the delivery layer
   * needs to describe the copy without reading it back.
   */
  project: Project;
}

/**
 * Copies a project the actor can reach into a new one the actor owns.
 *
 * Two orderings here are load-bearing rather than incidental. The clone slot is
 * claimed before any work starts and freed in a `finally`, so no path — success,
 * refusal, or an exception — can strand it, while a refusal caused by someone
 * else's running clone must leave that clone's slot alone. And the owner
 * membership row is written last: a project row with no membership rows is
 * invisible to every read path in the system, so it is that row, not the project
 * row, that commits the copy.
 */
export class CloneProjectUseCase {
  /**
   * @param projectRepo - Reads and writes project rows.
   * @param fileNodeRepo - Reads the source file tree and writes the copy of it.
   * @param projectMemberRepo - Resolves the actor's access to the source and
   * writes the clone's single owner row.
   * @param auditLogRepo - Records the governance trail, including refusals.
   * @param activeCloneRegistry - Bounds each user to one running clone.
   * @param documentRepo - Reads the source's text documents and writes the copies.
   * @param assetRepo - Writes the copy's row for every binary file.
   * @param fileStore - Reads the source's bytes and holds the copy's own.
   * @param collaborationSessionRepo - Tells whether a source document is being
   * edited right now, and so whether its live text has to be consulted.
   * @param collaborativeContentReader - Reads that live text.
   * @param renderConfigRepo - Reads the source's render options and writes the copy's.
   * @param dictionaryRepo - Reads the source's accepted terms and writes the copy's.
   * @param logger - Optional sink for best-effort failures that must stay visible.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly activeCloneRegistry: ActiveCloneRegistry,
    private readonly documentRepo: DocumentRepository,
    private readonly assetRepo: AssetRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly collaborationSessionRepo: CollaborationSessionRepository,
    private readonly collaborativeContentReader: CollaborativeContentReader,
    private readonly renderConfigRepo: ProjectRenderConfigRepository,
    private readonly dictionaryRepo: ProjectDictionaryRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Clones a source project under a new name, leaving the source untouched.
   *
   * @param actorId - The user asking for the copy, who becomes its owner.
   * @param sourceProjectId - The project to copy.
   * @param name - The copy's name, validated here rather than by the caller.
   * @param context - Optional request origin recorded with the audit trail.
   * @returns The new project on success; a refusal describing why not otherwise.
   * @throws {Error} Only if the authorization read itself fails. Every other repository failure —
   * everything from reading the source to writing the membership row — is caught and returned as a
   * refusal, because only a returned refusal runs the compensating cleanup. The slot is released
   * either way.
   */
  async execute(
    actorId: UserId,
    sourceProjectId: ProjectId,
    name: string,
    context?: RequestContext,
  ): Promise<Result<CloneProjectResult, DomainError>> {
    if (!this.activeCloneRegistry.tryAcquire(actorId)) {
      // The slot is held by the actor's other running clone. Returning before
      // the `try` below is what keeps this refusal from freeing that clone's slot.
      return { success: false, error: new CloneAlreadyInProgressError() };
    }

    try {
      return await this.cloneWhileHoldingSlot(actorId, sourceProjectId, name, context);
    } finally {
      this.activeCloneRegistry.release(actorId);
    }
  }

  /**
   * Runs the clone itself. Split out so that every exit — including a thrown
   * repository error — passes through the caller's slot-releasing `finally`.
   */
  private async cloneWhileHoldingSlot(
    actorId: UserId,
    sourceProjectId: ProjectId,
    name: string,
    context: RequestContext | undefined,
  ): Promise<Result<CloneProjectResult, DomainError>> {
    // Membership at any role — viewer, editor or owner — is the whole gate.
    // Looking it up before the project itself is also what makes a project the
    // actor cannot see indistinguishable from one that does not exist: neither
    // has a membership row for them, so both leave here with the same refusal.
    const membership = await this.projectMemberRepo.findByCompositeKey(sourceProjectId, actorId);
    if (!membership) {
      // An audit row's `projectId` is a foreign key, so naming a project that does not exist makes
      // the insert fail — and audit writes are best-effort, so that failure is swallowed. The
      // refusal that most deserves recording is exactly the one that would be lost: somebody
      // walking the id space to find out which projects exist leaves no trail at all, while an
      // honest mistake against a real project leaves one. Reading the source first costs one query
      // on the refusal path and lets the entry be written either way, scoped to the project when
      // there is a project to scope it to. `resourceId` names the id that was asked for regardless,
      // so the attempt is legible even when it pointed at nothing.
      const sourceExists = await this.sourceProjectConfirmedToExist(sourceProjectId);
      await recordAuthorizationDenial(
        this.auditLogRepo,
        {
          actorId,
          projectId: sourceExists ? sourceProjectId : null,
          resourceType: 'Project',
          resourceId: sourceProjectId.value,
          reason: 'not_authorized',
          context,
        },
        this.logger,
      );
      return { success: false, error: new PermissionDeniedError() };
    }

    // Names are not unique in this system, so a name another of the actor's
    // projects already uses is accepted; only the name's own shape is checked.
    let cloneName: ProjectName;
    try {
      cloneName = ProjectName.create(name);
    } catch (error) {
      if (error instanceof DomainError) {
        return { success: false, error };
      }
      throw error;
    }

    // The id is minted before the guarded stretch below so that the compensating
    // cleanup has something to name whatever happens inside it — including a
    // project row whose write was the very step that failed. Nothing is written
    // yet; an id nobody stored is nothing to clean up, and the cleanup tolerates
    // being handed one.
    const cloneId = ProjectId.create(randomUUID());

    // Everything the copy is made of belongs inside this one guarded stretch: the
    // project row, the file bytes, the project-level settings, and finally the
    // membership row. Nothing here is reachable by any read path until that last
    // write lands, so a failure among them strands no project a user can see.
    // What it can strand is rows and bytes nobody will ever collect, which is
    // what the compensating cleanup is for — every exit other than success runs
    // it, and every throw becomes a refusal rather than escaping as itself.
    //
    // The project row is INSIDE rather than above it because a write that fails
    // after the row has committed — a connection reset between the insert and its
    // acknowledgement — leaves exactly the residue this cleanup exists to remove:
    // a project with no members that no read path can reach, and so nothing that
    // walks visible projects would ever find again.
    let outcome: CloneOutcome;
    try {
      // Read before anything is written, so the settings the copy carries are the
      // ones the source had when the copy was asked for. A source whose row is gone
      // by now — deleted by someone else mid-request — still yields a copy of what
      // is left of it rather than a refusal, exactly as a source whose files are
      // deleted after they have been read does.
      const sourceProject = await this.projectRepo.findById(sourceProjectId);

      const clone = new Project(
        cloneId,
        cloneName,
        // Description, tags and language describe the content, which is what is
        // being copied, so they come across untouched.
        sourceProject?.description ?? null,
        [...(sourceProject?.tags ?? [])],
        null,
        new Timestamps(),
        // A copy is always active, whatever state its source is in.
        null,
        // The main file is a foreign key to a file node that does not exist yet;
        // it is set once the tree has been copied.
        null,
        sourceProject?.language ?? null,
      );
      await this.projectRepo.save(clone);

      const failure = await this.fillClone({ actorId, sourceProjectId, sourceProject, clone, cloneName, context });
      if (failure === null) {
        // The membership row commits the copy, and it is inside this stretch
        // rather than after it because failing to write it is the worst residue
        // of all: a fully built project that no read path can reach, so nothing
        // that walks visible projects would ever find it again to clean it up.
        await this.projectMemberRepo.addMember(new ProjectMember(cloneId, actorId, Role.create('owner')));
        outcome = { built: true, clone };
      } else {
        outcome = { built: false, error: failure };
      }
    } catch (error) {
      outcome = { built: false, error: new CloneFailedError(error) };
    }

    if (!outcome.built) {
      await this.cleanUpAbandonedClone(cloneId);
      // A live document that could not be read surfaces as itself rather than as
      // a generic failure: it is the one cause the caller can act on, because it
      // names the file to close or retry.
      return { success: false, error: outcome.error };
    }

    // Only now, past the commit point. Recording the copy before the membership
    // row meant a run that failed at that last write still left a `project.cloned`
    // entry behind: the cleanup deleted the project row, the audit row outlived it
    // with its project reference nulled, and the governance trail then claimed a
    // copy no user ever received. Both entries are best-effort, so an audit store
    // that is down cannot undo a copy that is already committed.
    await this.recordCloneAudit(actorId, sourceProjectId, outcome.clone, context);

    return { success: true, value: { project: outcome.clone } };
  }

  /**
   * Answers whether the source could be confirmed to exist, for the refusal's audit entry alone.
   *
   * The read is the only thing this method does, and its failure must not become the caller's
   * answer: the refusal is already decided by the missing membership row, so a database hiccup
   * here would turn a designed refusal into a thrown error and a logged stack trace. A read that
   * did not come back cannot confirm anything, so it counts as no project — which is also the
   * answer that keeps the audit insert's project foreign key valid, the reason the question is
   * asked at all. The id that was asked for is recorded as the resource either way.
   *
   * @param sourceProjectId - The project the actor named and may not reach.
   * @returns True only when the project was read back; false when it is absent or unreadable.
   */
  private async sourceProjectConfirmedToExist(sourceProjectId: ProjectId): Promise<boolean> {
    try {
      return (await this.projectRepo.findById(sourceProjectId)) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Builds everything the clone carries between its project row and its
   * membership row, leaving it one write away from being visible.
   *
   * @param build - The copy being assembled, and the source it is copied from.
   * @returns The refusal that aborted the build, or null when it is complete.
   */
  private async fillClone(build: CloneBuild): Promise<DomainError | null> {
    const { sourceProjectId, clone } = build;
    const fileTree = await this.copyFileTree(sourceProjectId, clone.id, build.cloneName);

    const contentFailure = await this.copyFileContents(sourceProjectId, clone.id, fileTree.copiedNodes);
    if (contentFailure !== null) return contentFailure;

    await this.pointCloneAtItsOwnNodes(build, fileTree);
    await this.copyRenderConfig(build);
    await this.copyDictionaryTerms(build);

    // No audit entry here. The trail is written past the commit point by the
    // caller, so a copy that is abandoned after this point leaves none.
    return null;
  }

  /**
   * Points the clone's project entity at the two file nodes it names: its root
   * folder and its main file.
   *
   * Only the main file is a stored column, and it is the reason for the second
   * write: it is a foreign key to a row that did not exist when the project row
   * was written, the same two-step a newly created project goes through. It is
   * translated through the tree's identity map rather than copied, so repointing
   * or deleting the source's main file afterwards reaches nothing the copy
   * depends on.
   *
   * The root folder is set on the entity and goes no further, because there is no
   * column for it — `toPersistenceProject` does not write one and every project
   * read back reports none, a newly created project included. Nothing outside this
   * class reads it back either: the caller describing the fresh copy re-reads the
   * row, precisely because the field does not survive the write. It is kept only so
   * the entity this use case hands back is internally consistent with the tree it
   * just wrote.
   *
   * Because of that, a copy with no main file has nothing to write: the second
   * save is skipped rather than sending an update that would change no column.
   *
   * @param build - The copy being assembled, and the source it is copied from.
   * @param fileTree - The tree just written for the copy, and its identity map.
   */
  private async pointCloneAtItsOwnNodes(build: CloneBuild, fileTree: ClonedFileTree): Promise<void> {
    const { clone, sourceProject } = build;
    const sourceMainFileId = sourceProject?.mainFileNodeId ?? null;
    const cloneMainFileId =
      sourceMainFileId === null ? undefined : fileTree.nodeIdMap.get(sourceMainFileId.value);

    if (fileTree.rootFolderId !== null) {
      clone.setRootFolderId(fileTree.rootFolderId);
    }

    if (cloneMainFileId === undefined) {
      if (sourceMainFileId !== null) {
        // The source named a main file, but the tree just written for the copy holds no counterpart:
        // that node — or the source row itself — was deleted between the source read and the tree walk,
        // the concurrency this use case embraces. A null main file is a legitimate state, so the copy
        // still commits; only the pointer's silent loss to the race is surfaced, not raised.
        this.logger?.warn('Cloned project left without a main file: the source main file was gone by the tree walk', {
          projectId: clone.id.value,
          sourceMainFileId: sourceMainFileId.value,
        });
      }
      return;
    }

    clone.setMainFile(cloneMainFileId);
    await this.projectRepo.save(clone);
  }

  /**
   * Gives the copy the source's render options, if the source has any of its own.
   *
   * A source with no record of its own is not a project configured with empty
   * options: it is one that renders with the system defaults, and follows them
   * wherever they go. Writing a record here would freeze today's defaults into
   * the copy, so a later change to them would reach the source and never the
   * copy. No record in, no record out.
   *
   * @param build - The copy being assembled, and the source it is copied from.
   */
  private async copyRenderConfig(build: CloneBuild): Promise<void> {
    const sourceConfig = await this.renderConfigRepo.findByProjectId(build.sourceProjectId);
    if (sourceConfig === null) return;

    await this.renderConfigRepo.save(
      // The document is opaque to the domain — the boundary that wrote it
      // validated it — so it is carried across as it stands.
      new ProjectRenderConfig(
        ProjectRenderConfigId.create(randomUUID()),
        build.clone.id,
        sourceConfig.config,
      ),
    );
  }

  /**
   * Gives the copy its own row for every term the source's dictionary accepted.
   *
   * Each copy is attributed to the user who asked for it rather than to whoever
   * first accepted the term: the copy has exactly one member, and that member is
   * not necessarily the source's author, so carrying the original attribution
   * would hang the copy's terms off someone who cannot even see the project.
   *
   * @param build - The copy being assembled, and the source it is copied from.
   */
  private async copyDictionaryTerms(build: CloneBuild): Promise<void> {
    const sourceTerms = await this.dictionaryRepo.listByProject(build.sourceProjectId);

    // The inserts are mutually independent — each is a fresh row against the clone, with no ordering
    // constraint between them — so they run together rather than as one awaited round trip after
    // another, the same reason the document and asset reads above are batched.
    await Promise.all(
      sourceTerms.map((sourceTerm) =>
        this.dictionaryRepo.add(
          new ProjectDictionaryTerm(
            ProjectDictionaryTermId.create(randomUUID()),
            build.clone.id,
            sourceTerm.term,
            build.actorId,
          ),
        ),
      ),
    );
  }

  /**
   * Records the two entries a completed copy leaves behind.
   *
   * The copy's own trail starts here, with nothing carried over from the source:
   * a governance history describes what happened to a project, and none of what
   * happened to the source happened to the copy. The source gets an entry of its
   * own because a copy takes its content elsewhere, which is exactly the kind of
   * read its owners are entitled to see recorded against it.
   *
   * Both writes are best-effort, so an audit store that is down cannot undo a
   * copy that is already built. Called only past the commit point, so an entry
   * here is only ever written about a copy that exists.
   *
   * @param actorId - The user who asked for the copy and now owns it.
   * @param sourceProjectId - The project that was copied.
   * @param clone - The committed copy.
   * @param context - Request origin recorded with the trail, when there is one.
   */
  private async recordCloneAudit(
    actorId: UserId,
    sourceProjectId: ProjectId,
    clone: Project,
    context: RequestContext | undefined,
  ): Promise<void> {
    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId,
        projectId: clone.id,
        action: AUDIT_PROJECT_CLONED,
        resourceType: 'Project',
        resourceId: clone.id.value,
        metadata: { sourceProjectId: sourceProjectId.value },
        context,
      },
      this.logger,
    );

    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId,
        projectId: sourceProjectId,
        action: AUDIT_PROJECT_CLONE_REQUESTED,
        resourceType: 'Project',
        resourceId: sourceProjectId.value,
        metadata: { cloneProjectId: clone.id.value },
        context,
      },
      this.logger,
    );
  }

  /**
   * Undoes an abandoned clone, so a run that failed leaves nothing behind.
   *
   * Deleting the project row cascades to everything hung off it — file nodes,
   * documents, assets, render config, dictionary terms — leaving only the bytes,
   * which the file store removes separately.
   *
   * `YjsStateStore.deleteAllForProject` is deliberately absent, unlike in the
   * delete-project path: a clone persists no Yjs state, so there is nothing to
   * remove, and reaching for a state store here would imply it writes state it
   * does not write.
   *
   * Neither step may hide the failure that brought us here, so each is attempted
   * on its own and a step that fails is logged rather than raised — a row delete
   * the database refuses must not also leave the copy's bytes on disk.
   */
  private async cleanUpAbandonedClone(cloneId: ProjectId): Promise<void> {
    await this.attemptCleanup('the abandoned clone\'s project row', cloneId, () =>
      this.projectRepo.delete(cloneId),
    );
    await this.attemptCleanup('the abandoned clone\'s stored files', cloneId, () =>
      this.fileStore.removeProject(cloneId),
    );
  }

  private async attemptCleanup(
    what: string,
    cloneId: ProjectId,
    step: () => Promise<void>,
  ): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger?.warn(`Could not remove ${what} after the clone failed`, {
        projectId: cloneId.value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reproduces the source's folders and files under the clone.
   *
   * Nodes are written from the root down, so the parent a node names has always
   * been stored before the node itself; a child could otherwise point at a row
   * that does not exist yet. Anything the source leaves unreachable from a root
   * is unreachable in the copy too, so it is not carried over.
   *
   * The root is the node at the root path, deliberately, and NOT the id the
   * source's project row names — the main-file pointer is translated through the
   * id map, and the asymmetry looks like an oversight until you check where a
   * root folder id can be read from. `Project.rootFolderId` is not a stored
   * column: there is no such field on the project table, `toDomainProject`
   * constructs every project with it set to null, and `toPersistenceProject`
   * never writes it. It is populated only on an entity a use case has just built
   * in memory. So a source loaded from the database always reports no root, and
   * an implementation that translated that id would identify no root at all on
   * every real clone while passing happily against an in-memory fake that stores
   * entities by reference. The path is the only answer that survives a round trip,
   * and every project's root is created at it.
   *
   * @param sourceProjectId - The project whose tree is being read.
   * @param cloneProjectId - The project the copies are written under.
   * @param cloneName - The clone's name, which its root folder takes.
   * @returns The source-to-clone node id map, the clone's root folder id, and every copied node in
   * the order it was written, which the content pass replays.
   */
  private async copyFileTree(
    sourceProjectId: ProjectId,
    cloneProjectId: ProjectId,
    cloneName: ProjectName,
  ): Promise<ClonedFileTree> {
    const sourceNodes = await this.fileNodeRepo.findByProjectId(sourceProjectId);

    const childrenByParentId = new Map<string, FileNode[]>();
    const queue: PendingNodeCopy[] = [];
    for (const sourceNode of sourceNodes) {
      const parentId = sourceNode.parentId;
      if (parentId === null) {
        queue.push({ sourceNode, cloneParentId: null });
        continue;
      }
      const siblings = childrenByParentId.get(parentId.value);
      if (siblings === undefined) {
        childrenByParentId.set(parentId.value, [sourceNode]);
      } else {
        siblings.push(sourceNode);
      }
    }

    const nodeIdMap = new Map<string, FileNodeId>();
    const copiedNodes: CopiedNode[] = [];
    let rootFolderId: FileNodeId | null = null;

    // The queue grows as each node's children are appended, so the walk visits
    // every descendant while never reaching one before its parent is written.
    for (let index = 0; index < queue.length; index += 1) {
      const { sourceNode, cloneParentId } = queue[index];
      const cloneNodeId = FileNodeId.create(randomUUID());
      const isRootFolder = sourceNode.path.value === ROOT_FOLDER_PATH;

      await this.fileNodeRepo.save(
        new FileNode(
          cloneNodeId,
          cloneProjectId,
          cloneParentId,
          // The root folder is named after the project it belongs to, so the
          // copy's root takes the copy's name; every other name is the source's.
          isRootFolder ? cloneName.value : sourceNode.name,
          sourceNode.type,
          // The path is copied character for character. Every include::, image::
          // and xref: in the source is written against these paths, so keeping
          // them identical is what lets the copy resolve its own references with
          // no edit by the user. Paths are unique per project, not globally, so
          // reusing them under a different project is safe.
          sourceNode.path,
        ),
      );

      nodeIdMap.set(sourceNode.id.value, cloneNodeId);
      copiedNodes.push({ sourceNode, cloneNodeId });
      if (isRootFolder) {
        rootFolderId = cloneNodeId;
      }

      for (const child of childrenByParentId.get(sourceNode.id.value) ?? []) {
        queue.push({ sourceNode: child, cloneParentId: cloneNodeId });
      }
    }

    return { nodeIdMap, rootFolderId, copiedNodes };
  }

  /**
   * Fills the clone's storage and content rows from the source's, one node at a
   * time in the order the tree was written.
   *
   * A file node that has a `Document` is text and is resolved through the live
   * collaborative source; one that has none is a binary asset. That is the same
   * distinction the rest of the system makes, so nothing here has to guess from
   * a file extension.
   *
   * @param sourceProjectId - The project being read.
   * @param cloneProjectId - The project being written.
   * @param copiedNodes - Every source node with its copy, parent before child.
   * @returns The refusal that aborted the copy, or null when every node was copied.
   */
  private async copyFileContents(
    sourceProjectId: ProjectId,
    cloneProjectId: ProjectId,
    copiedNodes: readonly CopiedNode[],
  ): Promise<DomainError | null> {
    const sourceFileNodeIds = copiedNodes
      .filter((copied) => copied.sourceNode.type.value === 'file')
      .map((copied) => copied.sourceNode.id);
    const sourceDocuments = await this.documentRepo.findByFileNodeIds(sourceFileNodeIds);
    const documentsBySourceNodeId = new Map(
      sourceDocuments.map((document) => [document.fileNodeId.value, document]),
    );

    // The assets are read in bulk for the same reason the documents are. A node
    // with no document is a binary file, and asking for its asset row one file at
    // a time turned a project full of images into one serialized round trip per
    // image inside a single request. Every id is offered, not only the ones
    // already known to be assets: a node's kind is decided by whether it has a
    // document, and both answers now come from a batch rather than from a query
    // per node.
    const sourceAssets = await this.assetRepo.findByIds(sourceFileNodeIds);
    const assetsBySourceNodeId = new Map(sourceAssets.map((asset) => [asset.id.value, asset]));

    // The resolver also asks, for every node that has a document, whether that document has a live
    // collaboration session. Wired straight to the repository that answer is one round trip per
    // document — the same N+1 the sibling download path batches away — so the active ids are read
    // once here and served from a set, exactly as the document and asset kinds already are above.
    const activeDocumentIds = await this.collaborationSessionRepo.findActiveDocumentIds(sourceProjectId);
    const activeDocumentIdSet = new Set(activeDocumentIds.map((documentId) => documentId.value));

    // Built here rather than through `buildResolverDeps`, whose only job is to
    // refuse a partly-wired caller: all three collaborators are required of this
    // use case, so there is no partial wiring for it to catch.
    //
    // The resolver opens by asking whether a node has a document, which the batch
    // above has already answered for every node at once. Serving it from that
    // batch keeps the copy at one document round trip rather than one per file —
    // the difference is the whole point of reading them in bulk. The resolution
    // order is untouched; only where the answer comes from changes.
    const resolverDeps: ResolveDownloadContentSourceDeps = {
      documentRepo: {
        findByFileNodeId: async (fileNodeId) => documentsBySourceNodeId.get(fileNodeId.value) ?? null,
      },
      collaborationSessionRepo: {
        isActive: async (_projectId, documentId) => activeDocumentIdSet.has(documentId.value),
      },
      collaborativeContentReader: this.collaborativeContentReader,
      logger: this.logger,
    };

    for (const { sourceNode, cloneNodeId } of copiedNodes) {
      if (sourceNode.type.value === 'folder') {
        await this.fileStore.createDirectory(cloneProjectId, sourceNode.path);
        continue;
      }

      const sourceDocument = documentsBySourceNodeId.get(sourceNode.id.value);
      const failure =
        sourceDocument === undefined
          ? await this.copyAsset(
              sourceProjectId,
              cloneProjectId,
              sourceNode,
              cloneNodeId,
              assetsBySourceNodeId.get(sourceNode.id.value) ?? null,
            )
          : await this.copyDocument(
              resolverDeps,
              sourceProjectId,
              cloneProjectId,
              sourceNode,
              cloneNodeId,
              sourceDocument.mimeType,
            );
      if (failure !== null) return failure;
    }

    return null;
  }

  /**
   * Copies one binary file: its bytes verbatim into the clone's storage, and an
   * asset row of its own.
   *
   * Nothing interprets the bytes, so there is no live source to consult and no
   * encoding to preserve — the source store's bytes are the whole content. The
   * recorded size is the length of what was written rather than the number the
   * source row carried, because the two can disagree and only one of them
   * describes the file the clone now holds.
   *
   * The source's asset row is handed in from the batch the caller already read
   * rather than looked up here, so a project of many images costs one query and
   * not one per file. A node with no row of its own still copies — its bytes are
   * what matter — and the copy takes the default media type.
   */
  private async copyAsset(
    sourceProjectId: ProjectId,
    cloneProjectId: ProjectId,
    sourceNode: FileNode,
    cloneNodeId: FileNodeId,
    sourceAsset: Asset | null,
  ): Promise<DomainError | null> {
    const bytes = await this.fileStore.read(sourceProjectId, sourceNode.path);
    if (bytes === null) {
      // The row says there is a file and the storage disagrees. Writing an empty
      // file in its place would hand back a copy that looks complete and is not.
      return new CloneFailedError(missingSourceBytes(sourceNode.path.value));
    }

    await this.fileStore.write(cloneProjectId, sourceNode.path, bytes);

    await this.assetRepo.save(
      // An asset's id is its file node's id, so the copy is addressed by the
      // clone's node rather than carrying an identifier of its own.
      new Asset(
        cloneNodeId,
        sourceAsset?.mimeType ?? MimeType.create(DEFAULT_ASSET_MIME_TYPE),
        BigInt(bytes.length),
      ),
    );

    return null;
  }

  /**
   * Copies one text document: its current content into the clone's storage, and
   * a row of its own against the clone's file node.
   *
   * The content is taken from the live collaborative room when one is open, so a
   * copy made mid-edit matches what the collaborators can see. A live read that
   * cannot be completed refuses the whole clone instead of falling back to the
   * last bytes written to storage, which would silently produce a copy of an
   * older document than the one the user asked for.
   *
   * No Yjs state is written. The collaboration server seeds a room from the file
   * bytes when it finds no state, exactly as it does for a newly created file, so
   * the copy needs none — and the ids are fresh because reusing the source's
   * `yjsStateId` would put two projects into one collaboration room.
   */
  private async copyDocument(
    resolverDeps: ResolveDownloadContentSourceDeps,
    sourceProjectId: ProjectId,
    cloneProjectId: ProjectId,
    sourceNode: FileNode,
    cloneNodeId: FileNodeId,
    mimeType: MimeType,
  ): Promise<DomainError | null> {
    const resolved = await resolveDownloadContentSource(
      resolverDeps,
      sourceProjectId,
      sourceNode,
      'fail',
    );

    if (resolved.kind === 'unavailable') {
      // The path named is the source node's own — what the caller already sees in
      // their file tree — never a storage path resolved against the store's root.
      return new LiveContentUnavailableError(sourceNode.path.value);
    }

    // `'stored'` means the resolver decided the bytes on disk are current; it
    // never reads them itself, so the read is this use case's to make.
    const bytes =
      resolved.kind === 'inline'
        ? resolved.bytes
        : await this.fileStore.read(sourceProjectId, sourceNode.path);
    if (bytes === null) {
      return new CloneFailedError(missingSourceBytes(sourceNode.path.value));
    }

    await this.fileStore.write(cloneProjectId, sourceNode.path, bytes);
    await this.documentRepo.save(
      new Document(
        DocumentId.create(randomUUID()),
        cloneNodeId,
        ContentId.create(randomUUID()),
        YjsStateId.create(randomUUID()),
        mimeType,
      ),
    );

    return null;
  }
}
