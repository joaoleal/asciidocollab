import { IgnoredLintId } from '../value-objects/ids/ignored-lint-id';
import { UserId } from '../value-objects/ids/user-id';
import { FileNodeId } from '../value-objects/ids/file-node-id';

/**
 * One author's private set of dismissed grammar issues for one document (feature 042 / US6). The blob
 * is exactly harper.js `exportIgnoredLints()` output — privacy-respecting hashes, NOT raw prose — which
 * the domain stores and round-trips verbatim rather than parsing (the format is early-access/unstable).
 * One record per (user, document); writes upsert (last-write-wins on the caller's own blob).
 */
export class IgnoredLint {
  /**
   * @param id - Unique identifier for this record.
   * @param userId - The owner; never exposed to any other user.
   * @param documentId - The document the ignores apply to (a FileNode id).
   * @param ignoredLintsJson - The opaque, privacy-hashed blob.
   * @param updatedAt - When it was last written; defaults to now.
   */
  constructor(
    public readonly id: IgnoredLintId,
    public readonly userId: UserId,
    public readonly documentId: FileNodeId,
    public readonly ignoredLintsJson: string,
    public readonly updatedAt: Date = new Date(),
  ) {}
}
