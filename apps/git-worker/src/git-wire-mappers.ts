import type { GitOperationId, GitRepository, HistoryCommit } from '@asciidocollab/domain';
import type { GitRepositoryWireData, HistoryWireCommit } from './internal-git-server.js';

/**
 * Maps a use-case result whose `operationId` field is a `GitOperationId` value object to the
 * wire-shaped result the internal RPC server serializes onto the HTTP response: `.value` (a plain
 * string) in place of the value object itself, with every other field passed through unchanged.
 * `GitOperationId` (a `Uuid` subclass) defines no `toJSON`, so a bare `JSON.stringify` of the
 * domain result would otherwise serialize `operationId` as `{"_value": "<uuid>"}` — malformed for
 * the API route/client, which expect a plain string. Exported so it can be exercised directly
 * (over a real `GitOperationId`, not a pre-stringified test fixture) without needing a database.
 *
 * @param result - A use-case success value carrying a real `operationId` field.
 * @returns The same value with `operationId` replaced by its plain-string `.value`.
 */
export function mapOperationId<T extends { operationId: GitOperationId }>(
  result: T,
): Omit<T, 'operationId'> & { operationId: string } {
  const { operationId, ...rest } = result;
  return { ...rest, operationId: operationId.value };
}

/**
 * Maps a real `GitRepository` entity to the wire-shaped mirror the internal RPC server serializes
 * onto the HTTP response: every value object (`GitRepositoryId`/`ProjectId`/`GitProvider`/`UserId`)
 * replaced by its plain `.value`, and every `Date` by an ISO-8601 string. None of those value
 * objects define `toJSON`, so a bare `JSON.stringify` of the entity would otherwise serialize each
 * as `{"_value": "..."}` — the same class of bug {@link mapOperationId} exists to close. Exported so
 * it can be exercised directly over a REAL `GitRepository` (not a pre-stringified test fixture).
 *
 * @param repository - The connected repository entity.
 * @returns Its wire-shaped mirror.
 */
export function mapGitRepositoryToWire(repository: GitRepository): GitRepositoryWireData {
  return {
    id: repository.id.value,
    projectId: repository.projectId.value,
    provider: repository.provider.value,
    remoteUrl: repository.remoteUrl,
    currentBranch: repository.currentBranch,
    defaultBranch: repository.defaultBranch,
    syncStatus: repository.syncStatus,
    lastSyncAt: repository.lastSyncAt ? repository.lastSyncAt.toISOString() : null,
    connectedByUserId: repository.connectedByUserId ? repository.connectedByUserId.value : null,
    createdAt: repository.createdAt.toISOString(),
  };
}

/**
 * Maps a use case's `HistoryCommit[]`-shaped result to the wire shape the internal RPC server
 * serializes: `authorUserId` to its plain `.value` (present only when the author mapped to a
 * platform user) and `authoredAt` to an ISO-8601 string. Shared by `getHistory` and the two preview
 * op fns — `PreviewPullResult.incomingCommits`/`PreviewPushResult.outgoingCommits` reuse
 * `HistoryCommit`'s exact shape, so the same mapping applies unchanged.
 *
 * @param commits - The commits to map, in the order they should appear on the wire.
 * @returns The wire-shaped mirror of each commit.
 */
export function mapHistoryCommitsToWire(commits: readonly HistoryCommit[]): HistoryWireCommit[] {
  return commits.map((commit) => ({
    hash: commit.hash,
    message: commit.message,
    ...(commit.authorUserId === undefined ? {} : { authorUserId: commit.authorUserId.value }),
    authoredAt: commit.authoredAt.toISOString(),
  }));
}
