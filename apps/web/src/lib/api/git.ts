/**
 * Git repository import API client: starts importing a remote repository into a brand-new project,
 * and polls the long-running operation that clone runs as.
 */
import { apiRequest } from '@/lib/api/transport';
import type {
  BehindAheadDto,
  CommitDto,
  FileGitStatus,
  GitOperationStatusDto,
  GitProvider,
  GitStatusDto,
} from '@asciidocollab/shared';

/** Request body for `POST /api/git/import`. */
export interface ImportRepositoryInput {
  /** The git hosting provider the remote lives on. */
  provider: GitProvider;
  /** The remote repository's URL. */
  remoteUrl: string;
  /**
   * The plaintext access token to authenticate with. Sent once in this request body; this client
   * never stores, logs, or otherwise retains it.
   */
  token: string;
  /** The branch to import. Left out entirely when not given, so the server falls back to the remote's default. */
  branch?: string;
}

/** What starting an import hands back: the operation to poll and the project it will populate. */
export interface ImportRepositoryResult {
  /** Identifier of the newly queued import operation. */
  operationId: string;
  /** Identifier of the new project the import will populate once it succeeds. */
  projectId: string;
}

/**
 * Starts importing a remote git repository as a brand-new project, owned by the caller. Resolves
 * as soon as the server has queued the import (`202`) — the returned identifiers are for polling
 * {@link getGitOperation}, not a sign the clone itself has finished.
 */
export async function importRepository(input: ImportRepositoryInput): Promise<ImportRepositoryResult> {
  return apiRequest('/api/git/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Reads the current state of a git operation (import, pull, push, …) belonging to a project.
 * Callers poll this on an interval until {@link isGitOperationTerminal} says to stop.
 */
export async function getGitOperation(projectId: string, operationId: string): Promise<GitOperationStatusDto> {
  return apiRequest(`/api/projects/${projectId}/git/operations/${operationId}`);
}

/** Response shape of `GET /api/projects/:projectId/git/tree-status`. */
export interface GitTreeStatus {
  /** Per-file git status, keyed by file node id. Files with no entry are unchanged. */
  statusByFileNodeId: Record<string, FileGitStatus>;
}

/**
 * Reads each file's current git status (modified, staged, untracked, …) for the project's file tree,
 * keyed by file node id. Callers treat a not-connected / 404 refusal (a project with no git repo) as
 * an empty map rather than an error — see {@link useGitTreeStatus}.
 */
export async function getGitTreeStatus(projectId: string): Promise<GitTreeStatus> {
  return apiRequest(`/api/projects/${projectId}/git/tree-status`);
}

/**
 * Reads the project's connected repository's working-tree status: the current branch, its sync
 * state, and every pending change bucketed by staged/unstaged/untracked/conflicted. The commit
 * dialog reads its `staged[]` bucket to show what a commit would include.
 */
export async function getGitStatus(projectId: string): Promise<GitStatusDto> {
  return apiRequest(`/api/projects/${projectId}/git/status`);
}

/**
 * Commits the project's currently staged changes with the given message. Named `commitChanges`
 * (rather than `commit`) to stay unambiguous next to unrelated React/git terminology.
 */
export async function commitChanges(projectId: string, message: string): Promise<{ commit: CommitDto }> {
  return apiRequest(`/api/projects/${projectId}/git/commit`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

/**
 * Reads how far the project's connected repository's current branch stands from its remote —
 * ahead/behind commit counts, as of the last time the remote-tracking ref was updated (not a live
 * network fetch). The status bar uses this for its real counts; `GitStatusDto.ahead`/`.behind` are a
 * fixed-`0` placeholder and must not be used for this.
 */
export async function getBehindAhead(projectId: string): Promise<BehindAheadDto> {
  return apiRequest(`/api/projects/${projectId}/git/behind-ahead`);
}

/** What starting a pull hands back: the operation to poll. */
export interface StartPullResult {
  /** Identifier of the newly queued pull operation. */
  operationId: string;
  /** Identifier of the project the pull applies to. */
  projectId: string;
}

/**
 * Starts pulling the connected repository's remote changes into the project. Resolves as soon as the
 * server has queued the pull (`202`) — the returned identifier is for polling {@link getGitOperation},
 * not a sign the pull itself has finished. Refused with a `409 open_files_need_confirm` when files are
 * open in live editing sessions and `confirmAffectsOpenFiles` was not passed as `true`.
 */
export async function startPull(
  projectId: string,
  options?: { confirmAffectsOpenFiles?: boolean },
): Promise<StartPullResult> {
  return apiRequest(`/api/projects/${projectId}/git/pull`, {
    method: 'POST',
    body: JSON.stringify(options?.confirmAffectsOpenFiles ? { confirmAffectsOpenFiles: true } : {}),
  });
}

/** The `GitOperationStatusDto` states that mean polling should stop. */
const TERMINAL_STATES: ReadonlySet<GitOperationStatusDto['state']> = new Set([
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
]);

/** Whether a git operation has reached a terminal state (won't change on further polling). */
export function isGitOperationTerminal(state: GitOperationStatusDto['state']): boolean {
  return TERMINAL_STATES.has(state);
}
