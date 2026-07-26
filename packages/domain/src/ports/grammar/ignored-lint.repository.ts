import type { IgnoredLint } from '../../entities/ignored-lint';
import type { UserId } from '../../value-objects/ids/user-id';
import type { FileNodeId } from '../../value-objects/ids/file-node-id';

/** Persistence port for per-user, per-document ignored-lint blobs (one record per pair). */
export interface IgnoredLintRepository {
  /**
   * Finds the caller's ignored-lints record for a document, or null if they have ignored nothing.
   *
   * @param userId - The owning user.
   * @param documentId - The file node the ignores were recorded against.
   * @returns The record, or null.
   */
  findByUserAndDocument(userId: UserId, documentId: FileNodeId): Promise<IgnoredLint | null>;
  /**
   * Inserts or replaces the caller's ignored-lints record for a document (full upsert).
   *
   * @param record - The record to persist.
   * @returns A promise that resolves when the write is complete.
   */
  upsert(record: IgnoredLint): Promise<void>;
}
