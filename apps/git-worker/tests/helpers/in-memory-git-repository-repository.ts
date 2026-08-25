import type { GitRepository, GitRepositoryId, GitRepositoryRepository, ProjectId } from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `GitRepositoryRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryGitRepositoryRepository implements GitRepositoryRepository {
  private readonly storage = new Map<string, GitRepository>();

  async findById(id: GitRepositoryId): Promise<GitRepository | null> {
    return this.storage.get(id.value) ?? null;
  }

  async findByProjectId(projectId: ProjectId): Promise<GitRepository | null> {
    for (const repository of this.storage.values()) {
      if (repository.projectId.value === projectId.value) return repository;
    }
    return null;
  }

  async save(gitRepository: GitRepository): Promise<void> {
    this.storage.set(gitRepository.id.value, gitRepository);
  }

  async delete(id: GitRepositoryId): Promise<void> {
    this.storage.delete(id.value);
  }
}
