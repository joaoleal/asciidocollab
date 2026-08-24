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

/** A single working-tree change, staged or not, awaiting commit. */
export interface PendingChangeDto {
  /** Project-relative path of the changed file. */
  path: string;
  /** The kind of change. */
  changeType: PendingChangeType;
  /** Whether this change is currently staged for the next commit. */
  staged: boolean;
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
 * A file with competing changes from a pull/merge, with its three-way content
 * for the client's merge view. `resolution` is null until the file is resolved.
 */
export interface ConflictDto {
  /** Project-relative path of the conflicting file. */
  path: string;
  /** Whether the file is binary (no textual three-way diff is possible). */
  isBinary: boolean;
  /** The chosen resolution, or null while the conflict is still open. */
  resolution: ConflictResolution | null;
  /** The merge-base content, or null if the file did not exist there. */
  base: string | null;
  /** This branch's ("ours") content. */
  ours: string;
  /** The incoming branch's ("theirs") content. */
  theirs: string;
}
