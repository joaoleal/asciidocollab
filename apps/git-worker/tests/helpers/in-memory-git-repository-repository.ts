import { GitRepository } from '@asciidocollab/domain';
import type { GitRepositoryId, GitRepositoryRepository, ProjectId, RefreshedSyncStatusFields } from '@asciidocollab/domain';

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

  async findAllConnected(): Promise<GitRepository[]> {
    return [...this.storage.values()].filter(
      (r) => r.syncStatus !== 'DISCONNECTED' && r.syncStatus !== 'NEEDS_REAUTH',
    );
  }

  async save(gitRepository: GitRepository): Promise<void> {
    this.storage.set(gitRepository.id.value, gitRepository);
  }

  /**
   * Persists a refresh's observed fields onto the existing row, writing ONLY `syncStatus`,
   * `lastKnownRemoteHead`, and `lastSyncAt` (mirrors the Prisma adapter's scoped conditional
   * `updateMany`). Every other column is copied from the stored entity, so a concurrent change to
   * `currentBranch`/`remoteUrl`/etc. is never reverted. Never overwrites a stored `CONFLICTED`
   * status with a non-`CONFLICTED` one, so a background refresh never clears a conflict a concurrent
   * pull committed between load and write. A `CONFLICTED`-preserving write lands only while the
   * stored status still equals `fields.expectedCurrentStatus` (the status the refresh observed), so a
   * concurrent resolve that moved the row off it is never stomped back to `CONFLICTED` (mirrors the
   * Prisma adapter's `WHERE syncStatus = expectedCurrentStatus` guard). A no-op when the project has
   * no stored row. Returns `true` when the fields were written; `false` when a guard blocked the
   * write or no row exists (mirrors the Prisma adapter's `updateMany` affected-row count).
   */
  async saveRefreshedStatus(fields: RefreshedSyncStatusFields): Promise<boolean> {
    const existing = await this.findByProjectId(fields.projectId);
    if (existing === null) return false;
    if (fields.syncStatus === 'CONFLICTED') {
      if (existing.syncStatus !== fields.expectedCurrentStatus) return false;
    } else if (existing.syncStatus === 'CONFLICTED') {
      return false;
    }
    this.storage.set(
      existing.id.value,
      new GitRepository(
        existing.id,
        existing.projectId,
        existing.provider,
        existing.remoteUrl,
        existing.credentialReference,
        existing.currentBranch,
        fields.syncStatus,
        existing.defaultBranch,
        fields.lastKnownRemoteHead,
        fields.lastSyncAt,
        existing.createdAt,
        existing.connectedByUserId,
      ),
    );
    return true;
  }

  /**
   * Marks the stored row `NEEDS_REAUTH` (mirrors the Prisma adapter's scoped conditional
   * `updateMany`), but never when its current status is `CONFLICTED` — an unresolved conflict
   * outranks a re-auth prompt. A no-op (never inserts) when the project has no stored row. Returns
   * `true` when the row was updated; `false` when the row is gone or was `CONFLICTED`.
   */
  async markNeedsReauthUnlessConflicted(projectId: ProjectId): Promise<boolean> {
    const existing = await this.findByProjectId(projectId);
    if (existing === null) return false;
    if (existing.syncStatus === 'CONFLICTED') return false;
    this.storage.set(
      existing.id.value,
      new GitRepository(
        existing.id,
        existing.projectId,
        existing.provider,
        existing.remoteUrl,
        existing.credentialReference,
        existing.currentBranch,
        'NEEDS_REAUTH',
        existing.defaultBranch,
        existing.lastKnownRemoteHead,
        existing.lastSyncAt,
        existing.createdAt,
        existing.connectedByUserId,
      ),
    );
    return true;
  }

  async delete(id: GitRepositoryId): Promise<void> {
    this.storage.delete(id.value);
  }
}
