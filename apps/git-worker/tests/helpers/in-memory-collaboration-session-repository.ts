import type { CollaborationSessionRepository, DocumentId, ProjectId } from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `CollaborationSessionRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryCollaborationSessionRepository implements CollaborationSessionRepository {
  private readonly active = new Map<string, { projectId: ProjectId; documentId: DocumentId }>();

  private key(projectId: ProjectId, documentId: DocumentId): string {
    return `${projectId.value}:${documentId.value}`;
  }

  async isActive(projectId: ProjectId, documentId: DocumentId): Promise<boolean> {
    return this.active.has(this.key(projectId, documentId));
  }

  async open(projectId: ProjectId, documentId: DocumentId): Promise<void> {
    this.active.set(this.key(projectId, documentId), { projectId, documentId });
  }

  async close(projectId: ProjectId, documentId: DocumentId): Promise<void> {
    this.active.delete(this.key(projectId, documentId));
  }

  async closeAllForProject(projectId: ProjectId): Promise<void> {
    for (const [key, entry] of this.active) {
      if (entry.projectId.value === projectId.value) this.active.delete(key);
    }
  }

  async findActiveDocumentIds(projectId: ProjectId): Promise<DocumentId[]> {
    return [...this.active.values()]
      .filter((entry) => entry.projectId.value === projectId.value)
      .map((entry) => entry.documentId);
  }

  async closeAll(): Promise<void> {
    this.active.clear();
  }
}
