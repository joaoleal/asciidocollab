import { GitRepository } from '../../../src/entities/git-repository';
import { GitRepositoryId } from '../../../src/value-objects/ids/git-repository-id';
import { ProjectId } from '../../../src/value-objects/ids/project-id';
import { GitRepositoryRepository, RefreshedSyncStatusFields } from '../../../src/ports/project/git-repository.repository';

/** In-memory implementation of GitRepositoryRepository for use in tests. */
export class InMemoryGitRepositoryRepository implements GitRepositoryRepository {
  private readonly storage = new Map<string, GitRepository>();

  /** Returns the git repository with the given ID, or null if not found. */
  async findById(id: GitRepositoryId): Promise<GitRepository | null> {
    return this.storage.get(id.value) ?? null;
  }

  /** Returns the git repository linked to the given project, or null if none exists. */
  async findByProjectId(projectId: ProjectId): Promise<GitRepository | null> {
    for (const repo of this.storage.values()) {
      if (repo.projectId.value === projectId.value) {
        return repo;
      }
    }
    return null;
  }

  /** Returns every stored git repository (each stored row is a connected repository). */
  async findAllConnected(): Promise<GitRepository[]> {
    return [...this.storage.values()].filter(
      (r) => r.syncStatus !== 'DISCONNECTED' && r.syncStatus !== 'NEEDS_REAUTH',
    );
  }

  /** Stores a git repository in memory, overwriting any existing entry with the same ID. */
  async save(gitRepository: GitRepository): Promise<void> {
    this.storage.set(gitRepository.id.value, gitRepository);
  }

  /**
   * Persists a refresh's observed fields onto the existing row, writing ONLY `syncStatus`,
   * `lastKnownRemoteHead`, and `lastSyncAt`; every other column is copied from the stored entity, so
   * a concurrent change to `currentBranch`/`remoteUrl`/etc. is never reverted (mirrors the Prisma
   * adapter's scoped conditional `updateMany`). Never overwrites a stored `CONFLICTED` status with a
   * non-`CONFLICTED` one — the guard that stops a background refresh from clearing a conflict a
   * concurrent pull committed between the use case's load and this write. A `CONFLICTED`-preserving
   * write lands only while the stored status still equals `fields.expectedCurrentStatus` (the status
   * the refresh observed), so a concurrent resolve that moved the row off it is never stomped back to
   * `CONFLICTED` (mirrors the Prisma adapter's `WHERE syncStatus = expectedCurrentStatus` guard). A
   * no-op when the project has no stored row. Returns `true` when the fields were written; `false`
   * when a guard blocked the write or no row exists (mirrors the Prisma adapter's `updateMany`
   * affected-row count).
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

  /** Removes the git repository with the given ID from memory. */
  async delete(id: GitRepositoryId): Promise<void> {
    this.storage.delete(id.value);
  }
}
