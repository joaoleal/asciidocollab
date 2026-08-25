import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationId } from '../../value-objects/ids/git-operation-id';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { DomainError } from '../../errors/domain-error';
import { NoConflictInProgressError } from '../../errors/git/no-conflict-in-progress';
import { Result } from '../../types/result';

/** Everything `ListConflictsUseCase.execute` needs to list a project's currently conflicting files. */
export interface ListConflictsInput {
  /** The project whose awaiting conflict's files to list. */
  readonly projectId: ProjectId;
}

/** One conflicting file, summarized for the conflict list panel — no content, just enough to drive it. */
export interface ConflictSummary {
  /** The conflicting file's path. */
  readonly path: string;
  /** Whether the file is binary (no textual three-way view). */
  readonly isBinary: boolean;
  /** Whether this file's conflict has already been resolved. */
  readonly resolved: boolean;
}

/** The awaiting operation's id and every conflicting file recorded against it. */
export interface ListConflictsResult {
  /** The awaiting operation these conflicts belong to. */
  readonly operationId: GitOperationId;
  /** Every conflicting file, in the order they were recorded. */
  readonly files: readonly ConflictSummary[];
}

/**
 * Lists every conflicting file recorded for the project's currently awaiting operation, for the
 * client's conflict list panel. Thin and lock-free: reads only the awaiting operation and its
 * `GitConflict` rows, never the working tree, and takes no guard of its own.
 */
export class ListConflictsUseCase {
  /** @param gitOperationRepo - Locates the project's currently awaiting operation and its conflicts. */
  constructor(private readonly gitOperationRepo: GitOperationRepository) {}

  /**
   * Lists the conflicting files recorded for the project's currently awaiting operation.
   *
   * @param input - The project whose conflicts to list.
   * @returns The operation id and its conflict summaries on success; a
   *   {@link NoConflictInProgressError} when the project has no operation `AWAITING_CONFLICT`.
   */
  async execute(input: ListConflictsInput): Promise<Result<ListConflictsResult, DomainError>> {
    const operation = await this.gitOperationRepo.findActiveOperation(input.projectId);
    if (!operation || operation.state !== 'AWAITING_CONFLICT') {
      return { success: false, error: new NoConflictInProgressError() };
    }

    const conflicts = await this.gitOperationRepo.listConflicts(operation.id);

    return {
      success: true,
      value: {
        operationId: operation.id,
        files: conflicts.map((conflict) => ({
          path: conflict.path,
          isBinary: conflict.isBinary,
          resolved: conflict.resolved,
        })),
      },
    };
  }
}
