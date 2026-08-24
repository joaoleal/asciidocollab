import { GitConflictId } from '../value-objects/ids/git-conflict-id';
import { GitOperationId } from '../value-objects/ids/git-operation-id';
import { ConflictResolution } from '../types/conflict-resolution';

/**
 * A single file with competing changes from a pull/merge or branch switch,
 * awaiting (or recording) resolution. Belongs to exactly one `GitOperation`.
 */
export class GitConflict {
  /** Creates a new GitConflict record. */
  constructor(
    /** Unique identifier for this conflict. */
    public readonly id: GitConflictId,
    /** The operation during which this conflict arose. */
    public readonly operationId: GitOperationId,
    /** Project-relative path of the conflicting file. */
    public readonly path: string,
    /** Whether the file is binary (no textual three-way diff is possible). */
    public readonly isBinary: boolean = false,
    /** Whether this conflict has been resolved. */
    public readonly resolved: boolean = false,
    /** The chosen resolution, or null while the conflict is still open. */
    public readonly resolution: ConflictResolution | null = null,
    /** When this conflict was recorded. */
    public readonly createdAt: Date = new Date(),
  ) {}
}
