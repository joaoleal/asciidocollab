import { DomainError } from '../domain-error';
import { GitOperationState } from '../../types/git-operation-state';

/**
 * Raised by {@link GitOperationRepository.transition} when the requested move is not a legal
 * edge in the `GitOperation` state machine (data-model.md's `QUEUED → RUNNING → SUCCEEDED`, with
 * `RUNNING → AWAITING_CONFLICT → RUNNING`, `RUNNING → FAILED`, and `RUNNING → ABORTED` branches),
 * or the operation does not exist at all. Carries only the two already-typed states involved —
 * never a raw message built from untrusted input — so it is always safe to log or audit.
 */
export class IllegalGitOperationTransitionError extends DomainError {
  readonly name = 'IllegalGitOperationTransitionError';

  /**
   * @param fromState - The operation's state at the time of the attempt, or null when no
   *   operation exists with the given id.
   * @param toState - The state the caller attempted to transition to.
   */
  constructor(
    public readonly fromState: GitOperationState | null,
    public readonly toState: GitOperationState,
  ) {
    super(
      fromState === null
        ? `Cannot transition a git operation that does not exist to ${toState}`
        : `Cannot transition a git operation from ${fromState} to ${toState}`,
    );
  }
}
