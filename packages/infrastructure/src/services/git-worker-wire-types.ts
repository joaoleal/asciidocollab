/**
 * @file The git-worker client's wire-level DTO vocabulary: the request-body inputs this client
 * posts, and the response `data` shapes it reads back. Infrastructure owns these wire types by
 * design so the domain layer never leaks into the transport format; they are kept deliberately
 * separate from `@asciidocollab/domain` result types rather than reused from there.
 */

/** The kind of working-tree change a pending change represents, as reported over the wire. */
export type GitWorkerChangeType = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

/** Where a pending change currently stands in the working tree/index, as reported over the wire. */
export type GitWorkerChangeState = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

/** A repository's synchronisation standing relative to its remote, as reported over the wire. */
export type GitWorkerSyncStatus =
  | 'UP_TO_DATE'
  | 'AHEAD'
  | 'BEHIND'
  | 'DIVERGED'
  | 'CONFLICTED'
  | 'DISCONNECTED'
  | 'NEEDS_REAUTH';

/** A single pending working-tree change, as reported over the wire. */
export interface GitWorkerPendingChange {
  /** Project-relative path of the changed file. */
  readonly path: string;
  /** The kind of change. */
  readonly changeType: GitWorkerChangeType;
  /** Where this change currently stands in the working tree/index. */
  readonly state: GitWorkerChangeState;
}

/** Wire shape of the status endpoint's `data` field. Timestamps stay ISO-8601 strings, as received. */
export interface GitWorkerStatusData {
  /** The currently checked-out branch. */
  readonly currentBranch: string;
  /** Every pending (uncommitted) change. */
  readonly changes: readonly GitWorkerPendingChange[];
  /** The repository's synchronisation standing relative to its remote. */
  readonly syncStatus: GitWorkerSyncStatus;
  /** The remote's default branch, or null if not yet known. */
  readonly defaultBranch: string | null;
  /** The last remote commit hash observed for the repository's current branch, or null if not yet known. */
  readonly lastKnownRemoteHead: string | null;
  /** ISO-8601 timestamp of the last successful synchronisation, or null if never synced. */
  readonly lastSyncAt: string | null;
}

/** Wire shape of the behind-ahead endpoint's `data` field. */
export interface GitWorkerBehindAheadData {
  /** Commits the remote has that the local branch does not. */
  readonly behind: number;
  /** Commits the local branch has that the remote does not. */
  readonly ahead: number;
}

/** Wire shape of the stage/unstage endpoints' `data` field. */
export interface GitWorkerStageData {
  /** Every path currently staged for the next commit. */
  readonly staged: readonly string[];
}

/** Wire shape of the commit endpoint's `data` field. `authoredAt` stays an ISO-8601 string, as received. */
export interface GitWorkerCommitData {
  /** The commit that was recorded. */
  readonly commit: {
    /** The new commit's hash. */
    readonly hash: string;
    /** The commit message, as recorded. */
    readonly message: string;
    /** ISO-8601 timestamp of when the commit was authored. */
    readonly authoredAt: string;
  };
}

/** Wire shape of a connected repository link, as reported over the wire. */
export interface GitWorkerRepositoryData {
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
  readonly syncStatus: GitWorkerSyncStatus;
  /** ISO-8601 timestamp of the last successful sync, or null if never synced. */
  readonly lastSyncAt: string | null;
  /** ID of the user who connected this repository, or null if unknown. */
  readonly connectedByUserId: string | null;
  /** ISO-8601 timestamp of when the repository link was created. */
  readonly createdAt: string;
}

/** Wire shape of the connect endpoint's `data` field. */
export interface GitWorkerConnectData {
  /** The newly connected repository link. */
  readonly repository: GitWorkerRepositoryData;
}

/** Wire shape of the branches endpoint's `data` field. */
export interface GitWorkerBranchListData {
  /** The currently checked-out branch. */
  readonly current: string;
  /** Every local branch name. */
  readonly branches: readonly string[];
}

/** Wire shape of the branch-create endpoint's `data` field. */
export interface GitWorkerCreatedBranchData {
  /** The branch that was created. */
  readonly branch: {
    /** The new branch's name, as created. */
    readonly name: string;
  };
}

/** One conflicting file in the conflict-list endpoint's `data` field — no content, just enough to drive the panel. */
export interface GitWorkerConflictSummaryData {
  /** Project-relative path of the conflicting file. */
  readonly path: string;
  /** Whether the file is binary. */
  readonly isBinary: boolean;
  /** Whether this file's conflict already has a recorded resolution. */
  readonly resolved: boolean;
}

/** Wire shape of the conflict-list endpoint's `data` field. */
export interface GitWorkerConflictListData {
  /** The awaiting operation these conflicts belong to. */
  readonly operationId: string;
  /** Every conflicting file, in recorded order. */
  readonly files: readonly GitWorkerConflictSummaryData[];
}

/** Wire shape of the conflict-stages endpoint's `data` field. */
export interface GitWorkerConflictStagesData {
  /** The merge-base content, or null when the file had no merge base (an add/add conflict). */
  readonly base: string | null;
  /** This branch's ("ours") content; null when "ours" deleted the file (a modify/delete conflict). Empty for a binary conflict. */
  readonly ours: string | null;
  /** The incoming branch's ("theirs") content; null when "theirs" deleted the file (a modify/delete conflict). Empty for a binary conflict. */
  readonly theirs: string | null;
  /** Whether the file is binary (no textual three-way view). */
  readonly isBinary: boolean;
}

/** Wire shape of the conflict-resolve endpoint's `data` field. */
export interface GitWorkerResolveConflictData {
  /** Always `true` on success. */
  readonly resolved: true;
}

/** Wire shape of the pull-complete endpoint's `data` field. */
export interface GitWorkerCompleteMergeData {
  /** Always `'resolved'` on success. */
  readonly status: 'resolved';
  /** The completed operation. */
  readonly operationId: string;
  /** The resolving merge commit's hash for a completed `PULL`; empty string for a `BRANCH_SWITCH`. */
  readonly headCommit: string;
}

/** Wire shape of the undo-pull endpoint's `data` field. */
export interface GitWorkerUndoPullData {
  /** The pull operation that was undone. */
  readonly operationId: string;
  /** The commit the working tree was restored to. */
  readonly headCommit: string;
}

/** One commit in the history endpoint's `data` field. `authoredAt` stays an ISO-8601 string, as received. */
export interface GitWorkerHistoryCommit {
  /** The commit hash. */
  readonly hash: string;
  /** The commit message. */
  readonly message: string;
  /** ID of the authoring user, when the commit's author maps to one; absent for unmapped authors. */
  readonly authorUserId?: string;
  /** ISO-8601 timestamp of when the commit was authored. */
  readonly authoredAt: string;
}

/** Wire shape of the history endpoint's `data` field. */
export interface GitWorkerHistoryData {
  /** The matching commits, newest first. */
  readonly commits: readonly GitWorkerHistoryCommit[];
}

/** Wire shape of the diff endpoint's `data` field. */
export interface GitWorkerDiffData {
  /** The raw unified-diff text. */
  readonly unified: string;
}

/** One line in the blame endpoint's `data` field. `authoredAt` stays an ISO-8601 string, as received. */
export interface GitWorkerBlameLine {
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

/** Wire shape of the blame endpoint's `data` field. */
export interface GitWorkerBlameData {
  /** Every line's authorship, in file order. */
  readonly lines: readonly GitWorkerBlameLine[];
}

/** Wire shape of the discard endpoint's `data` field. */
export interface GitWorkerDiscardData {
  /** Every path this run restored. */
  readonly restoredPaths: readonly string[];
}

/**
 * One commit in a pull/push preview's `data` field. `authoredAt` stays an ISO-8601 string, as
 * received. Structurally identical to `GitWorkerHistoryCommit`, kept as its own named type so this
 * module owns its own wire vocabulary for the preview endpoints rather than reusing another
 * endpoint's type by coincidence.
 */
export interface GitWorkerPreviewCommit {
  /** The commit hash. */
  readonly hash: string;
  /** The commit message. */
  readonly message: string;
  /** ID of the authoring user, when the commit's author maps to one; absent for unmapped authors. */
  readonly authorUserId?: string;
  /** ISO-8601 timestamp of when the commit was authored. */
  readonly authoredAt: string;
}

/** Wire shape of the pull-preview endpoint's `data` field. */
export interface GitWorkerPreviewPullData {
  /** Commits that would land locally, newest first, if the pull actually ran. */
  readonly incomingCommits: readonly GitWorkerPreviewCommit[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/** Wire shape of the push-preview endpoint's `data` field. */
export interface GitWorkerPreviewPushData {
  /** Commits that would land on the remote, newest first, if the push actually ran. */
  readonly outgoingCommits: readonly GitWorkerPreviewCommit[];
  /** Every path those commits touch. */
  readonly changedPaths: readonly string[];
}

/** Input shared by every git-worker request: the project and the acting principal. */
export interface GitWorkerRequestInput {
  /** The project the operation acts on, as a raw UUID v4 string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID v4 string. */
  readonly actorId: string;
}

/** Input for {@link GitWorkerClient.stageChanges}/{@link GitWorkerClient.unstageChanges}. */
export interface GitWorkerStageInput extends GitWorkerRequestInput {
  /** Workspace-relative POSIX paths of the files to stage/unstage. */
  readonly paths: readonly string[];
}

/** Input for {@link GitWorkerClient.commitChanges}. */
export interface GitWorkerCommitInput extends GitWorkerRequestInput {
  /** The commit message. */
  readonly message: string;
}

/** Input for {@link GitWorkerClient.connect}. */
export interface GitWorkerConnectInput extends GitWorkerRequestInput {
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  readonly provider: string;
  /** The remote repository's URL. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Never logged, echoed, or persisted as-is. */
  readonly token: string;
  /** The branch to check out initially. Defaults to `'main'` when omitted. */
  readonly branch?: string;
}

/** Input for {@link GitWorkerClient.createBranch}. */
export interface GitWorkerCreateBranchInput extends GitWorkerRequestInput {
  /** The new branch's name. */
  readonly name: string;
}

/** Input for {@link GitWorkerClient.getConflictStages}. */
export interface GitWorkerConflictPathInput extends GitWorkerRequestInput {
  /** Project-relative path of the conflicting file. */
  readonly path: string;
}

/** Input for {@link GitWorkerClient.resolveConflict}. */
export interface GitWorkerResolveConflictInput extends GitWorkerConflictPathInput {
  /** The chosen resolution for the whole file. */
  readonly resolution: 'ours' | 'theirs' | 'merged';
  /** The user-edited merged content; required when {@link resolution} is `'merged'`. */
  readonly mergedContent?: string;
}

/** Input for {@link GitWorkerClient.getHistory}. */
export interface GitWorkerHistoryInput extends GitWorkerRequestInput {
  /** When given, restricts the history to the commits that touched this single project-relative file. */
  readonly path?: string;
  /** When given, caps the number of commits returned. */
  readonly limit?: number;
}

/** Input for {@link GitWorkerClient.getDiff}. */
export interface GitWorkerDiffInput extends GitWorkerRequestInput {
  /** When given, scopes the diff to this single project-relative file (whole tree when absent). */
  readonly path?: string;
  /** The earlier commit hash. Given together with `to` to diff between two commits. */
  readonly from?: string;
  /** The later commit hash. Given together with `from` to diff between two commits. */
  readonly to?: string;
}

/** Input for {@link GitWorkerClient.getBlame}. */
export interface GitWorkerBlameInput extends GitWorkerRequestInput {
  /** The project-relative path of the file to blame. */
  readonly path: string;
  /** When given, blames the file as of this commit; without it, the current working-tree file. */
  readonly ref?: string;
}

/** Input for {@link GitWorkerClient.discardChanges}. */
export interface GitWorkerDiscardInput extends GitWorkerRequestInput {
  /** Project-relative paths of the files to restore. */
  readonly paths: readonly string[];
  /** When given, restores each path to its content at this commit instead of dropping back to HEAD. */
  readonly fromCommit?: string;
}

/** Input for {@link GitWorkerClient.amendCommit}. */
export interface GitWorkerAmendInput extends GitWorkerRequestInput {
  /** The replacement commit message. When absent, the amended commit keeps its existing message. */
  readonly message?: string;
}

/** Input for {@link GitWorkerClient.previewPull}/{@link GitWorkerClient.previewPush}. */
export interface GitWorkerPreviewInput extends GitWorkerRequestInput {
  /** The branch to preview. Defaults to the project's current branch when omitted. */
  readonly branch?: string;
}
