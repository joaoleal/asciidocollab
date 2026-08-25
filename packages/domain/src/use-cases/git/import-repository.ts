import { randomUUID } from 'crypto';
import { isThemeFilePath } from '@asciidocollab/asciidoc-core';
import { FileNode } from '../../entities/file-node';
import { Document } from '../../entities/document';
import { Asset } from '../../entities/asset';
import { GitRepository } from '../../entities/git-repository';
import { GitOperation } from '../../entities/git-operation';
import { FileNodeId } from '../../value-objects/ids/file-node-id';
import { DocumentId } from '../../value-objects/ids/document-id';
import { ContentId } from '../../value-objects/ids/content-id';
import { YjsStateId } from '../../value-objects/ids/yjs-state-id';
import { GitRepositoryId } from '../../value-objects/ids/git-repository-id';
import { ProjectId } from '../../value-objects/ids/project-id';
import { UserId } from '../../value-objects/ids/user-id';
import { GitProvider } from '../../value-objects/project/git-provider';
import { MimeType } from '../../value-objects/files/mime-type';
import { FileNodeType } from '../../value-objects/files/file-node-type';
import { FilePath } from '../../value-objects/files/file-path';
import { isAsciiDocumentFileName } from '../../value-objects/files/asciidoc-file-name';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { AssetRepository } from '../../ports/file-tree/asset.repository';
import { ProjectFileStore } from '../../ports/storage/project-file-store';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { GitCredentialStore } from '../../ports/git/git-credential-store';
import { ClonedFileEntry, GitCommandRunner } from '../../ports/git/git-command-runner';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { ProjectMemberRepository } from '../../ports/project/project-member.repository';
import { AuditLogRepository } from '../../ports/admin/audit-log.repository';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { ValidationError } from '../../errors/common/validation-error';
import { RepositoryAlreadyConnectedError } from '../../errors/git/repository-already-connected';
import { GitOperationInProgressError } from '../../errors/git/git-operation-in-progress';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
// Referenced only from this file's own JSDoc @link tags (never thrown directly here) —
// InsufficientRoleError is raised inside requireGitRole, and the remote-access failures are raised
// inside GitCommandRunner.clone; kept imported so the links resolve to real symbols.
import type { InsufficientRoleError } from '../../errors/git/insufficient-role';
import type { RepositoryUnreachableError } from '../../errors/git/repository-unreachable';
import type { AuthenticationFailedError } from '../../errors/git/authentication-failed';
import { requireGitRole } from './git-role-guard';
import { Result } from '../../types/result';
import { RequestContext } from '../../types/request-context';
import { recordAuditSuccess } from '../audit-recording';
import { AUDIT_GIT_OPERATION_SUCCEEDED } from '../../audit-actions';

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
 * How long a claimed operation may go without a heartbeat before it is considered abandoned.
 * Passed to `claimNextQueued`, which this use case calls once, immediately after enqueuing its own
 * operation — so in practice this only matters if a previous, crashed run left the operation
 * `RUNNING` with a stale heartbeat; a fresh `QUEUED` operation is always claimed regardless.
 */
const CLAIM_STALE_HEARTBEAT_AFTER_MS = 5 * 60_000;

/**
 * Whether a clone entry's path names a platform-internal working-tree path (`.git/`, `.collab/`)
 * rather than genuine repository-tracked content. `.git/` is git's own metadata; `.collab/` is
 * where this platform keeps its own collaboration-session state beside the working tree
 * (data-model.md) — neither is a file the repository's owner ever authored, so neither is ever
 * imported as one, however a (misbehaving, or maliciously crafted) clone response might list it.
 */
function isInternalPath(path: string): boolean {
  if (INTERNAL_PATH_EXACT.has(path)) return true;
  return INTERNAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Everything `ImportRepositoryUseCase.execute` needs to import a remote into a project. */
export interface ImportRepositoryInput {
  /** The user asking to import the repository. Must be the project's OWNER. */
  readonly actorId: UserId;
  /**
   * The project to import into. Import connects this project to the remote and populates its
   * file tree from the remote's default (or requested) branch — it does not create the project
   * itself, the same way `ConnectRepository` does not.
   */
  readonly projectId: ProjectId;
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
  /** The newly created repository link. */
  readonly repository: GitRepository;
  /** The completed `GitOperation` record for this import. */
  readonly operation: GitOperation;
}

/** Tracks every write this run's tree materialization made, so a failure can undo exactly those. */
interface MaterializedTree {
  /** Every `FileNode` (folder or file) created, in the order it was written — parent before child. */
  readonly createdFileNodeIds: FileNodeId[];
  /** Every `Document` row created. */
  readonly createdDocumentIds: DocumentId[];
  /** Every `Asset` row created, keyed by its owning `FileNode` id (`Asset.id === FileNode.id`). */
  readonly createdAssetIds: FileNodeId[];
  /** Every path written to the project's file store. */
  readonly writtenPaths: FilePath[];
}

function emptyTree(): MaterializedTree {
  return { createdFileNodeIds: [], createdDocumentIds: [], createdAssetIds: [], writtenPaths: [] };
}

/**
 * What the guarded stretch of the import ended in: a connected repository, or the refusal to
 * answer with. Carried as one value, as `CloneProjectUseCase`'s `CloneOutcome` is, so a built
 * result and the failure that would discard it cannot both be set.
 */
type ImportOutcome =
  | { readonly built: true; readonly repository: GitRepository }
  | { readonly built: false; readonly error: DomainError };

/**
 * Connects a project to an external Git remote and populates its file tree from the remote's
 * default (or requested) branch — the all-or-nothing "import" flow.
 *
 * Mirrors `CloneProjectUseCase`'s all-or-nothing shape, but its single load-bearing ordering
 * choice is different, for a reason worth spelling out. Clone defers its new project's *own*
 * owner-membership row to the very last write, because a project row with no membership is
 * invisible to every read path — that is what makes a failed clone leave nothing for anyone to
 * find. Import has no equivalent row to defer: it acts on a project the caller already owns (like
 * `ConnectRepository`, not like `CloneProjectUseCase`), so that project is visible throughout,
 * succeed or fail. What import *can* defer — and does — is the one write that would otherwise let
 * the project look "connected" before it genuinely is: the `GitRepository` row itself. Every
 * earlier write (the file tree, the stored credential) is undone by this use case's own cleanup on
 * any failure, so a project that never finishes an import is left exactly as it stood before the
 * attempt — not stranded mid-way with a remote link nothing populated.
 *
 * Single-flight — never running two mutating git actions against the same project at once — is
 * enforced by checking `GitOperationRepository.findActiveOperation`
 * before enqueuing this import's own `GitOperation`, rather than by `withGuard`'s row-touch. This
 * matters because import runs before any `GitRepository` row exists for the project (it is what
 * creates that row) — so a guard that assumed one already existed would never fire for the very
 * case it exists to cover. `findActiveOperation` and `enqueue` are both keyed on the *project*,
 * which — unlike the `GitRepository` link — already exists by the time import is asked for, so the
 * guard holds from the first call onward.
 */
export class ImportRepositoryUseCase {
  /**
   * @param fileNodeRepo - Reads the project's existing root folder and writes the cloned tree.
   * @param documentRepo - Writes a row for every cloned AsciiDoc/theme file.
   * @param assetRepo - Writes a row for every other cloned file.
   * @param fileStore - Holds the cloned bytes.
   * @param gitRepositoryRepo - Reads whether the project is already connected, and writes the link.
   * @param credentialStore - Encrypts and persists the access credential.
   * @param commandRunner - Clones the remote's tracked files.
   * @param gitOperationRepo - The durable work-list, single-flight guard, and progress tracker.
   * @param projectMemberRepo - Resolves the actor's role for the authorization check.
   * @param auditLogRepo - Records the authorization denial and the successful import.
   * @param logger - Optional sink for best-effort failures that must stay visible.
   */
  constructor(
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly assetRepo: AssetRepository,
    private readonly fileStore: ProjectFileStore,
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly credentialStore: GitCredentialStore,
    private readonly commandRunner: GitCommandRunner,
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly projectMemberRepo: ProjectMemberRepository,
    private readonly auditLogRepo: AuditLogRepository,
    private readonly logger?: Logger,
  ) {}

  /**
   * Imports the given remote's branch into the project.
   *
   * @param input - The acting user, the project, and the remote/credential to import.
   * @returns The created repository link on success; a typed refusal otherwise —
   *   {@link InsufficientRoleError} (via {@link requireGitRole}) when the actor is not the
   *   project's OWNER, a {@link ValidationError} for an unrecognized provider or malformed remote
   *   URL, {@link RepositoryAlreadyConnectedError} when the project already has a repository link,
   *   {@link GitOperationInProgressError} when another git action is already in flight for this
   *   project, {@link RepositoryUnreachableError}/{@link AuthenticationFailedError} when the clone
   *   fails, or a {@link GitCommandFailedError} for any other failure — including the project
   *   having no root folder to import into, which should not happen for a project created through
   *   the ordinary project-creation path.
   */
  async execute(input: ImportRepositoryInput): Promise<Result<ImportRepositoryResult, DomainError>> {
    const roleCheck = await requireGitRole(
      this.projectMemberRepo,
      this.auditLogRepo,
      {
        actorId: input.actorId,
        projectId: input.projectId,
        requiredRole: 'owner',
        context: input.context,
      },
      this.logger,
    );
    if (!roleCheck.success) return roleCheck;

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

    // Checked here, ahead of the single-flight guard and the clone itself, so a project that is
    // already connected is a typed refusal rather than a storage-layer unique-constraint error
    // surfacing from `gitRepositoryRepo.save` (the entity's 1:1 relationship with a project).
    const existingRepository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (existingRepository !== null) {
      return { success: false, error: new RepositoryAlreadyConnectedError() };
    }

    // Single-flight (see the class docstring for why this, and not `withGuard`, is the right tool
    // here). A TOCTOU race between this check and the `enqueue` below is real at the domain layer —
    // the in-memory fake used in tests has no atomic test-and-set either — but the real adapter's
    // partial-unique index on `(projectId) WHERE state IN (...)` (data-model.md) is what actually
    // closes it; this check is the fast, typed refusal path for the overwhelmingly common case of
    // two *sequential* requests, not the sole guarantee.
    const activeOperation = await this.gitOperationRepo.findActiveOperation(input.projectId);
    if (activeOperation !== null) {
      return { success: false, error: new GitOperationInProgressError() };
    }

    const rootFolder = await this.findRootFolder(input.projectId);
    if (rootFolder === null) {
      return {
        success: false,
        error: new GitCommandFailedError('The project has no root folder to import into'),
      };
    }

    return this.importWhileGuarded(input, provider, rootFolder.id);
  }

  /**
   * Runs the clone and, on success, materializes the tree, stores the credential, and creates the
   * repository link — the part of the flow that runs under this import's own `GitOperation`.
   */
  private async importWhileGuarded(
    input: ImportRepositoryInput,
    provider: GitProvider,
    rootFolderId: FileNodeId,
  ): Promise<Result<ImportRepositoryResult, DomainError>> {
    const enqueued = await this.gitOperationRepo.enqueue({
      projectId: input.projectId,
      kind: 'IMPORT',
      triggeredByUserId: input.actorId,
      branch: input.branch ?? null,
    });
    // Claims this same operation (it is the only one queued for this project): moves it to
    // RUNNING with a fresh heartbeat, which is what makes it visible to another caller's
    // `findActiveOperation` check for the whole rest of this run.
    const operation = (await this.gitOperationRepo.claimNextQueued(CLAIM_STALE_HEARTBEAT_AFTER_MS)) ?? enqueued;

    // Allocated before the guarded stretch, and mutated in place rather than returned, so that a
    // failure partway through `materializeTree` — which throws through, rather than returning —
    // still leaves the cleanup below able to see (and undo) whatever had already been written.
    const tree = emptyTree();
    let outcome: ImportOutcome;

    try {
      const cloneResult = await this.commandRunner.clone({
        remoteUrl: input.remoteUrl,
        token: input.token,
        branch: input.branch,
      });

      if (!cloneResult.success) {
        outcome = { built: false, error: cloneResult.error };
      } else {
        await this.materializeTree(input.projectId, rootFolderId, cloneResult.value.entries, tree);

        // The store encrypts this internally — the plaintext token is never held here beyond
        // this call, and never appears in what gets persisted.
        await this.credentialStore.save(input.projectId, {
          token: input.token,
          provider,
          createdByUserId: input.actorId,
        });

        const repository = new GitRepository(
          GitRepositoryId.create(randomUUID()),
          input.projectId,
          provider,
          input.remoteUrl,
          // The credential store is keyed by projectId (one credential per project), so the
          // project id itself is the reference the repository link needs to find it back.
          input.projectId.value,
          input.branch ?? cloneResult.value.defaultBranch,
          undefined,
          cloneResult.value.defaultBranch,
          cloneResult.value.headCommit,
          null,
          new Date(),
          input.actorId,
        );
        // The commit point (see the class docstring): nothing before this write treats the
        // project as imported, so a failure at any earlier step below leaves nothing for the
        // cleanup to discard but the tree and credential it undoes itself.
        await this.gitRepositoryRepo.save(repository);

        outcome = { built: true, repository };
      }
    } catch (error) {
      outcome = {
        built: false,
        error: error instanceof DomainError ? error : new GitCommandFailedError('The import could not be completed'),
      };
    }

    if (!outcome.built) {
      await this.gitOperationRepo.transition(operation.id, 'FAILED', { errorCode: outcome.error.name });
      await this.cleanUpFailedImport(input.projectId, tree);
      return { success: false, error: outcome.error };
    }

    const transitioned = await this.gitOperationRepo.transition(operation.id, 'SUCCEEDED');

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

    return {
      success: true,
      value: {
        repository: outcome.repository,
        operation: transitioned.success ? transitioned.value : operation,
      },
    };
  }

  /** Finds the project's root folder (the node at the root path `/`), or null if it has none. */
  private async findRootFolder(projectId: ProjectId): Promise<FileNode | null> {
    const nodes = await this.fileNodeRepo.findByProjectId(projectId);
    return nodes.find((node) => node.path.value === '/') ?? null;
  }

  /**
   * Reproduces every cloned file under the project's existing root folder, minting a fresh id
   * (and, for documents, a fresh `contentId`/`yjsStateId`) for each — nothing about a cloned file's
   * identity in this system reuses anything from the remote. Folders are implicit in each entry's
   * path and are created on demand as their first descendant is reached, so the tree structure
   * never has to be inferred from anything but the paths themselves. `.git/` and `.collab/` entries
   * are dropped outright: neither is genuine repository-tracked content a project owner authored.
   *
   * @param projectId - The project the tree is written under.
   * @param rootFolderId - The project's existing root folder; every top-level entry is parented here.
   * @param entries - Every file the clone produced.
   * @param tree - Mutated in place as each row/byte is written — allocated by the caller, before
   *   this call, so that a failure partway through (this method throws rather than returning on
   *   any write failure) still leaves the caller able to see, and undo, everything written so far.
   */
  private async materializeTree(
    projectId: ProjectId,
    rootFolderId: FileNodeId,
    entries: readonly ClonedFileEntry[],
    tree: MaterializedTree,
  ): Promise<void> {
    const folderIdByPath = new Map<string, FileNodeId>([['', rootFolderId]]);

    for (const entry of entries) {
      if (isInternalPath(entry.path)) continue;

      const segments = entry.path.split('/').filter((segment) => segment.length > 0);
      if (segments.length === 0) continue;

      const fileName = segments[segments.length - 1];
      const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), folderIdByPath, tree);

      const fileNodeId = FileNodeId.create(randomUUID());
      const filePath = FilePath.create(`/${segments.join('/')}`);
      await this.fileNodeRepo.save(
        new FileNode(fileNodeId, projectId, parentId, fileName, FileNodeType.create('file'), filePath),
      );
      tree.createdFileNodeIds.push(fileNodeId);

      await this.fileStore.write(projectId, filePath, entry.content);
      tree.writtenPaths.push(filePath);

      const mimeType = MimeType.create(entry.mimeType);

      // A cloned AsciiDoc file, or a theme file (which the theme editor needs live Yjs state to
      // co-edit — the same rule `UploadAssetUseCase` applies to an uploaded theme file), becomes a
      // `Document`; everything else becomes an opaque `Asset`. Nothing here inspects file bytes —
      // an LFS pointer is already resolved to real bytes by the time `GitCommandRunner.clone`
      // returns an entry, so a large binary is handled exactly like any other asset.
      if (isAsciiDocumentFileName(fileName) || isThemeFilePath(entry.path)) {
        const documentId = DocumentId.create(randomUUID());
        await this.documentRepo.save(
          new Document(documentId, fileNodeId, ContentId.create(randomUUID()), YjsStateId.create(randomUUID()), mimeType),
        );
        tree.createdDocumentIds.push(documentId);
      } else {
        // Asset.id == FileNode.id (1:1 FK relationship).
        await this.assetRepo.save(new Asset(fileNodeId, mimeType, BigInt(entry.content.length)));
        tree.createdAssetIds.push(fileNodeId);
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
    tree: MaterializedTree,
  ): Promise<FileNodeId> {
    const key = segments.join('/');
    const existing = folderIdByPath.get(key);
    if (existing !== undefined) return existing;

    const parentId = await this.ensureFolder(projectId, segments.slice(0, -1), folderIdByPath, tree);
    const folderId = FileNodeId.create(randomUUID());
    const name = segments[segments.length - 1];
    const path = FilePath.create(`/${segments.join('/')}`);
    await this.fileNodeRepo.save(new FileNode(folderId, projectId, parentId, name, FileNodeType.create('folder'), path));

    tree.createdFileNodeIds.push(folderId);
    folderIdByPath.set(key, folderId);
    return folderId;
  }

  /**
   * Undoes a failed import so the project is left exactly as it stood before the attempt: every
   * row and byte this run itself wrote, and (defensively) any credential or repository-link row
   * that made it past the point that failed. Nothing here may hide the failure that caused it, so
   * each step is attempted independently and a step that fails is logged rather than raised.
   *
   * @param projectId - The project the import was attempted against.
   * @param tree - Everything `materializeTree` wrote before the failure — possibly nothing, if the
   *   clone itself never returned a repository to materialize.
   */
  private async cleanUpFailedImport(projectId: ProjectId, tree: MaterializedTree): Promise<void> {
    for (const path of tree.writtenPaths) {
      await this.attemptCleanup(`the imported file at ${path.value}`, () => this.fileStore.remove(projectId, path));
    }
    for (const documentId of tree.createdDocumentIds) {
      await this.attemptCleanup('an imported document row', () => this.documentRepo.delete(documentId));
    }
    for (const assetId of tree.createdAssetIds) {
      await this.attemptCleanup('an imported asset row', () => this.assetRepo.delete(assetId));
    }
    // Children before parents: nothing here relies on the database to cascade a delete order.
    for (const fileNodeId of [...tree.createdFileNodeIds].reverse()) {
      await this.attemptCleanup('an imported file-tree node', () => this.fileNodeRepo.delete(fileNodeId));
    }

    await this.attemptCleanup('the stored credential', () => this.credentialStore.delete(projectId));
    await this.attemptCleanup('the repository link', async () => {
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
