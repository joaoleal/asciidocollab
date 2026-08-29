import { randomUUID } from 'crypto';
import { isThemeFilePath } from '@asciidocollab/asciidoc-core';
import { Project } from '../../entities/project';
import { ProjectMember } from '../../entities/project-member';
import { FileNode } from '../../entities/file-node';
import { Document } from '../../entities/document';
import { Asset } from '../../entities/asset';
import { GitRepository } from '../../entities/git-repository';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { DocumentId } from '../../value-objects/ids/document-id';
import { ContentId } from '../../value-objects/ids/content-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { GitProvider } from '../../value-objects/project/git-provider';
import { Role } from '../../value-objects/identity/role';
import { MimeType } from '../../value-objects/files/mime-type';
import { FileNodeType } from '../../value-objects/files/file-node-type';
import { FilePath } from '../../value-objects/files/file-path';
import { isAsciiDocumentFileName } from '../../value-objects/files/asciidoc-file-name';
import { ProjectRepository } from '../../ports/project/project.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { AssetRepository } from '../../ports/file-tree/asset.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { ClonedFileEntry, GitRemotePort } from '../../ports/git/git-command-runner';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { ValidationError } from '../../errors/common/validation-error';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_OPERATION_SUCCEEDED } from '../../audit-actions';
// Referenced only from this file's own JSDoc @link tags (never thrown directly here) — both are
// raised inside GitCommandRunner.clone; kept imported so the links resolve to real symbols.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- doc-only reference, see comment above.
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';

/**
 * A remote URL this use case will accept, identical to `ConnectRepository`'s own check (a
 * defense-in-depth boundary check; the Fastify route schema and the git-worker runner each
 * validate independently before the value reaches an actual `git` invocation).
 */
const VALID_REMOTE_URL_PATTERN = /^(?:https?:\/\/|git@)[^\s;|&`$]+$/;

/** Path prefixes a clone entry is dropped for outright, never materialized into the project. */
const INTERNAL_PATH_PREFIXES = ['.git/', '.collab/'];

/** Path values a clone entry is dropped for outright when they name the internal root itself. */
const INTERNAL_PATH_EXACT = new Set(['.git', '.collab']);

/**
 * Whether a clone entry's path names a platform-internal working-tree path (`.git/`, `.collab/`)
 * rather than genuine repository-tracked content. `.git/` is git's own metadata; `.collab/` is
 * where this platform keeps its own collaboration-session state beside the working tree —
 * neither is a file the repository's owner ever authored, so neither is ever imported as one,
 * however a (misbehaving, or maliciously crafted) clone response might list it.
 */
function isInternalPath(path: string): boolean {
  if (INTERNAL_PATH_EXACT.has(path)) return true;
  return INTERNAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Everything `ImportRepositoryUseCase.execute` needs to run an already-enqueued import. */
export interface ImportRepositoryInput {
  /**
   * The user who asked to import the repository. Any authenticated user may have started one —
   * there is no pre-existing membership to hold a role check against, since importing is what
   * grants the first one — and becomes the project's OWNER once the import commits.
   */
  readonly actorId: UserId;
  /**
   * The project this import fills in. Minted by the route when it enqueued the operation, along
   * with the `Project` and `GitRepository` rows this use case loads rather than creates.
   */
  readonly projectId: ProjectId;
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  readonly provider: string;
  /** The remote repository's URL. */
  readonly remoteUrl: string;
  /**
   * The plaintext access token to authenticate with. Passed straight through to
   * `GitCommandRunner.clone` and never persisted here — the route already stored the credential
   * before this ever runs.
   */
  readonly token: string;
  /** The branch to import. Defaults to the remote's default branch when omitted. */
  readonly branch?: string;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/** What a successful import hands back to its caller. */
export interface ImportRepositoryResult {
  /** The project the import filled in, now owned by the importing user. */
  readonly project: Project;
  /** The project's repository link, updated with what the clone observed. */
  readonly repository: GitRepository;
}

/**
 * What the guarded stretch of the import ended in: a built project, or the refusal to answer
 * with. Carried as one value, as `CloneProjectUseCase`'s `CloneOutcome` is, so a built result and
 * the failure that would discard it cannot both be set.
 */
type ImportOutcome =
  | { readonly built: true; readonly project: Project; readonly repository: GitRepository }
  | { readonly built: false; readonly error: DomainError };

/**
 * Runs an already-enqueued repository import to completion: clones the remote, builds a fresh
 * `FileNode`/`Document`/`Asset` tree from what it returns, and completes the project's repository
 * link — the all-or-nothing "import" flow.
 *
 * The `Project` row (memberless, and so invisible to every read path), the `GitRepository` link
 * (in its pre-import state), and the stored credential all already exist by the time this runs —
 * a route allocates the project identity and records the import intent synchronously (so the
 * `202` it returns already names a pollable project), and a later worker run is what invokes this
 * use case as the actual import. Either pre-created row being missing is a bug in that hand-off,
 * not a refusal this use case is positioned to explain to a user, so it is reported the same way
 * any other unexpected failure is: a {@link GitCommandFailedError}.
 *
 * Everything else mirrors `CloneProjectUseCase`'s ordering: the tree and the repository link's
 * completed fields are built first, and the actor's owner membership is the LAST write — the
 * commit point. A run that fails at any point before that write leaves nothing an owner-scoped
 * read path will ever surface; the cleanup below removes the tree (and stored bytes) this run
 * itself materialized, but deliberately leaves the invisible `Project` row, the `GitRepository`
 * link, and the credential intact — they persist so the operation stays pollable for a retry.
 *
 * This use case is deliberately just the execution logic — cloning, tree-building, and the
 * all-or-nothing commit — and does not itself claim, transition, or otherwise touch any
 * durable operation record. That is the git-worker run loop's job: claim the operation, decrypt
 * the stored credential, translate both into an `ImportRepositoryInput`, invoke this use case, and
 * transition the operation to its terminal state from the `Result` this returns.
 *
 * Single-flight does not apply here: the route's synchronous allocation is what already prevents
 * a second import from being enqueued against the same project.
 */
export class ImportRepositoryUseCase {
  /**
   * @param projectRepo - Loads the pre-allocated project and writes it once its root folder is known.
   * @param fileNodeRepo - Writes the project's root folder and cloned tree.
   * @param documentRepo - Writes a row for every cloned AsciiDoc/theme file.
   * @param assetRepo - Writes a row for every other cloned file.
   * @param fileStore - Holds the cloned bytes; cleared entirely on a failed import.
   * @param gitRepositoryRepo - Loads the pre-created repository link and writes it back completed.
   * @param commandRunner - Clones the remote's tracked files.
   * @param projectMemberRepo - Writes the owner-membership row that commits the import.
   * @param auditLogRepo - Records the successful import.
   * @param logger - Optional sink for best-effort failures that must stay visible.
   */
  constructor(
    private readonly projectRepo: ProjectRepository,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly assetRepo: AssetRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitRemotePort,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Runs the import named by `input.projectId` to completion.
   *
   * @param input - The acting user, the pre-allocated project, and the remote/credential to import.
   * @returns The completed project and its repository link on success; a typed refusal
   *   otherwise — a {@link ValidationError} for an unrecognized provider or malformed remote URL,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the clone fails, or
   *   a {@link GitCommandFailedError} for any other failure (including the pre-allocated rows
   *   being missing).
   */
  async execute(input: ImportRepositoryInput): Promise<Result<ImportRepositoryResult, DomainError>> {
    let provider: GitProvider;
    try {
      provider = GitProvider.create(input.provider);
    } catch (error) {
      if (error instanceof DomainError) return { success: false, error };
      throw error;
    }

    if (!VALID_REMOTE_URL_PATTERN.test(input.remoteUrl)) {
      return {
        success: false,
        error: new ValidationError(`Invalid Git remote URL: ${input.remoteUrl}`),
      };
    }

    // Both rows are expected to exist by the time a worker ever reaches this call — the route
    // creates them synchronously before the operation is even enqueued. Either being absent is a
    // bug in that hand-off, not a user-facing refusal, and nothing has been written yet for a
    // failure at this point to clean up.
    const project = await this.projectRepo.findById(input.projectId);
    const gitRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (project === null || gitRepository === null) {
      return {
        success: false,
        error: new GitCommandFailedError(
          `No pre-allocated project or repository link exists for project ${input.projectId.value}`,
        ),
      };
    }

    let outcome: ImportOutcome;
    try {
      const rootFolderId = FileNodeId.create(randomUUID());
      await this.fileNodeRepo.save(
        new FileNode(rootFolderId, input.projectId, null, project.name.value, FileNodeType.create('folder'), FilePath.create('/')),
      );

      const cloneResult = await this.commandRunner.clone({
        projectId: input.projectId,
        remoteUrl: input.remoteUrl,
        token: input.token,
        branch: input.branch,
      });

      if (cloneResult.success) {
        await this.materializeTree(input.projectId, rootFolderId, cloneResult.value.entries);

        // Reuses the loaded row's own id, provider, remote URL, and credential reference — the
        // link itself already exists; this write is what completes it with what the clone
        // observed. `syncStatus` becomes `UP_TO_DATE`, the only status a fresh import ever
        // produces — there is no transient or failure value in `GitSyncStatus`, and a run that
        // fails before reaching here leaves this row untouched instead.
        const updatedRepository = new GitRepository(
          gitRepository.id,
          gitRepository.projectId,
          gitRepository.provider,
          gitRepository.remoteUrl,
          gitRepository.credentialReference,
          input.branch ?? cloneResult.value.defaultBranch,
          'UP_TO_DATE',
          cloneResult.value.defaultBranch,
          cloneResult.value.headCommit,
          new Date(),
          gitRepository.createdAt,
          gitRepository.connectedByUserId,
        );
        await this.gitRepositoryRepo.save(updatedRepository);

        project.setRootFolderId(rootFolderId);
        await this.projectRepo.save(project);

        // The commit point: a project row with no membership is invisible to every read path, so
        // it is this write, not either row above, that makes the import findable at all.
        await this.projectMemberRepo.addMember(new ProjectMember(input.projectId, input.actorId, Role.create('owner')));

        outcome = { built: true, project, repository: updatedRepository };
      } else {
        outcome = { built: false, error: cloneResult.error };
      }
    } catch (error) {
      outcome = {
        built: false,
        error: error instanceof DomainError ? error : new GitCommandFailedError('The import could not be completed'),
      };
    }

    if (!outcome.built) {
      await this.cleanUpAbandonedImport(input.projectId);
      return { success: false, error: outcome.error };
    }

    // Only now, past the commit point — an audit entry for an import abandoned before the
    // membership row landed would describe a project no owner-scoped read path can ever reach.
    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        action: AUDIT_GIT_OPERATION_SUCCEEDED,
        resourceType: 'GitRepository',
        resourceId: outcome.repository.id.value,
        metadata: { kind: 'IMPORT', provider: provider.value },
        context: input.context,
      },
      this.logger,
    );

    return { success: true, value: { project: outcome.project, repository: outcome.repository } };
  }

  /**
   * Reproduces every cloned file under the project's just-created root folder, minting a fresh id
   * (and, for documents, a fresh `contentId`/`yjsStateId`) for each — nothing about a cloned file's
   * identity in this system reuses anything from the remote. Folders are implicit in each entry's
   * path and are created on demand as their first descendant is reached, so the tree structure
   * never has to be inferred from anything but the paths themselves. `.git/` and `.collab/` entries
   * are dropped outright: neither is genuine repository-tracked content a project owner authored.
   *
   * @param projectId - The project the tree is written under.
   * @param rootFolderId - The project's just-created root folder; every top-level entry is parented here.
   * @param entries - Every file the clone produced.
   */
  private async materializeTree(
    projectId: ProjectId,
    rootFolderId: FileNodeId,
    entries: readonly ClonedFileEntry[],
  ): Promise<void> {
    const folderIdByPath = new Map<string, FileNodeId>([['', rootFolderId]]);

    for (const entry of entries) {
      if (isInternalPath(entry.path)) continue;

      const segments = entry.path.split('/').filter((segment) => segment.length > 0);
      if (segments.length === 0) continue;

      const fileName = segments.at(-1)!;
      const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), folderIdByPath);

      const fileNodeId = FileNodeId.create(randomUUID());
      const filePath = FilePath.create(`/${segments.join('/')}`);
      await this.fileNodeRepo.save(
        new FileNode(fileNodeId, projectId, parentId, fileName, FileNodeType.create('file'), filePath),
      );

      await this.fileStore.write(projectId, filePath, entry.content);

      const mimeType = MimeType.create(entry.mimeType);

      // A cloned AsciiDoc file, or a theme file (which the theme editor needs live Yjs state to
      // co-edit — the same rule `UploadAssetUseCase` applies to an uploaded theme file), becomes a
      // `Document`; everything else becomes an opaque `Asset` (Asset.id == FileNode.id, a 1:1 FK
      // relationship). Nothing here inspects file bytes — an LFS pointer is already resolved to
      // real bytes by the time `GitCommandRunner.clone` returns an entry, so a large binary is
      // handled exactly like any other asset.
      await (isAsciiDocumentFileName(fileName) || isThemeFilePath(entry.path)
        ? this.documentRepo.save(
            new Document(DocumentId.create(randomUUID()), fileNodeId, ContentId.create(randomUUID()), YjsStateId.create(randomUUID()), mimeType),
          )
        : this.assetRepo.save(new Asset(fileNodeId, mimeType, BigInt(entry.content.length))));
    }
  }

  /**
   * Returns the id of the folder at `segments` under the project's root, creating it — and every
   * ancestor it needs — on demand. Recursion (rather than requiring entries in parent-before-child
   * order) is what lets `materializeTree` accept a clone's entries in whatever order the runner
   * produced them.
   */
  private async ensureFolder(
    projectId: ProjectId,
    segments: readonly string[],
    folderIdByPath: Map<string, FileNodeId>,
  ): Promise<FileNodeId> {
    const key = segments.join('/');
    const existing = folderIdByPath.get(key);
    if (existing !== undefined) return existing;

    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), folderIdByPath);
    const folderId = FileNodeId.create(randomUUID());
    const name = segments.at(-1)!;
    const path = FilePath.create(`/${segments.join('/')}`);
    await this.fileNodeRepo.save(new FileNode(folderId, projectId, parentId, name, FileNodeType.create('folder'), path));

    folderIdByPath.set(key, folderId);
    return folderId;
  }

  /**
   * Undoes an abandoned import, so a run that failed leaves nothing behind but the pre-existing,
   * invisible `Project` row, its `GitRepository` link, and the stored credential — all three
   * persist on purpose (route-owned, and needed for the operation to stay pollable), so none of
   * them is touched here.
   *
   * Only what this run itself materialized is removed: the tree (and the stored bytes underneath
   * it) rooted at the folder this run created. Deleting it is safe unconditionally — nothing but a
   * successful import ever writes into a project's tree before its owner-membership row lands, so
   * an invisible project can hold nothing this run did not itself just write.
   *
   * @param projectId - The project the failed import ran against.
   */
  private async cleanUpAbandonedImport(projectId: ProjectId): Promise<void> {
    await this.attemptCleanup("the abandoned import's materialized tree", () =>
      this.removeMaterializedTree(projectId),
    );
    await this.attemptCleanup("the abandoned import's stored files", () => this.fileStore.removeProject(projectId));
  }

  /** Removes every `FileNode` recorded under the project, along with each one's `Document` or `Asset` row. */
  private async removeMaterializedTree(projectId: ProjectId): Promise<void> {
    const nodes = await this.fileNodeRepo.findByProjectId(projectId);
    for (const node of nodes) {
      const document = await this.documentRepo.findByFileNodeId(node.id);
      if (document !== null) await this.documentRepo.delete(document.id);
      await this.assetRepo.delete(node.id);
      await this.fileNodeRepo.delete(node.id);
    }
  }

  private async attemptCleanup(what: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      this.logger?.warn(`Could not remove ${what} after the import failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
