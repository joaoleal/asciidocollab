import { ProjectId } from '../../value-objects/ids/project-id';
import { GitOperationRepository } from '../../ports/git/git-operation-repository';
import { ConflictStageStore } from '../../ports/git/conflict-stage-store';
import { DomainError } from '../../errors/domain-error';
import { NoConflictInProgressError } from '../../errors/git/no-conflict-in-progress';
import { GitConflictNotFoundError } from '../../errors/git/git-conflict-not-found';
import { Result } from '../../types/result';

/** Everything `GetConflictStagesUseCase.execute` needs to read one conflicting file's three-way stages. */
export interface GetConflictStagesInput {
  /** The project whose awaiting conflict to read from. */
  readonly projectId: ProjectId;
  /** The conflicting file's path. */
  readonly path: string;
}

/**
 * One conflicting file's captured three-way stages, shaped for the merge view. A binary conflict
 * carries no text content — `base`/`ours`/`theirs` are empty and `isBinary` is `true`, so the
 * client knows to offer only whole-file ours/theirs actions, never the inline text editor.
 */
export interface GetConflictStagesResult {
  /** The merge-base content, or null when the file had no merge base (an add/add conflict). */
  readonly base: string | null;
  /** This branch's ("ours") content. Empty for a binary conflict. */
  readonly ours: string;
  /** The incoming branch's ("theirs") content. Empty for a binary conflict. */
  readonly theirs: string;
  /** Whether the file is binary (no textual three-way view). */
  readonly isBinary: boolean;
}

/**
 * Reads one conflicting file's captured base/ours/theirs stages, for the client's three-way merge
 * view. Thin and lock-free: it only looks at the project's currently awaiting operation and the
 * off-tree stage store, never the working tree, and takes no guard of its own.
 */
export class GetConflictStagesUseCase {
  /**
   * @param gitOperationRepo - Locates the project's currently awaiting operation.
   * @param conflictStageStore - Reads back the captured stages for the requested path.
   */
  constructor(
    private readonly gitOperationRepo: GitOperationRepository,
    private readonly conflictStageStore: ConflictStageStore,
  ) {}

  /**
   * Reads `input.path`'s captured stages for the project's currently awaiting conflict.
   *
   * @param input - The project and the conflicting file's path.
   * @returns The mapped stages on success; a {@link NoConflictInProgressError} when the project has
   *   no operation `AWAITING_CONFLICT`, or a {@link GitConflictNotFoundError} when no stages were
   *   captured for `input.path`.
   */
  async execute(input: GetConflictStagesInput): Promise<Result<GetConflictStagesResult, DomainError>> {
    const operation = await this.gitOperationRepo.findActiveOperation(input.projectId);
    if (!operation || operation.state !== 'AWAITING_CONFLICT') {
      return { success: false, error: new NoConflictInProgressError() };
    }

    const stagesRead = await this.conflictStageStore.readStages(operation.id, input.path);
    if (!stagesRead.success) return stagesRead;

    const stages = stagesRead.value;
    if (stages === null) {
      return { success: false, error: new GitConflictNotFoundError(input.path) };
    }

    if (stages.isBinary) {
      return { success: true, value: { base: null, ours: '', theirs: '', isBinary: true } };
    }

    return {
      success: true,
      value: {
        base: stages.base ? stages.base.toString('utf8') : null,
        ours: stages.ours.toString('utf8'),
        theirs: stages.theirs.toString('utf8'),
        isBinary: false,
      },
    };
  }
}
