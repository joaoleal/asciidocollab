/**
 * Git repository import API client: starts importing a remote repository into a brand-new project,
 * and polls the long-running operation that clone runs as.
 */
import { apiRequest } from '@/lib/api/transport';
import type {
  ActiveGitOperationDto,
  BehindAheadDto,
  BranchDto,
  BranchListDto,
  CommitDto,
  ConflictListDto,
  ConflictResolution,
  ConflictStagesDto,
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

/**
 * Reads the project's current whole-project git operation, if any — the collaboration-facing "git
 * activity" signal: any member's or the system's `QUEUED`/`RUNNING`/`AWAITING_CONFLICT` operation,
 * not just one the caller started. Callers poll this on an interval — see the `useGitActivity` hook.
 */
export async function getActiveGitOperation(projectId: string): Promise<ActiveGitOperationDto> {
  return apiRequest(`/api/projects/${projectId}/git/active-operation`);
}

/**
 * Reads the project's connected repository's local branches and which one is currently checked
 * out. Any project member may read this (unlike creating or switching, which require editor tier).
 */
export async function getBranches(projectId: string): Promise<BranchListDto> {
  return apiRequest(`/api/projects/${projectId}/git/branches`);
}

/** What creating a branch hands back. A freshly created branch is never the checked-out one. */
export interface CreateBranchResult {
  /** The newly created branch. */
  branch: BranchDto;
}

/**
 * Creates a new branch from the project's current branch tip. Synchronous, unlike checkout/pull —
 * creating a branch does not touch the working tree, so there is no operation to poll.
 */
export async function createBranch(projectId: string, name: string): Promise<CreateBranchResult> {
  return apiRequest(`/api/projects/${projectId}/git/branches`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/** The two synchronous refusals `checkoutBranch` can be retried past, once the caller confirms. */
export type BranchSwitchConfirmCode = 'uncommitted_changes' | 'open_files_need_confirm';

/** Request body for {@link checkoutBranch}. */
export interface CheckoutBranchInput {
  /** The branch to switch to. */
  name: string;
  /** Acknowledges that files open in live editing sessions may be affected by the switch. */
  confirmAffectsOpenFiles?: boolean;
  /** Acknowledges that uncommitted local changes should ride across the switch (stashed and reapplied). */
  stashLocal?: boolean;
}

/** What starting a branch switch hands back: the operation to poll. */
export interface CheckoutBranchResult {
  /** Identifier of the newly queued branch-switch operation. */
  operationId: string;
  /** Identifier of the project the switch applies to. */
  projectId: string;
}

/**
 * Starts switching the connected repository's checked-out branch. Resolves as soon as the server
 * has queued the switch (`202`) — the returned identifier is for polling {@link getGitOperation},
 * not a sign the switch itself has finished. Refused with `409 uncommitted_changes` when the
 * working tree has pending changes and `stashLocal` was not passed as `true`, and with
 * `409 open_files_need_confirm` when files are open in live editing sessions and
 * `confirmAffectsOpenFiles` was not passed as `true` — both checked in that order.
 */
export async function checkoutBranch(
  projectId: string,
  input: CheckoutBranchInput,
): Promise<CheckoutBranchResult> {
  const body: { name: string; confirmAffectsOpenFiles?: boolean; stashLocal?: boolean } = { name: input.name };
  if (input.confirmAffectsOpenFiles) body.confirmAffectsOpenFiles = true;
  if (input.stashLocal) body.stashLocal = true;
  return apiRequest(`/api/projects/${projectId}/git/checkout`, {
    method: 'POST',
    body: JSON.stringify(body),
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

/**
 * Reads the project's currently conflicting files, for the conflict resolution panel — the awaiting
 * operation's `operationId` plus one summary per conflicting file (path, whether it's binary, and
 * whether it has already been resolved). A project with no conflicts awaiting resolution refuses
 * with `404`; see {@link useConflicts} for how that resolves to "not in conflict" rather than an error.
 */
export async function getConflicts(projectId: string): Promise<ConflictListDto> {
  return apiRequest(`/api/projects/${projectId}/git/conflicts`);
}

/**
 * Reads one conflicting file's three-way content — the merge-base, "ours", and "theirs" versions —
 * for the inline merge editor. The path is URL-encoded, since a project-relative path may itself
 * contain `/` or other characters that would otherwise be read as additional path segments.
 */
export async function getConflictStages(projectId: string, path: string): Promise<ConflictStagesDto> {
  return apiRequest(`/api/projects/${projectId}/git/conflicts/${encodeURIComponent(path)}`);
}

/** Request body for {@link resolveConflict}. */
export interface ResolveConflictInput {
  /** How this file's conflict is being resolved. */
  resolution: ConflictResolution;
  /** The final merged text. Required (and only sent) when `resolution` is `'merged'`. */
  mergedContent?: string;
}

/**
 * Resolves one conflicting file: keep "ours", take "theirs", or apply the caller's merged text. The
 * path is URL-encoded, same as {@link getConflictStages}. `mergedContent` is included in the request
 * body only when `resolution` is `'merged'` — sending it for `'ours'`/`'theirs'` would suggest content
 * neither of those resolutions uses.
 */
export async function resolveConflict(
  projectId: string,
  path: string,
  input: ResolveConflictInput,
): Promise<{ resolved: true }> {
  const body: ResolveConflictInput =
    input.resolution === 'merged' ? { resolution: input.resolution, mergedContent: input.mergedContent } : { resolution: input.resolution };
  return apiRequest(`/api/projects/${projectId}/git/conflicts/${encodeURIComponent(path)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** What completing a paused pull hands back: the operation to poll. */
export interface CompletePullResult {
  /** Identifier of the newly queued completion operation. */
  operationId: string;
}

/**
 * Completes a pull that paused on conflicts, once every conflicting file has been resolved.
 * Resolves as soon as the server has queued the completion (`202`) — the returned identifier is for
 * polling {@link getGitOperation}, not a sign completion itself has finished. Refused with
 * `409 unresolved_conflicts` when a file is still unresolved.
 */
export async function completePull(projectId: string): Promise<CompletePullResult> {
  return apiRequest(`/api/projects/${projectId}/git/pull/complete`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** What undoing a paused pull hands back: the operation to poll. */
export interface UndoPullResult {
  /** Identifier of the newly queued undo operation. */
  operationId: string;
}

/**
 * Abandons a pull that paused on conflicts, reverting the working tree to its state before the pull
 * started. Resolves as soon as the server has queued the undo (`202`) — the returned identifier is
 * for polling {@link getGitOperation}, not a sign the undo itself has finished. Refused with
 * `409 nothing_to_undo` when there is no paused pull to undo.
 */
export async function undoPull(projectId: string): Promise<UndoPullResult> {
  return apiRequest(`/api/projects/${projectId}/git/undo-pull`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
