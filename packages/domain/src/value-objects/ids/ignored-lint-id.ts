import { Uuid, validateUuid } from './uuid';

/**
 * Unique identifier for an IgnoredLint record.
 */
export class IgnoredLintId extends Uuid {
  private constructor(value: string) {
    super(value);
  }

  /**
   * Creates a new IgnoredLintId after validating the UUID format.
   *
   * @param value - A UUID v4 string.
   * @returns A new IgnoredLintId instance.
   * @throws {ValidationError} If the value is not a valid UUID v4.
   */
  static create(value: string): IgnoredLintId {
    validateUuid(value, 'IgnoredLintId');
    return new IgnoredLintId(value);
  }
}
