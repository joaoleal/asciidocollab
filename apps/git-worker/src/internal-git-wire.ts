import type { CompleteMergeResult, ListConflictsResult, UndoPullResult } from '@asciidocollab/domain';

/**
 * Wire-shaped mirror of a connected `GitRepository`, every value object mapped to its plain
 * string/primitive form (no `{"_value": "..."}` leakage) and every `Date` to an ISO-8601 string.
 */
export interface GitRepositoryWireData {
  /** Unique identifier of the repository link. */
  readonly id: string;
  /** ID of the project this repository is connected to. */
  readonly projectId: string;
  /** The git hosting provider. */
  readonly provider: string;
  /** The full remote URL of the git repository. */
  readonly remoteUrl: string;
  /** The currently checked-out branch. */
  readonly currentBranch: string;
  /** The remote's default branch, or null if not yet determined. */
  readonly defaultBranch: string | null;
  /** How the current branch compares to its remote counterpart. */
  readonly syncStatus: string;
  /** ISO-8601 timestamp of the last successful sync, or null if never synced. */
  readonly lastSyncAt: string | null;
  /** ID of the user who connected this repository, or null if unknown. */
  readonly connectedByUserId: string | null;
  /** ISO-8601 timestamp of when the repository link was created. */
  readonly createdAt: string;
}

/** Wire-shaped mirror of `ConnectRepositoryResult`, `repository` mapped to {@link GitRepositoryWireData}. */
export interface ConnectRepositoryWireResult {
  /** The newly connected repository link. */
  readonly repository: GitRepositoryWireData;
}

/**
 * Wire-shaped mirror of {@link CompleteMergeResult} with `operationId` mapped to a plain string.
 * `GitOperationId` (a `Uuid` subclass) defines no `toJSON`, so a bare `JSON.stringify` of the
 * domain result would otherwise serialize `operationId` as `{"_value": "<uuid>"}` instead of a
 * string — `composition-root.ts`'s `completePull` binding maps to this shape before handing its
 * result to this server.
 */
export type CompleteMergeWireResult = Omit<CompleteMergeResult, 'operationId'> & { readonly operationId: string };

/** Wire-shaped mirror of {@link UndoPullResult}, `operationId` mapped to a plain string. See {@link CompleteMergeWireResult}. */
export type UndoPullWireResult = Omit<UndoPullResult, 'operationId'> & { readonly operationId: string };

/** Wire-shaped mirror of {@link ListConflictsResult}, `operationId` mapped to a plain string. See {@link CompleteMergeWireResult}. */
export type ListConflictsWireResult = Omit<ListConflictsResult, 'operationId'> & { readonly operationId: string };

/**
 * One commit in the history endpoint's wire-shaped result, mirroring the domain's `HistoryCommit`
 * with `authorUserId` mapped to a plain string and `authoredAt` to an ISO-8601 string.
 * `composition-root.ts`'s `getHistory` binding maps to this shape before handing its result to this
 * server. See {@link GitRepositoryWireData} for why this mapping exists.
 */
export interface HistoryWireCommit {
  /** The commit hash. */
  readonly hash: string;
  /** The commit message. */
  readonly message: string;
  /** ID of the authoring user, when the commit's author maps to one; absent for unmapped authors. */
  readonly authorUserId?: string;
  /** ISO-8601 timestamp of when the commit was authored. */
  readonly authoredAt: string;
}

/** Wire-shaped mirror of the domain's `GetHistoryResult`, its commits mapped via {@link HistoryWireCommit}. */
export interface GetHistoryWireResult {
  /** The matching commits, newest first. */
  readonly commits: readonly HistoryWireCommit[];
}

/**
 * Wire-shaped mirror of the domain's `PreviewPullResult`, its commits mapped via
 * {@link HistoryWireCommit} — `PreviewPullResult.incomingCommits` reuses `HistoryCommit`'s exact
 * shape, so the same wire mapping applies unchanged.
 */
export interface PreviewPullWireResult {
  /** Commits that would land locally, newest first, if the pull actually ran. */
  readonly incomingCommits: readonly HistoryWireCommit[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/** Wire-shaped mirror of the domain's `PreviewPushResult`, its commits mapped via {@link HistoryWireCommit}. See {@link PreviewPullWireResult}. */
export interface PreviewPushWireResult {
  /** Commits that would land on the remote, newest first, if the push actually ran. */
  readonly outgoingCommits: readonly HistoryWireCommit[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/**
 * One line in the blame endpoint's wire-shaped result, mirroring the domain's `BlameLine` with
 * `authorUserId` mapped to a plain string and `authoredAt` to an ISO-8601 string.
 * `composition-root.ts`'s `getBlame` binding maps to this shape before handing its result to this
 * server. See {@link GitRepositoryWireData} for why this mapping exists.
 */
export interface BlameWireLine {
  /** 1-based line number in the blamed file. */
  readonly lineNumber: number;
  /** The full hash of the commit that last modified this line. */
  readonly hash: string;
  /** The subject/summary line of that commit (may be empty). */
  readonly message: string;
  /** ID of the authoring user, when the line's commit author maps to one; absent for unmapped authors. */
  readonly authorUserId?: string;
  /** ISO-8601 timestamp of when the line's commit was authored. */
  readonly authoredAt: string;
  /** The line's text content. */
  readonly content: string;
}

/** Wire-shaped mirror of the domain's `GetBlameResult`, its lines mapped via {@link BlameWireLine}. */
export interface GetBlameWireResult {
  /** Every line's authorship, in file order. */
  readonly lines: readonly BlameWireLine[];
}
