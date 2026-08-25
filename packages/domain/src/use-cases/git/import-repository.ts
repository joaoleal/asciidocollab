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
import { GitRepositoryId } from '../../value-objects/ids/git-repository-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { GitProvider } from '../../value-objects/project/git-provider';
import { ProjectName } from '../../value-objects/project/project-name';
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
import { GitCredentialStore } from '../../ports/git/git-credential-store';
import { ClonedFileEntry, GitCommandRunner } from '../../ports/git/git-command-runner';
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
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
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

/** The name a new import falls back to when nothing usable can be derived from the remote URL. */
const FALLBACK_PROJECT_NAME = 'Imported repository';

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

/**
 * Derives a starting project name from a remote URL: the last path segment, with any trailing
 * `.git` suffix removed (e.g. `https://github.com/acme/handbook.git` → `handbook`). Falls back to
 * a fixed name when nothing usable can be extracted, so a name that fails `ProjectName`'s own
 * validation is never possible for a well-formed remote URL, however unusual its final segment.
 */
function deriveProjectName(remoteUrl: string): string {
  const withoutGitSuffix = remoteUrl.replace(/\.git$/i, '');
  const segments = withoutGitSuffix.split(/[/:]+/).map((segment) => segment.trim()).filter(Boolean);
  const lastSegment = segments.pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : FALLBACK_PROJECT_NAME;
}

/** Everything `ImportRepositoryUseCase.execute` needs to import a remote as a new project. */
export interface ImportRepositoryInput {
  /**
   * The user asking to import the repository. Any authenticated user may do so — there is no
   * pre-existing project to hold a role on — and becomes the new project's OWNER.
   */
  readonly actorId: UserId;
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  readonly provider: string;
  /** The remote repository's URL. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Encrypted before storage, never persisted as-is. */
  readonly token: string;
  /** The branch to import. Defaults to the remote's default branch when omitted. */
  readonly branch?: string;
  /** Request origin, captured into audit metadata. */
  readonly context?: RequestContext;
}

/** What a successful import hands back to its caller. */
export interface ImportRepositoryResult {
  /** The newly created project, owned by the importing user. */
  readonly project: Project;
  /** The new project's repository link. */
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
 * Imports an external Git remote's default (or requested) branch as a brand-new project: clones
 * it, builds a fresh `FileNode`/`Document`/`Asset` tree from what it returns, and connects the new
 * project to the remote — the all-or-nothing "import" flow.
 *
 * Any authenticated user may call this: there is no existing project to hold a role check
 * against, since this use case is what creates the project. Mirrors `CloneProjectUseCase`'s
 * ordering exactly — the project row is created early (memberless, and so invisible to every read
 * path), everything else is built inside the same guarded stretch, and the actor's owner
 * membership is the LAST write: the commit point. A run that fails at any point before that write
 * — the clone itself, the tree, the stored credential, the repository link — leaves nothing an
 * owner-scoped read path will ever surface, and the cleanup below discards the row (and, via the
 * database's own cascade, everything hung off it) plus the stored files and credential a fake
 * cannot cascade away on its own.
 *
 * This use case is deliberately just the execution logic — cloning, tree-building, and the
 * all-or-nothing commit — and does not enqueue, claim, or transition any `GitOperation` itself.
 * Import is dispatched asynchronously (the route responds `202` immediately): the route is what
 * enqueues the durable operation record, and the git-worker's run loop is what claims it and
 * would invoke this use case (via a thin adapter translating the claimed operation and its
 * decrypted credential into an `ImportRepositoryInput`) as the registered handler for the `IMPORT`
 * kind, then transitions the operation to its terminal state from the `Result` this returns. None
 * of that wiring exists yet — this class has no `GitOperationRepository` dependency so it stays
 * callable synchronously today, and remains a clean, single seam for that adapter to close over
 * once the route and worker registration are built.
 *
 * Single-flight does not apply to this create path: every import mints its own new project, so
 * there is never a pre-existing project for a concurrent import to collide with — the single-flight
 * guard other git actions need (via `GitOperationRepository`) has nothing to guard here.
 */
export class ImportRepositoryUseCase {
  /**
   * @param projectRepo - Writes the new project's row, and deletes it on a failed import.
   * @param fileNodeRepo - Writes the new project's root folder and cloned tree.
   * @param documentRepo - Writes a row for every cloned AsciiDoc/theme file.
   * @param assetRepo - Writes a row for every other cloned file.
   * @param fileStore - Holds the cloned bytes; cleared entirely on a failed import.
   * @param gitRepositoryRepo - Writes the new project's repository link.
   * @param credentialStore - Encrypts and persists the access credential.
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
    private readonly credentialStore: GitCredentialStore,
    private readonly commandRunner: GitCommandRunner,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Imports the given remote's branch as a new project owned by `input.actorId`.
   *
   * @param input - The acting user and the remote/credential to import.
   * @returns The new project and its repository link on success; a typed refusal otherwise — a
   *   {@link ValidationError} for an unrecognized provider or malformed remote URL,
   *   {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the clone fails, or
   *   a {@link GitCommandFailedError} for any other failure.
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

    let projectName: ProjectName;
    try {
      projectName = ProjectName.create(deriveProjectName(input.remoteUrl));
    } catch (error) {
      if (error instanceof DomainError) return { success: false, error };
      throw error;
    }

    // Minted before any write, exactly as `CloneProjectUseCase` mints its clone id: the
    // compensating cleanup needs something to name whatever happens next, including a project row
    // whose own write is what fails.
    const projectId = ProjectId.create(randomUUID());

    let outcome: ImportOutcome;
    try {
      const project = new Project(projectId, projectName, null, [], null);
      await this.projectRepo.save(project);

      const rootFolderId = FileNodeId.create(randomUUID());
      await this.fileNodeRepo.save(
        new FileNode(rootFolderId, projectId, null, projectName.value, FileNodeType.create('folder'), FilePath.create('/')),
      );

      const cloneResult = await this.commandRunner.clone({
        remoteUrl: input.remoteUrl,
        token: input.token,
        branch: input.branch,
      });

      if (!cloneResult.success) {
        outcome = { built: false, error: cloneResult.error };
      } else {
        await this.materializeTree(projectId, rootFolderId, cloneResult.value.entries);

        // The store encrypts this internally — the plaintext token is never held here beyond
        // this call, and never appears in what gets persisted.
        await this.credentialStore.save(projectId, {
          token: input.token,
          provider,
          createdByUserId: input.actorId,
        });

        const repository = new GitRepository(
          GitRepositoryId.create(randomUUID()),
          projectId,
          provider,
          input.remoteUrl,
          // The credential store is keyed by projectId (one credential per project), so the
          // project id itself is the reference the repository link needs to find it back.
          projectId.value,
          input.branch ?? cloneResult.value.defaultBranch,
          undefined,
          cloneResult.value.defaultBranch,
          cloneResult.value.headCommit,
          null,
          new Date(),
          input.actorId,
        );
        await this.gitRepositoryRepo.save(repository);

        project.setRootFolderId(rootFolderId);
        await this.projectRepo.save(project);

        // The commit point: a project row with no membership is invisible to every read path, so
        // it is this write, not the project row above, that makes the import findable at all.
        await this.projectMemberRepo.addMember(new ProjectMember(projectId, input.actorId, Role.create('owner')));

        outcome = { built: true, project, repository };
      }
    } catch (error) {
      outcome = {
        built: false,
        error: error instanceof DomainError ? error : new GitCommandFailedError('The import could not be completed'),
      };
    }

    if (!outcome.built) {
      await this.cleanUpAbandonedImport(projectId);
      return { success: false, error: outcome.error };
    }

    // Only now, past the commit point — an audit entry for an import abandoned before the
    // membership row landed would outlive the project the cleanup above just removed.
    await recordAuditSuccess(
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId,
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

      const fileName = segments[segments.length - 1];
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
      // `Document`; everything else becomes an opaque `Asset`. Nothing here inspects file bytes —
      // an LFS pointer is already resolved to real bytes by the time `GitCommandRunner.clone`
      // returns an entry, so a large binary is handled exactly like any other asset.
      if (isAsciiDocumentFileName(fileName) || isThemeFilePath(entry.path)) {
        await this.documentRepo.save(
          new Document(DocumentId.create(randomUUID()), fileNodeId, ContentId.create(randomUUID()), YjsStateId.create(randomUUID()), mimeType),
        );
      } else {
        // Asset.id == FileNode.id (1:1 FK relationship).
        await this.assetRepo.save(new Asset(fileNodeId, mimeType, BigInt(entry.content.length)));
      }
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
    const name = segments[segments.length - 1];
    const path = FilePath.create(`/${segments.join('/')}`);
    await this.fileNodeRepo.save(new FileNode(folderId, projectId, parentId, name, FileNodeType.create('folder'), path));

    folderIdByPath.set(key, folderId);
    return folderId;
  }

  /**
   * Undoes an abandoned import, so a run that failed leaves nothing behind.
   *
   * Deleting the project row cascades (in a real database) to everything hung off it — file
   * nodes, documents, assets, and the repository link — leaving only the stored files and
   * credential, which are removed here directly since neither is a row the project's own deletion
   * can cascade away. Each step is attempted independently and a step that fails is logged rather
   * than raised — a row delete the database refuses must not also leave the import's bytes or
   * credential behind, and vice versa.
   *
   * @param projectId - The project the failed import would have produced.
   */
  private async cleanUpAbandonedImport(projectId: ProjectId): Promise<void> {
    await this.attemptCleanup('the abandoned import\'s project row', () => this.projectRepo.delete(projectId));
    await this.attemptCleanup('the abandoned import\'s stored files', () => this.fileStore.removeProject(projectId));
    await this.attemptCleanup('the abandoned import\'s stored credential', () => this.credentialStore.delete(projectId));
    await this.attemptCleanup('the abandoned import\'s repository link', async () => {
      const existing = await this.gitRepositoryRepo.findByProjectId(projectId);
      if (existing !== null) await this.gitRepositoryRepo.delete(existing.id);
    });
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
