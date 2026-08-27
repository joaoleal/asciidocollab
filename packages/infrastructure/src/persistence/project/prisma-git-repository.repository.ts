import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  GitRepository,
  GitRepositoryId,
  ProjectId,
  UserId,
  GitProvider,
  GitRepositoryRepository,
  ValidationError,
} from '@asciidocollab/domain';
import type { GitSyncStatus, RefreshedSyncStatusFields } from '@asciidocollab/domain';

/** Every `GitSyncStatus` value, for validating a raw DB string without an unchecked cast. */
const GIT_SYNC_STATUSES: readonly GitSyncStatus[] = [
  'UP_TO_DATE',
  'AHEAD',
  'BEHIND',
  'DIVERGED',
  'CONFLICTED',
  'DISCONNECTED',
  'NEEDS_REAUTH',
];

/**
 * Validates a raw `syncStatus` column value against the known `GitSyncStatus` values.
 *
 * @param value - The raw string read back from the `GitRepository.syncStatus` column.
 * @returns The same value narrowed to `GitSyncStatus`.
 * @throws {ValidationError} If the value is not a recognized sync status (the column's own
 *   Postgres enum constraint should make this unreachable in practice).
 */
function toGitSyncStatus(value: string): GitSyncStatus {
  const match = GIT_SYNC_STATUSES.find((status) => status === value);
  if (match === undefined) {
    throw new ValidationError(`Invalid GitSyncStatus: ${value}`);
  }
  return match;
}

/**
 * Prisma-backed implementation of the `GitRepositoryRepository` interface.
 * Maps between domain `GitRepository` entities and the `GitRepository` database table.
 * Each project can have at most one git repository (one-to-one via `projectId` unique).
 */
export class PrismaGitRepositoryRepository implements GitRepositoryRepository {
  /** Creates a new PrismaGitRepositoryRepository. */
  constructor(
    /** The Prisma client used for database operations. */
    private readonly prisma: PrismaClient,
  ) {}

  /**
   * @param id - The unique identifier of the git repository.
   * @returns The git repository if found, null otherwise.
   */
  async findById(id: GitRepositoryId): Promise<GitRepository | null> {
    const record = await this.prisma.gitRepository.findUnique({ where: { id: id.value } });
    return record ? toDomainGitRepository(record) : null;
  }

  /**
   * @param projectId - The project ID to look up.
   * @returns The git repository associated with the project, null otherwise.
   */
  async findByProjectId(projectId: ProjectId): Promise<GitRepository | null> {
    const record = await this.prisma.gitRepository.findUnique({ where: { projectId: projectId.value } });
    return record ? toDomainGitRepository(record) : null;
  }

  /**
   * @returns Every connected git repository across all projects (one row per connected project),
   *   or an empty array when none exist. Rows with `syncStatus` `DISCONNECTED` are excluded: an
   *   initialize persists such a placeholder before it publishes to the remote, and a failed or
   *   in-progress initialize leaves one behind — sweeping it would enqueue a doomed FETCH against a
   *   remote that does not exist yet and occupy the project's single-flight operation slot. Rows with
   *   `syncStatus` `NEEDS_REAUTH` are excluded too: their stored credential was rejected by the
   *   remote, so they must not be swept until the credential is rotated.
   */
  async findAllConnected(): Promise<GitRepository[]> {
    const records = await this.prisma.gitRepository.findMany({
      where: { syncStatus: { notIn: ['DISCONNECTED', 'NEEDS_REAUTH'] } },
    });
    return records.map(toDomainGitRepository);
  }

  /**
   * Creates or updates a git repository. Uses upsert so the same method
   * handles both insert and update.
   *
   * @param gitRepository - The git repository entity to persist.
   */
  async save(gitRepository: GitRepository): Promise<void> {
    const data = toPersistenceGitRepository(gitRepository);
    // connectedByUserId is intentionally left out of `update`: a routine re-save must never
    // overwrite who originally connected the repository (mirrors createdByUserId in
    // prisma-git-credential-store.ts's save).
    await this.prisma.gitRepository.upsert({
      where: { id: gitRepository.id.value },
      create: data,
      update: {
        projectId: data.projectId,
        provider: data.provider,
        remoteUrl: data.remoteUrl,
        credentialRef: data.credentialRef,
        currentBranch: data.currentBranch,
        syncStatus: data.syncStatus,
        defaultBranch: data.defaultBranch,
        lastKnownRemoteHead: data.lastKnownRemoteHead,
        lastSyncAt: data.lastSyncAt,
        createdAt: data.createdAt,
      },
    });
  }

  /**
   * Atomically persists a refresh's observed sync fields without ever clearing a stored
   * `CONFLICTED` status: the derived (non-conflicted) write is scoped to `WHERE syncStatus <>
   * 'CONFLICTED'`, so a conflict a concurrent pull committed between the use case's load and this
   * write survives (0 rows matched → no overwrite). When the incoming status is itself `CONFLICTED`
   * (the refresh is preserving an already-conflicted row) the guard becomes `WHERE syncStatus =
   * expectedCurrentStatus` — the status the refresh observed — so the observed head and last-sync
   * time still update while the conflict is kept, but only while the row still holds that observed
   * status. A concurrent resolve (e.g. a `complete-merge` that moved the row off `CONFLICTED` during
   * the fetch) changes the status, so 0 rows match and the stale re-assert is dropped rather than
   * stomping the resolved row back to `CONFLICTED`.
   *
   * The write is scoped to only `syncStatus`, `lastKnownRemoteHead`, and `lastSyncAt` — never the
   * other mutable columns — so a concurrent user action (branch switch, credential rotation) that
   * changed one of those during the refresh's fetch is not reverted.
   *
   * @param fields - The observed sync fields to persist (identified by `projectId`).
   */
  async saveRefreshedStatus(fields: RefreshedSyncStatusFields): Promise<boolean> {
    const conflictGuard: Prisma.GitRepositoryWhereInput =
      fields.syncStatus === 'CONFLICTED'
        ? { syncStatus: fields.expectedCurrentStatus }
        : { syncStatus: { not: 'CONFLICTED' } };
    // Only the three fields the refresh observed are written. Every other mutable column
    // (currentBranch/remoteUrl/credentialRef/provider/defaultBranch) is deliberately absent from
    // `data`, so a concurrent branch switch or credential rotation committed during the fetch is
    // never reverted by this write. Keyed on the project's unique `projectId`.
    const result = await this.prisma.gitRepository.updateMany({
      where: { projectId: fields.projectId.value, ...conflictGuard },
      data: {
        syncStatus: fields.syncStatus,
        lastKnownRemoteHead: fields.lastKnownRemoteHead,
        lastSyncAt: fields.lastSyncAt,
      },
    });
    // Zero affected rows means the conflict guard blocked a non-conflicted write against a stored
    // `CONFLICTED` status (or no row exists) — the caller must report that stored truth, not the
    // derived status it tried to persist.
    return result.count > 0;
  }

  /**
   * Marks the project's repository row `NEEDS_REAUTH`, scoped to `WHERE syncStatus <>
   * 'CONFLICTED'` so a stored conflict is never overridden by a re-auth prompt. Writes only
   * `syncStatus` — every other column is left exactly as stored. Never inserts: a project with no
   * row (disconnected/deleted since the caller's earlier load) matches zero rows and is left
   * absent, mirroring {@link saveRefreshedStatus}'s row-gone safety.
   *
   * @param projectId - The project whose repository row to mark.
   * @returns `true` when a row was updated; `false` when the row is gone or was `CONFLICTED`.
   */
  async markNeedsReauthUnlessConflicted(projectId: ProjectId): Promise<boolean> {
    const result = await this.prisma.gitRepository.updateMany({
      where: { projectId: projectId.value, syncStatus: { not: 'CONFLICTED' } },
      data: { syncStatus: 'NEEDS_REAUTH' },
    });
    return result.count > 0;
  }

  /**
   * @param id - The unique identifier of the git repository to delete.
   */
  async delete(id: GitRepositoryId): Promise<void> {
    await this.prisma.gitRepository.deleteMany({ where: { id: id.value } });
  }
}

type GitRepositoryRecord = {
  id: string; projectId: string; provider: string; remoteUrl: string;
  credentialRef: string; currentBranch: string; syncStatus: string;
  defaultBranch: string | null; lastKnownRemoteHead: string | null;
  lastSyncAt: Date | null; createdAt: Date; connectedByUserId: string | null;
};

function toDomainGitRepository(record: GitRepositoryRecord): GitRepository {
  return new GitRepository(
    GitRepositoryId.create(record.id),
    ProjectId.create(record.projectId),
    GitProvider.create(record.provider.toLowerCase()),
    record.remoteUrl,
    record.credentialRef,
    record.currentBranch,
    toGitSyncStatus(record.syncStatus),
    record.defaultBranch,
    record.lastKnownRemoteHead,
    record.lastSyncAt,
    record.createdAt,
    record.connectedByUserId ? UserId.create(record.connectedByUserId) : null,
  );
}

function toPrismaProvider(value: string): 'GITHUB' | 'GITLAB' | 'BITBUCKET' {
  if (value === 'github') return 'GITHUB';
  if (value === 'gitlab') return 'GITLAB';
  return 'BITBUCKET';
}

function toPersistenceGitRepository(gitRepository: GitRepository): Prisma.GitRepositoryUncheckedCreateInput {
  return {
    id: gitRepository.id.value,
    projectId: gitRepository.projectId.value,
    provider: toPrismaProvider(gitRepository.provider.value),
    remoteUrl: gitRepository.remoteUrl,
    credentialRef: gitRepository.credentialReference,
    currentBranch: gitRepository.currentBranch,
    syncStatus: gitRepository.syncStatus,
    defaultBranch: gitRepository.defaultBranch,
    lastKnownRemoteHead: gitRepository.lastKnownRemoteHead,
    lastSyncAt: gitRepository.lastSyncAt,
    createdAt: gitRepository.createdAt,
    connectedByUserId: gitRepository.connectedByUserId?.value ?? null,
  };
}
