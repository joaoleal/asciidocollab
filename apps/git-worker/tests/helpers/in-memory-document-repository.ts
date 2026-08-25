import type { Document, DocumentId, DocumentRepository, FileNodeId, YjsStateId } from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `DocumentRepository` fake for this app's tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`'.
 */
export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly storage = new Map<string, Document>();

  async findById(id: DocumentId): Promise<Document | null> {
    return this.storage.get(id.value) ?? null;
  }

  async findByFileNodeId(fileNodeId: FileNodeId): Promise<Document | null> {
    for (const document of this.storage.values()) {
      if (document.fileNodeId.value === fileNodeId.value) return document;
    }
    return null;
  }

  async findByFileNodeIds(fileNodeIds: FileNodeId[]): Promise<Document[]> {
    const ids = new Set(fileNodeIds.map((id) => id.value));
    return [...this.storage.values()].filter((document) => ids.has(document.fileNodeId.value));
  }

  async save(document: Document): Promise<void> {
    this.storage.set(document.id.value, document);
  }

  async delete(id: DocumentId): Promise<void> {
    this.storage.delete(id.value);
  }

  async findByYjsStateId(yjsStateId: YjsStateId): Promise<Document | null> {
    for (const document of this.storage.values()) {
      if (document.yjsStateId.value === yjsStateId.value) return document;
    }
    return null;
  }
}
