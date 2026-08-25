import { FileNode } from '@asciidocollab/domain';
import type { FileNodeId, FileNodeRepository, ProjectId } from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `FileNodeRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryFileNodeRepository implements FileNodeRepository {
  private readonly storage = new Map<string, FileNode>();

  async findById(id: FileNodeId): Promise<FileNode | null> {
    return this.storage.get(id.value) ?? null;
  }

  async findByParentId(parentId: FileNodeId): Promise<FileNode[]> {
    return [...this.storage.values()].filter((node) => node.parentId?.value === parentId.value);
  }

  async findByProjectId(projectId: ProjectId): Promise<FileNode[]> {
    return [...this.storage.values()].filter((node) => node.projectId.value === projectId.value);
  }

  async save(fileNode: FileNode): Promise<void> {
    this.storage.set(fileNode.id.value, fileNode);
  }

  async move(id: FileNodeId, newParentId: FileNodeId): Promise<void> {
    const node = this.storage.get(id.value);
    if (!node) return;
    this.storage.set(
      id.value,
      new FileNode(node.id, node.projectId, newParentId, node.name, node.type, node.path, node.timestamps),
    );
  }

  async delete(id: FileNodeId): Promise<void> {
    this.storage.delete(id.value);
  }
}
