import { DomainError } from '../domain-error';

/** Thrown when a dictionary term cannot be found within the caller's project scope. */
export class DictionaryTermNotFoundError extends DomainError {
  readonly name = 'DictionaryTermNotFoundError';

  /**
   * @param termId - The id that was not found (safe to echo — it is the caller's own input).
   */
  constructor(termId: string) {
    super(`Dictionary term not found: ${termId}`);
  }
}
