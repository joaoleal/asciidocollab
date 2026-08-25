import { ProjectId } from '../../value-objects/ids/project-id';
import { FilePath } from '../../value-objects/files/file-path';
import { FileNode } from '../../entities/file-node';
import { GitCommandRunner, GitDiffResult } from '../../ports/git/git-command-runner';
import { GitRepositoryRepository } from '../../ports/project/git-repository.repository';
import { FileNodeRepository } from '../../ports/file-tree/file-node.repository';
import { DocumentRepository } from '../../ports/file-tree/document.repository';
import { CollaborationSessionRepository } from '../../ports/project/collaboration-session.repository';
import { CollaborativeContentReader } from '../../ports/storage/collaborative-content-reader';
import { Logger } from '../../ports/observability/logger';
import { DomainError } from '../../errors/domain-error';
import { RepositoryNotConnectedError } from '../../errors/git/repository-not-connected';
import { GitCommandFailedError } from '../../errors/git/git-command-failed';
import { resolveDownloadContentSource } from '../project/download-content-source';
import { Result } from '../../types/result';

/** Everything `GetDiffUseCase.execute` needs to produce a unified diff. */
export interface GetDiffInput {
  /** The project whose repository to diff. */
  readonly projectId: ProjectId;
  /** When given, scopes the diff to this single project-relative file (whole tree when absent). */
  readonly path?: string;
  /** The earlier commit hash. Given together with `to` to diff between two commits. */
  readonly from?: string;
  /** The later commit hash. Given together with `from` to diff between two commits. */
  readonly to?: string;
}

/** What `GetDiffUseCase.execute` returns on success — the same shape the port itself returns. */
export type GetDiffResult = GitDiffResult;

/**
 * Produces a unified diff for a project: either between two commits, or of the uncommitted working
 * changes against HEAD.
 *
 * Read-only and lock-free — this is a local diff read, not a mutating git action, so it takes no
 * single-flight guard and enforces no role beyond what the calling route requires.
 *
 * Two modes: when both `from` and `to` are given, this diffs between those two commits, exactly as
 * given, with no live-content involvement. Otherwise it diffs the uncommitted working changes since
 * the last commit. In that uncommitted mode, when a single `path` is given AND that file is open in
 * the collaborative editor (an active session over a resolvable document), the diff's current side
 * reflects the file's LIVE editor content rather than its possibly-stale working-tree copy — the use
 * case resolves that live text and hands it to the port as a `currentContent` override. A whole-tree
 * uncommitted diff (no `path`) never substitutes live content; only a single named file's live text is
 * ever read. If that live read fails outright, the diff is refused rather than silently showing stale
 * content.
 */
export class GetDiffUseCase {
  /**
   * @param gitRepositoryRepo - Confirms the project has a connected repository.
   * @param commandRunner - Produces the actual diff.
   * @param fileNodeRepo - Loads the project's file nodes to map a requested path to its node.
   * @param documentRepo - Resolves a file node's document to find its live collaborative state.
   * @param collaborationSessionRepo - Tells whether a document has an active collaborative session.
   * @param collaborativeContentReader - Reads a document's current live text.
   * @param logger - Optional sink for best-effort diagnostics.
   */
  constructor(
    private readonly gitRepositoryRepo: GitRepositoryRepository,
    private readonly commandRunner: GitCommandRunner,
    private readonly fileNodeRepo: FileNodeRepository,
    private readonly documentRepo: DocumentRepository,
    private readonly collaborationSessionRepo: CollaborationSessionRepository,
    private readonly collaborativeContentReader: CollaborativeContentReader,
    private readonly logger?: Logger,
  ) {}

  /**
   * Produces the diff described by `input`.
   *
   * @param input - The project, the optional path to scope to, and the optional commit pair.
   * @returns The unified diff on success; a {@link RepositoryNotConnectedError} when the project has
   *   no repository link, a {@link GitCommandFailedError} when a single open file's live content
   *   could not be read, or the `GitCommandFailedError` the underlying diff itself fails with.
   */
  async execute(input: GetDiffInput): Promise<Result<GetDiffResult, DomainError>> {
    const repository = await this.gitRepositoryRepo.findByProjectId(input.projectId);
    if (repository === null) {
      return { success: false, error: new RepositoryNotConnectedError() };
    }

    if (input.from !== undefined && input.to !== undefined) {
      return this.commandRunner.diff(input.projectId, {
        path: input.path,
        from: input.from,
        to: input.to,
      });
    }

    if (input.path === undefined) {
      return this.commandRunner.diff(input.projectId, {});
    }

    return this.diffUncommittedPath(input.projectId, input.path);
  }

  /**
   * Diffs a single project-relative file's uncommitted working changes, substituting its live
   * editor content when the file is open in the collaborative editor.
   */
  private async diffUncommittedPath(
    projectId: ProjectId,
    path: string,
  ): Promise<Result<GetDiffResult, DomainError>> {
    const node = await this.findNodeByPath(projectId, path);
    if (!node) {
      return this.commandRunner.diff(projectId, { path });
    }

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
      return {
        success: false,
        error: new GitCommandFailedError(`The current content of '${path}' could not be read`),
      };
    }

    if (source.kind === 'inline') {
      return this.commandRunner.diff(projectId, {
        path,
        currentContent: { path, content: source.bytes.toString('utf8') },
      });
    }

    return this.commandRunner.diff(projectId, { path });
  }

  /** Finds the file node whose path matches the given project-relative (leading-slash-less) path. */
  private async findNodeByPath(projectId: ProjectId, path: string): Promise<FileNode | null> {
    // Git paths carry no leading slash; a FilePath requires one.
    const target = FilePath.create('/' + path).value;
    for (const node of await this.fileNodeRepo.findByProjectId(projectId)) {
      if (node.path.value === target) return node;
    }
    return null;
  }
}
