import { DomainError } from '../domain-error';

/**
 * Raised when a per-file conflict resolution is invalid for the conflict it targets: a `merged`
 * resolution given without `mergedContent`, or a `merged` resolution attempted against a binary
 * conflict (which has no textual three-way view to merge). `ours`/`theirs` never raise this —
 * they resolve the whole file and ignore any submitted content.
 */
export class InvalidResolutionError extends DomainError {
  readonly name = 'InvalidResolutionError';

  /** @param reason - A safe, human-readable description of why the resolution is invalid. */
  constructor(reason: string) {
    super(reason);
  }
}
