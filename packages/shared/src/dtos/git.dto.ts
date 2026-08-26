/**
 * @file Wire DTOs for git repository synchronization. These are the shapes every
 * git use case and route speaks: `GitCommandRunner` and the git use cases return
 * them inside `Result<T, E>`, and the API surfaces them to the client. Git-library
 * types (e.g. `simple-git`) MUST stay inside the infrastructure adapter and never
 * cross this boundary.
 */

/** Git hosting provider a project's repository connects to. */
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

/** The providers a repository connection may use. */
export const GIT_PROVIDERS: readonly GitProvider[] = ['github', 'gitlab', 'bitbucket'];

/** Narrows an arbitrary string to a {@link GitProvider}. */
export function isGitProvider(value: string): value is GitProvider {
  const providers: readonly string[] = GIT_PROVIDERS;
  return providers.includes(value);
}

/** How a connected repository's current branch compares to its remote. */
export type GitSyncStatus = 'UP_TO_DATE' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'CONFLICTED' | 'DISCONNECTED';

/** The sync states a connected repository may be in. */
export const GIT_SYNC_STATUSES: readonly GitSyncStatus[] = [
  'UP_TO_DATE',
  'AHEAD',
  'BEHIND',
  'DIVERGED',
  'CONFLICTED',
  'DISCONNECTED',
];

/** Narrows an arbitrary string to a {@link GitSyncStatus}. */
export function isGitSyncStatus(value: string): value is GitSyncStatus {
  const statuses: readonly string[] = GIT_SYNC_STATUSES;
  return statuses.includes(value);
}

/**
 * A project's connected git repository. Never carries the credential itself —
 * only `connectedByUserId` and the branch/sync projection a client may render
 * (Security Constitution: the client-facing shape exposes only a token hint,
 * never a credential reference).
 */
export interface GitRepositoryDto {
  /** Unique identifier of the repository link. */
  id: string;
  /** ID of the project this repository is connected to. */
  projectId: string;
  /** The git hosting provider. */
  provider: GitProvider;
  /** The full remote URL of the git repository. */
  remoteUrl: string;
  /** The currently checked-out branch. */
  currentBranch: string;
  /** The remote's default branch, or null if not yet determined. */
  defaultBranch: string | null;
  /** How the current branch compares to its remote counterpart. */
  syncStatus: GitSyncStatus;
  /** ISO 8601 timestamp of the last successful sync, or null if never synced. */
  lastSyncAt: string | null;
  /** ID of the user who connected this repository, or null if unknown. */
  connectedByUserId: string | null;
  /** ISO 8601 timestamp of when the repository link was created. */
  createdAt: string;
}

/** A branch in the connected repository. */
export interface BranchDto {
  /** The branch name. */
  name: string;
  /** Whether this is the currently checked-out branch. */
  isCurrent: boolean;
}

/**
 * A project's local branches: the checked-out branch plus every local branch, each flagged
 * whether it is the one currently checked out.
 */
export interface BranchListDto {
  /** The currently checked-out branch. */
  current: string;
  /** Every local branch, in no particular order. */
  branches: BranchDto[];
}

/** A single commit in the repository's history. */
export interface CommitDto {
  /** The commit hash. */
  hash: string;
  /** The commit message. */
  message: string;
  /** ID of the authoring user, when the commit's author maps to one; absent for unmapped authors such as imported history. */
  authorUserId?: string;
  /** ISO 8601 timestamp of when the commit was authored. */
  authoredAt: string;
}

/**
 * The kind of change a working-tree modification represents. `renamed` is the
 * canonical label for a move as well as a rename — there is no separate `moved` value.
 */
export type PendingChangeType = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

/** The change types a pending change may take. */
export const PENDING_CHANGE_TYPES: readonly PendingChangeType[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
];

/** Narrows an arbitrary string to a {@link PendingChangeType}. */
export function isPendingChangeType(value: string): value is PendingChangeType {
  const types: readonly string[] = PENDING_CHANGE_TYPES;
  return types.includes(value);
}

/**
 * A single working-tree change, awaiting commit. Which of the four buckets on
 * {@link GitStatusDto} (`staged`/`unstaged`/`untracked`/`conflicted`) a change appears in already
 * encodes its state, so an element carries only what the bucket does not: the path and the kind
 * of change.
 */
export interface PendingChangeDto {
  /** Project-relative path of the changed file. */
  path: string;
  /** The kind of change. */
  changeType: PendingChangeType;
}

/**
 * A project's connected repository's working-tree status: the current branch, how it compares to
 * its remote, and every pending change bucketed by where it stands.
 */
export interface GitStatusDto {
  /** The currently checked-out branch. */
  branch: string;
  /** How the current branch compares to its remote counterpart. */
  syncStatus: GitSyncStatus;
  /**
   * Commits the current branch is ahead of its remote counterpart by. A fixed `0` today — the
   * underlying sync computation is qualitative only (see `syncStatus`); a dedicated numeric
   * ahead/behind count is a later capability.
   */
  ahead: number;
  /** Commits the current branch is behind its remote counterpart by. See `ahead`. */
  behind: number;
  /** ISO 8601 timestamp of the last successful sync, or null if never synced. */
  lastSyncAt: string | null;
  /** Changes staged for the next commit. */
  staged: PendingChangeDto[];
  /** Changes to tracked files not yet staged. */
  unstaged: PendingChangeDto[];
  /** Changes to files not yet tracked by git. */
  untracked: PendingChangeDto[];
  /** Changes with unresolved merge conflicts. */
  conflicted: PendingChangeDto[];
}

/** How far the current branch is ahead of / behind its remote counterpart, as of the last fetch. */
export interface BehindAheadDto {
  /** Commits the remote has that the local branch does not. */
  readonly behind: number;
  /** Commits the local branch has that the remote does not. */
  readonly ahead: number;
}

/**
 * A rendered diff for `GET /git/diff`. Rendering (unified-to-side-by-side, syntax highlighting,
 * etc.) is a client concern — the server supplies only the raw unified-diff text.
 */
export interface DiffDto {
  /** The raw unified-diff text. Empty when there is nothing to diff. */
  readonly unified: string;
}

/**
 * One line of a blamed file's per-line authorship, for `GET /git/blame`. `authorUserId` is
 * absent for a git author email that maps to no platform user (for example, imported history
 * authored outside the platform).
 */
export interface BlameLineDto {
  /** 1-based line number in the blamed file. */
  readonly lineNumber: number;
  /** The full hash of the commit that last modified this line. */
  readonly hash: string;
  /** ID of the authoring user, when the line's commit author maps to one; absent for unmapped authors. */
  readonly authorUserId?: string;
  /** ISO 8601 timestamp of when the line's commit was authored. */
  readonly authoredAt: string;
  /** The line's text content. */
  readonly content: string;
}

/** A single file's per-line authorship ("blame"), for `GET /git/blame`. */
export interface BlameDto {
  /** Every line's authorship, in file order. */
  readonly lines: BlameLineDto[];
}

/** Per-file git status used to decorate the project's file tree. */
export type FileGitStatus = 'unchanged' | 'modified' | 'staged' | 'untracked' | 'removed' | 'conflicted';

/** The statuses a file may take in the tree-status projection. */
export const FILE_GIT_STATUSES: readonly FileGitStatus[] = [
  'unchanged',
  'modified',
  'staged',
  'untracked',
  'removed',
  'conflicted',
];

/** Narrows an arbitrary string to a {@link FileGitStatus}. */
export function isFileGitStatus(value: string): value is FileGitStatus {
  const statuses: readonly string[] = FILE_GIT_STATUSES;
  return statuses.includes(value);
}

/** How a conflicted file's competing changes were, or may be, resolved. */
export type ConflictResolution = 'ours' | 'theirs' | 'merged';

/** The resolutions a conflicted file may be given. */
export const CONFLICT_RESOLUTIONS: readonly ConflictResolution[] = ['ours', 'theirs', 'merged'];

/** Narrows an arbitrary string to a {@link ConflictResolution}. */
export function isConflictResolution(value: string): value is ConflictResolution {
  const resolutions: readonly string[] = CONFLICT_RESOLUTIONS;
  return resolutions.includes(value);
}

/**
 * One conflicting file in the `GET /git/conflicts` list — no content, just enough to drive the
 * conflict list panel (path, whether it's binary, and whether it's already resolved).
 */
export interface ConflictSummaryDto {
  /** Project-relative path of the conflicting file. */
  path: string;
  /** Whether the file is binary (no textual three-way diff is possible). */
  isBinary: boolean;
  /** Whether this file's conflict has already been resolved. */
  resolved: boolean;
}

/** A project's currently conflicting files, for the conflict list panel. */
export interface ConflictListDto {
  /** The awaiting operation these conflicts belong to. */
  operationId: string;
  /** Every conflicting file, in the order they were recorded. */
  files: ConflictSummaryDto[];
}

/**
 * One conflicting file's three-way content, for the `GET /git/conflicts/:path` merge view. A
 * binary conflict carries no text — `base`/`ours`/`theirs` are empty and `isBinary` is `true`, so
 * the client offers only whole-file ours/theirs actions, never the inline text editor.
 */
export interface ConflictStagesDto {
  /** The merge-base content, or null when the file had no merge base (an add/add conflict). */
  base: string | null;
  /** This branch's ("ours") content. Empty for a binary conflict. */
  ours: string;
  /** The incoming branch's ("theirs") content. Empty for a binary conflict. */
  theirs: string;
  /** Whether the file is binary (no textual three-way view). */
  isBinary: boolean;
}

/** The kind of whole-project git action a `GitOperation` performs. */
export type GitOperationKind =
  | 'IMPORT'
  | 'INITIALIZE'
  | 'CONNECT'
  | 'DISCONNECT'
  | 'COMMIT'
  | 'PUSH'
  | 'PULL'
  | 'FETCH'
  | 'BRANCH_CREATE'
  | 'BRANCH_SWITCH'
  | 'RESOLVE'
  | 'DISCARD'
  | 'AMEND'
  | 'UNDO_PULL';

/** The kinds a whole-project git operation may take. */
export const GIT_OPERATION_KINDS: readonly GitOperationKind[] = [
  'IMPORT',
  'INITIALIZE',
  'CONNECT',
  'DISCONNECT',
  'COMMIT',
  'PUSH',
  'PULL',
  'FETCH',
  'BRANCH_CREATE',
  'BRANCH_SWITCH',
  'RESOLVE',
  'DISCARD',
  'AMEND',
  'UNDO_PULL',
];

/** Narrows an arbitrary string to a {@link GitOperationKind}. */
export function isGitOperationKind(value: string): value is GitOperationKind {
  const kinds: readonly string[] = GIT_OPERATION_KINDS;
  return kinds.includes(value);
}

/** The lifecycle state of a `GitOperation` — see the domain entity for the full state machine. */
export type GitOperationState = 'QUEUED' | 'RUNNING' | 'AWAITING_CONFLICT' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';

/** The states a whole-project git operation may be in. */
export const GIT_OPERATION_STATES: readonly GitOperationState[] = [
  'QUEUED',
  'RUNNING',
  'AWAITING_CONFLICT',
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
];

/** Narrows an arbitrary string to a {@link GitOperationState}. */
export function isGitOperationState(value: string): value is GitOperationState {
  const states: readonly string[] = GIT_OPERATION_STATES;
  return states.includes(value);
}

/**
 * The polled progress/status of a whole-project `GitOperation` — what a client repeatedly reads
 * back after a `202` to learn how a long-running action (import/pull/push/…) is progressing.
 * Carries no credential or other sensitive material; only the fields a progress UI needs.
 */
export interface GitOperationStatusDto {
  /** Unique identifier of the operation. */
  id: string;
  /** The kind of git action this operation performs. */
  kind: GitOperationKind;
  /** The operation's current lifecycle state. */
  state: GitOperationState;
  /** Progress percentage, 0 to 100. */
  progress: number;
  /** Typed, safe error code recorded on failure, or null while not failed. */
  errorCode: string | null;
}

/**
 * A project's current whole-project git operation, for a project member polling to learn whether
 * ANY member's (or the system's) git activity is in progress — the read-only "git activity" signal
 * derived from the same `GitOperation` row the progress-polling status read uses.
 */
export interface ActiveGitOperationDto {
  /** The project's current active operation (`QUEUED`, `RUNNING`, or `AWAITING_CONFLICT`), or null when none is active. */
  operation: GitOperationStatusDto | null;
}

/**
 * A dry-run preview of what pulling the project's current branch would bring in, without applying
 * anything: the incoming commits and the paths they touch, plus whether any document anywhere in
 * the project currently has an active live editing session. `affectsOpenFiles` is informational
 * only here — this route never blocks on it, unlike the real pull's own `409` gate.
 */
export interface PullPreviewDto {
  /** Commits that would land locally, newest first, if the pull actually ran. */
  readonly incomingCommits: CommitDto[];
  /** Every path those commits touch. */
  readonly changedPaths: string[];
  /** Whether any document in the project currently has an active live editing session. */
  readonly affectsOpenFiles: boolean;
}

/**
 * A dry-run preview of what pushing the project's current branch would send out, without applying
 * anything: the outgoing commits and the paths they touch.
 */
export interface PushPreviewDto {
  /** Commits that would land on the remote, newest first, if the push actually ran. */
  readonly outgoingCommits: CommitDto[];
  /** Every path those commits touch. */
  readonly changedPaths: string[];
}
