import { Uuid, validateUuid } from './uuid';

/**
 * Unique identifier for a GitConflict entity.
 */
export class GitConflictId extends Uuid {
  private constructor(value: string) {
    super(value);
  }

  /**
   * Creates a new GitConflictId after validating the UUID format.
   *
   * @param value - A UUID v4 string.
   * @returns A new GitConflictId instance.
   * @throws {ValidationError} If the value is not a valid UUID v4.
   */
  static create(value: string): GitConflictId {
    validateUuid(value, 'GitConflictId');
    return new GitConflictId(value);
  }
}
