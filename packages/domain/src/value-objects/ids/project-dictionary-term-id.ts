import { Uuid, validateUuid } from './uuid';

/**
 * Unique identifier for a ProjectDictionaryTerm entity.
 */
export class ProjectDictionaryTermId extends Uuid {
  private constructor(value: string) {
    super(value);
  }

  /**
   * Creates a new ProjectDictionaryTermId after validating the UUID format.
   *
   * @param value - A UUID v4 string.
   * @returns A new ProjectDictionaryTermId instance.
   * @throws {ValidationError} If the value is not a valid UUID v4.
   */
  static create(value: string): ProjectDictionaryTermId {
    validateUuid(value, 'ProjectDictionaryTermId');
    return new ProjectDictionaryTermId(value);
  }
}
