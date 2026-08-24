import type { ProjectRenderConfig } from '../../../src/entities/project-render-config';
import type { ProjectId } from '../../../src/value-objects/ids/project-id';
import type { ProjectRenderConfigRepository } from '../../../src/ports/project/project-render-config.repository';

export class InMemoryProjectRenderConfigRepository implements ProjectRenderConfigRepository {
  private readonly store = new Map<string, ProjectRenderConfig>();

  async findByProjectId(projectId: ProjectId): Promise<ProjectRenderConfig | null> {
    return this.store.get(projectId.value) ?? null;
  }

  async save(config: ProjectRenderConfig): Promise<void> {
    this.store.set(config.projectId.value, config);
  }

  /**
   * Drops a project's configuration, standing in for the database's cascade when
   * the project row it hangs off is deleted.
   *
   * @param projectId - The project whose configuration goes with it.
   */
  async removeByProject(projectId: ProjectId): Promise<void> {
    this.store.delete(projectId.value);
  }
}
