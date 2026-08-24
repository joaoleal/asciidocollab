import { Uuid, validateUuid } from './uuid';

/**
 * Unique identifier for a GitOperation entity.
 */
export class GitOperationId extends Uuid {
  private constructor(value: string) {
    super(value);
  }

  /**
   * Creates a new GitOperationId after validating the UUID format.
   *
   * @param value - A UUID v4 string.
   * @returns A new GitOperationId instance.
   * @throws {ValidationError} If the value is not a valid UUID v4.
   */
  static create(value: string): GitOperationId {
    validateUuid(value, 'GitOperationId');
    return new GitOperationId(value);
  }
}
