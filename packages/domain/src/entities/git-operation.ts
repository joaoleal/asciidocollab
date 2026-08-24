import { GitOperationId } from '../value-objects/ids/git-operation-id';
import { ProjectId } from '../value-objects/ids/project-id';
import { UserId } from '../value-objects/ids/user-id';
import { GitOperationKind } from '../types/git-operation-kind';
import { GitOperationState, ACTIVE_GIT_OPERATION_STATES } from '../types/git-operation-state';

/**
 * A durable record of a whole-project git action: the cross-instance work-list
 * entry, single-flight lock, progress tracker, and audit source all in one.
 *
 * Instances are immutable; a state transition (claim, heartbeat, completion)
 * is represented by constructing a new `GitOperation` with the updated fields,
 * which is how the owning repository records progress.
 */
export class GitOperation {
  /** Creates a new GitOperation record. */
  constructor(
    /** Unique identifier for this operation. */
    public readonly id: GitOperationId,
    /** The project this operation acts on. */
    public readonly projectId: ProjectId,
    /** The kind of git action being performed. */
    public readonly kind: GitOperationKind,
    /** The operation's current lifecycle state. */
    public readonly state: GitOperationState,
    /** The user who triggered this operation. */
    public readonly triggeredByUserId: UserId,
    /** The branch this operation targets, or null if not branch-specific. */
    public readonly branch: string | null = null,
    /** Progress percentage, 0 to 100. */
    public readonly progress: number = 0,
    /** Last worker liveness signal; a stale value on a non-terminal op means the worker crashed. */
    public readonly heartbeatAt: Date | null = null,
    /** Typed, safe error code recorded on failure, or null while not failed. */
    public readonly errorCode: string | null = null,
    /** When a worker first started running this operation, or null if not yet started. */
    public readonly startedAt: Date | null = null,
    /** When this operation reached a terminal state, or null if still active. */
    public readonly finishedAt: Date | null = null,
    /** When this operation was enqueued. */
    public readonly createdAt: Date = new Date(),
  ) {}

  /**
   * Whether this operation counts as "in progress" for its project — the
   * single-flight guard refuses a new mutating operation while this is true.
   */
  get isActive(): boolean {
    return ACTIVE_GIT_OPERATION_STATES.includes(this.state);
  }
}
