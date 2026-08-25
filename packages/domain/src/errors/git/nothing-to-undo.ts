import { DomainError } from '../domain-error';

/**
 * Raised when an undo is attempted for a project with nothing left to undo: no operation is
 * currently `AWAITING_CONFLICT`, and no prior pull's pre-operation snapshot is still recorded
 * (already undone, already completed and cleared, or never existed).
 */
export class NothingToUndoError extends DomainError {
  readonly name = 'NothingToUndoError';

  constructor() {
    super('There is nothing to undo for this project');
  }
}
