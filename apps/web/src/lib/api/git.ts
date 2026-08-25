/**
 * Git repository import API client: starts importing a remote repository into a brand-new project,
 * and polls the long-running operation that clone runs as.
 */
import { apiRequest } from '@/lib/api/transport';
import type { FileGitStatus, GitOperationStatusDto, GitProvider } from '@asciidocollab/shared';

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
