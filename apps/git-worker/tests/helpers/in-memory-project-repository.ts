import type {
  PaginatedProjects,
  PaginationParameters,
  Project,
  ProjectId,
  ProjectRepository,
  UserId,
} from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `ProjectRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`' — the same `src`/`dist` module-identity mismatch
 * applies here too.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly storage = new Map<string, Project>();

  async findById(id: ProjectId): Promise<Project | null> {
    return this.storage.get(id.value) ?? null;
  }

  async findByMemberId(_userId: UserId, pagination: PaginationParameters): Promise<PaginatedProjects> {
    return { projects: [], total: 0, page: pagination.page, limit: pagination.limit, totalPages: 0 };
  }

  async save(project: Project): Promise<void> {
    this.storage.set(project.id.value, project);
  }

  async archive(id: ProjectId): Promise<void> {
    const project = this.storage.get(id.value);
    project?.archive();
  }

  async restore(id: ProjectId): Promise<void> {
    const project = this.storage.get(id.value);
    project?.restore();
  }

  async delete(id: ProjectId): Promise<void> {
    this.storage.delete(id.value);
  }
}
