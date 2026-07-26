import { IgnoredLint } from '../../../src/entities/ignored-lint';
import { UserId } from '../../../src/value-objects/ids/user-id';
import { FileNodeId } from '../../../src/value-objects/ids/file-node-id';
import { IgnoredLintRepository } from '../../../src/ports/grammar/ignored-lint.repository';

/** In-memory implementation of IgnoredLintRepository for use in tests. */
export class InMemoryIgnoredLintRepository implements IgnoredLintRepository {
  private readonly storage = new Map<string, IgnoredLint>();

  private key(userId: UserId, documentId: FileNodeId): string {
    return `${userId.value}:${documentId.value}`;
  }

  /** Finds the (user, document) record, or null. */
  async findByUserAndDocument(userId: UserId, documentId: FileNodeId): Promise<IgnoredLint | null> {
    return this.storage.get(this.key(userId, documentId)) ?? null;
  }

  /** Inserts or replaces the (user, document) record. */
  async upsert(record: IgnoredLint): Promise<void> {
    this.storage.set(this.key(record.userId, record.documentId), record);
  }
}
