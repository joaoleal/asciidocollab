import { ProjectDictionaryTermId } from '../value-objects/ids/project-dictionary-term-id';
import { ProjectId } from '../value-objects/ids/project-id';
import { UserId } from '../value-objects/ids/user-id';
import { ValidationError } from '../errors/common/validation-error';

/**
 * One accepted term in a project's shared grammar/spelling dictionary (feature 042). The term text is
 * validated for shape at the API boundary by the shared `dictionaryTermSchema`; the entity enforces the
 * invariant that it is non-empty so a blank term can never be persisted.
 */
export class ProjectDictionaryTerm {
  /**
   * @param id - Unique identifier for this term record.
   * @param projectId - The project whose dictionary this term belongs to.
   * @param term - The accepted word or acronym (boundary-validated, non-empty).
   * @param createdByUserId - The user who added the term (attribution).
   * @param createdAt - When it was added; defaults to now.
   */
  constructor(
    public readonly id: ProjectDictionaryTermId,
    public readonly projectId: ProjectId,
    public readonly term: string,
    public readonly createdByUserId: UserId,
    public readonly createdAt: Date = new Date(),
  ) {
    if (term.trim().length === 0) {
      throw new ValidationError('A dictionary term must not be empty.');
    }
  }
}
