import { Readable } from 'stream';
import type { FileConflictError, FilePath, ProjectFileStore, ProjectId, Result } from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `ProjectFileStore` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryProjectFileStore implements ProjectFileStore {
  private readonly storage = new Map<string, Buffer>();

  private key(projectId: ProjectId, filePath: FilePath): string {
    return `${projectId.value}:${filePath.value}`;
  }

  async read(projectId: ProjectId, filePath: FilePath): Promise<Buffer | null> {
    return this.storage.get(this.key(projectId, filePath)) ?? null;
  }

  async write(projectId: ProjectId, filePath: FilePath, content: Buffer): Promise<void> {
    this.storage.set(this.key(projectId, filePath), content);
  }

  async createExclusive(
    projectId: ProjectId,
    filePath: FilePath,
    content: Buffer,
  ): Promise<Result<void, FileConflictError>> {
    const k = this.key(projectId, filePath);
    if (this.storage.has(k)) {
      throw new Error(`test fake does not seed FileConflictError; path already occupied: ${filePath.value}`);
    }
    this.storage.set(k, content);
    return { success: true, value: undefined };
  }

  async remove(projectId: ProjectId, filePath: FilePath): Promise<void> {
    this.storage.delete(this.key(projectId, filePath));
  }

  async move(
    projectId: ProjectId,
    fromPath: FilePath,
    toPath: FilePath,
  ): Promise<Result<void, FileConflictError>> {
    const content = this.storage.get(this.key(projectId, fromPath));
    if (content !== undefined) {
      this.storage.set(this.key(projectId, toPath), content);
      this.storage.delete(this.key(projectId, fromPath));
    }
    return { success: true, value: undefined };
  }

  async createDirectory(): Promise<void> {
    // Directories are implicit in this in-memory store; no-op.
  }

  async removeDirectory(projectId: ProjectId, directoryPath: FilePath): Promise<void> {
    const prefix = `${projectId.value}:${directoryPath.value}`;
    for (const key of this.storage.keys()) {
      if (key.startsWith(prefix)) this.storage.delete(key);
    }
  }

  async removeProject(projectId: ProjectId): Promise<void> {
    const prefix = `${projectId.value}:`;
    for (const key of this.storage.keys()) {
      if (key.startsWith(prefix)) this.storage.delete(key);
    }
  }

  async readStream(projectId: ProjectId, filePath: FilePath): Promise<Readable | null> {
    const content = this.storage.get(this.key(projectId, filePath));
    return content === undefined ? null : Readable.from(content);
  }
}
