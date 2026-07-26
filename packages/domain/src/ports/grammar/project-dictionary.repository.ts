import type { ProjectDictionaryTerm } from '../../entities/project-dictionary-term';
import type { ProjectDictionaryTermId } from '../../value-objects/ids/project-dictionary-term-id';
import type { ProjectId } from '../../value-objects/ids/project-id';

/** Persistence port for a project's shared dictionary (many terms per project). */
export interface ProjectDictionaryRepository {
  /**
   * Lists every accepted term for a project, ordered oldest-first.
   *
   * @param projectId - The project whose dictionary to read.
   * @returns The project's dictionary terms.
   */
  listByProject(projectId: ProjectId): Promise<ProjectDictionaryTerm[]>;
  /**
   * Finds a term in the project's dictionary case-insensitively (so `API` and `api` are the same term).
   *
   * @param projectId - The project to search within.
   * @param term - The term to look for.
   * @returns The matching record, or null if the project has no such term.
   */
  findByTerm(projectId: ProjectId, term: string): Promise<ProjectDictionaryTerm | null>;
  /**
   * Persists a new dictionary term.
   *
   * @param term - The term record to add.
   * @returns A promise that resolves when the add is complete.
   */
  add(term: ProjectDictionaryTerm): Promise<void>;
  /**
   * Removes a term by id, scoped to its project.
   *
   * @param projectId - The project the term belongs to.
   * @param id - The id of the term to remove.
   * @returns True if a term was removed, false if none matched.
   */
  removeById(projectId: ProjectId, id: ProjectDictionaryTermId): Promise<boolean>;
}
