import { ProjectDictionaryTerm } from '../../../src/entities/project-dictionary-term';
import { ProjectDictionaryTermId } from '../../../src/value-objects/ids/project-dictionary-term-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { ProjectDictionaryRepository } from '../../../src/ports/grammar/project-dictionary.repository';

/** In-memory implementation of ProjectDictionaryRepository for use in tests. */
export class InMemoryProjectDictionaryRepository implements ProjectDictionaryRepository {
  private readonly storage = new Map<string, ProjectDictionaryTerm>();

  /** Lists a project's terms, oldest-first. */
  async listByProject(projectId: ProjectId): Promise<ProjectDictionaryTerm[]> {
    return [...this.storage.values()]
      .filter((term) => term.projectId.value === projectId.value)
      .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /** Finds a term case-insensitively within a project. */
  async findByTerm(projectId: ProjectId, term: string): Promise<ProjectDictionaryTerm | null> {
    const lower = term.toLowerCase();
    return (
      [...this.storage.values()].find(
        (candidate) => candidate.projectId.value === projectId.value && candidate.term.toLowerCase() === lower,
      ) ?? null
    );
  }

  /** Stores a new term. */
  async add(term: ProjectDictionaryTerm): Promise<void> {
    this.storage.set(term.id.value, term);
  }

  /** Removes a term by id within its project; returns whether one was removed. */
  async removeById(projectId: ProjectId, id: ProjectDictionaryTermId): Promise<boolean> {
    const existing = this.storage.get(id.value);
    if (!existing || existing.projectId.value !== projectId.value) return false;
    return this.storage.delete(id.value);
  }
}
