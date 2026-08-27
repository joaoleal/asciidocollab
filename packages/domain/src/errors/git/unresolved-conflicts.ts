import { DomainError } from '../domain-error';

/**
 * Raised when completing a conflicted operation is attempted while at least one of its recorded
 * conflicts is still unresolved. Completion is all-or-nothing: no resolving commit is taken, no
 * change lands, and the operation stays exactly where it was (`AWAITING_CONFLICT`) until every
 * conflict has a recorded resolution.
 */
export class UnresolvedConflictsError extends DomainError {
  readonly name = 'UnresolvedConflictsError';

  /** Builds the refusal with the fixed message the caller is shown. */
  constructor() {
    super('This operation still has unresolved conflicts');
  }
}
