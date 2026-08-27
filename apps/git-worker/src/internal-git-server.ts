import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import {
  DomainError,
  type AmendCommitResult,
  type CommitChangesResult,
  type CompleteMergeResult,
  type CreateBranchResult,
  type DiscardChangesResult,
  type GetBranchesResult,
  type GetConflictStagesResult,
  type GetGitStatusResult,
  type GitBehindAhead,
  type GitDiffResult,
  type ListConflictsResult,
  type ResolveConflictsResult,
  type Result,
  type StageChangesResult,
  type UndoPullResult,
} from '@asciidocollab/domain';
import { SECRET_HEADER, secretMatches } from './internal-git-server/auth.js';
import { toEnvelope } from './internal-git-server/envelope.js';
import {
  parseGitStatusBody,
  parseStageChangesBody,
  parseCommitChangesBody,
  parseConnectBody,
  parseCreateBranchBody,
  parseConflictPathBody,
  parseResolveConflictBody,
  parseHistoryBody,
  parseDiffBody,
  parseBlameBody,
  parseDiscardBody,
  parseAmendBody,
  parsePreviewPullBody,
  parsePreviewPushBody,
} from './internal-git-server/request-parsers.js';
import type {
  GitStatusRequest,
  StageChangesRequest,
  CommitChangesRequest,
  ConnectRequest,
  CreateBranchRequest,
  ConflictPathRequest,
  ResolveConflictRequest,
  HistoryRequest,
  DiffRequest,
  BlameRequest,
  DiscardRequest,
  AmendRequest,
  PreviewRequest,
} from './internal-git-server/request-parsers.js';

// Re-exported so the API's internal client, the composition root, and this app's tests keep a single
// import site for the request parsers and their raw request shapes even though they now live beside
// this server.
export {
  parseGitStatusBody,
  parseStageChangesBody,
  parseCommitChangesBody,
  parseConnectBody,
  parseCreateBranchBody,
  parseConflictPathBody,
  parseResolveConflictBody,
  parseHistoryBody,
  parseDiffBody,
  parseBlameBody,
  parseDiscardBody,
  parseAmendBody,
  parsePreviewPullBody,
  parsePreviewPushBody,
} from './internal-git-server/request-parsers.js';
export type {
  GitStatusRequest,
  StageChangesRequest,
  CommitChangesRequest,
  ConnectRequest,
  CreateBranchRequest,
  ConflictPathRequest,
  ResolveConflictRequest,
  HistoryRequest,
  DiffRequest,
  BlameRequest,
  DiscardRequest,
  AmendRequest,
  PreviewRequest,
} from './internal-git-server/request-parsers.js';

/** Path of the internal endpoint the API calls to read a project's working-tree git status. */
export const GIT_STATUS_PATH = '/internal/git/status';

/** Path of the internal endpoint the API calls to compare the current branch to its remote. */
export const GIT_BEHIND_AHEAD_PATH = '/internal/git/behind-ahead';

/** Path of the internal endpoint the API calls to stage files for the next commit. */
export const GIT_STAGE_PATH = '/internal/git/stage';

/** Path of the internal endpoint the API calls to unstage files. */
export const GIT_UNSTAGE_PATH = '/internal/git/unstage';

/** Path of the internal endpoint the API calls to commit the currently staged changes. */
export const GIT_COMMIT_PATH = '/internal/git/commit';

/**
 * Path of the internal endpoint the API calls to attach an existing project to an already-existing
 * remote: a connectivity/authentication preflight against the remote, then the encrypted credential
 * and the project's `GitRepository` link are saved. Synchronous — like `commit`/`status` — because
 * it must run where the real `GitCommandRunner` lives.
 */
export const GIT_CONNECT_PATH = '/internal/git/connect';

/** Path of the internal endpoint the API calls to list a project's local branches. */
export const GIT_BRANCHES_PATH = '/internal/git/branches';

/** Path of the internal endpoint the API calls to create a new local branch. */
export const GIT_BRANCH_CREATE_PATH = '/internal/git/branch-create';

/**
 * Path of the internal endpoint the API calls to complete a project's currently conflicted
 * operation — a re-run merge with a resolving commit for a `PULL`, or a resolved-changes landing
 * with no commit for a `BRANCH_SWITCH`.
 */
export const GIT_PULL_COMPLETE_PATH = '/internal/git/pull/complete';

/** Path of the internal endpoint the API calls to undo a project's most recent pull. */
export const GIT_UNDO_PULL_PATH = '/internal/git/undo-pull';

/** Path of the internal endpoint the API calls to list a project's currently conflicting files. */
export const GIT_CONFLICTS_PATH = '/internal/git/conflicts';

/** Path of the internal endpoint the API calls to read one conflicting file's three-way stages. */
export const GIT_CONFLICT_STAGES_PATH = '/internal/git/conflicts/stages';

/** Path of the internal endpoint the API calls to record one file's conflict resolution. */
export const GIT_CONFLICT_RESOLVE_PATH = '/internal/git/conflicts/resolve';

/** Path of the internal endpoint the API calls to read a project's (or a single file's) commit history. */
export const GIT_HISTORY_PATH = '/internal/git/history';

/** Path of the internal endpoint the API calls to produce a unified diff. */
export const GIT_DIFF_PATH = '/internal/git/diff';

/** Path of the internal endpoint the API calls to read a single file's per-line authorship (blame). */
export const GIT_BLAME_PATH = '/internal/git/blame';

/** Path of the internal endpoint the API calls to discard uncommitted changes, or restore a file from a commit. */
export const GIT_DISCARD_PATH = '/internal/git/discard';

/** Path of the internal endpoint the API calls to amend the project's most-recent commit. */
export const GIT_AMEND_PATH = '/internal/git/amend';

/** Path of the internal endpoint the API calls to preview what a pull would bring in, without applying it. */
export const GIT_PREVIEW_PULL_PATH = '/internal/git/preview-pull';

/** Path of the internal endpoint the API calls to preview what a push would send out, without applying it. */
export const GIT_PREVIEW_PUSH_PATH = '/internal/git/preview-push';

/**
 * Hard cap on the request body. These bodies carry only a project/actor id, a commit message, or a
 * list of workspace-relative file paths — nowhere near the multi-megabyte content payloads the
 * collab edit endpoint handles — so a generous but firmly bounded 1 MiB comfortably covers even a
 * very large changeset's list of paths while still refusing an unbounded upload.
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering (memory cap) and reject, but do NOT destroy the socket here: the handler
        // still needs to write a clean 413 on the shared response. Pausing the unread request lets
        // Node close the connection after that response (the body is never fully consumed).
        request.removeAllListeners('data');
        request.pause();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Dependencies for the internal git-ops request handler. */
export interface GitOpsHandlerDeps {
  /**
   * Reads a project's working-tree git status.
   *
   * @param request - The validated status request.
   * @returns The use case's own `Result`.
   */
  getStatus: (request: GitStatusRequest) => Promise<Result<GetGitStatusResult, DomainError>>;
  /**
   * Compares the current branch to its already-fetched remote-tracking ref.
   *
   * @param request - The validated behind/ahead request (same shape as the status request).
   * @returns The use case's own `Result`.
   */
  getBehindAhead: (request: GitStatusRequest) => Promise<Result<GitBehindAhead, DomainError>>;
  /**
   * Stages the given files.
   *
   * @param request - The validated stage request.
   * @returns The use case's own `Result`.
   */
  stage: (request: StageChangesRequest) => Promise<Result<StageChangesResult, DomainError>>;
  /**
   * Unstages the given files.
   *
   * @param request - The validated unstage request.
   * @returns The use case's own `Result`.
   */
  unstage: (request: StageChangesRequest) => Promise<Result<StageChangesResult, DomainError>>;
  /**
   * Commits the currently staged changes.
   *
   * @param request - The validated commit request.
   * @returns The use case's own `Result`.
   */
  commit: (request: CommitChangesRequest) => Promise<Result<CommitChangesResult, DomainError>>;
  /**
   * Connects a project to an existing remote: a connectivity/authentication preflight, then the
   * encrypted credential and the project's `GitRepository` link are saved.
   *
   * @param request - The validated connect request.
   * @returns The binding's wire-mapped `Result` (`repository` already a plain-object mirror, no
   *   value-object `{_value}` leakage).
   */
  connect: (request: ConnectRequest) => Promise<Result<ConnectRepositoryWireResult, DomainError>>;
  /**
   * Lists a project's local branches and the one currently checked out.
   *
   * @param request - The validated status-shaped request (same fields as a status request).
   * @returns The use case's own `Result`.
   */
  getBranches: (request: GitStatusRequest) => Promise<Result<GetBranchesResult, DomainError>>;
  /**
   * Creates a new branch from the working tree's current branch tip.
   *
   * @param request - The validated branch-create request.
   * @returns The use case's own `Result`.
   */
  createBranch: (request: CreateBranchRequest) => Promise<Result<CreateBranchResult, DomainError>>;
  /**
   * Completes a project's currently conflicted operation (a resolving commit for a `PULL`, or a
   * resolved-changes landing with no commit for a `BRANCH_SWITCH`).
   *
   * @param request - The validated status-shaped request (same fields as a status request).
   * @returns The binding's wire-mapped `Result` (`operationId` already a plain string).
   */
  completePull: (request: GitStatusRequest) => Promise<Result<CompleteMergeWireResult, DomainError>>;
  /**
   * Undoes a project's most recent pull.
   *
   * @param request - The validated status-shaped request (same fields as a status request).
   * @returns The binding's wire-mapped `Result` (`operationId` already a plain string).
   */
  undoPull: (request: GitStatusRequest) => Promise<Result<UndoPullWireResult, DomainError>>;
  /**
   * Lists a project's currently conflicting files.
   *
   * @param request - The validated status-shaped request (same fields as a status request).
   * @returns The binding's wire-mapped `Result` (`operationId` already a plain string).
   */
  listConflicts: (request: GitStatusRequest) => Promise<Result<ListConflictsWireResult, DomainError>>;
  /**
   * Reads one conflicting file's three-way (base/ours/theirs) stages.
   *
   * @param request - The validated conflict-path request.
   * @returns The use case's own `Result`.
   */
  getConflictStages: (request: ConflictPathRequest) => Promise<Result<GetConflictStagesResult, DomainError>>;
  /**
   * Records one file's chosen conflict resolution.
   *
   * @param request - The validated conflict-resolve request.
   * @returns The use case's own `Result`.
   */
  resolveConflict: (request: ResolveConflictRequest) => Promise<Result<ResolveConflictsResult, DomainError>>;
  /**
   * Reads a project's (or a single file's) commit history.
   *
   * @param request - The validated history request.
   * @returns The binding's wire-mapped `Result` (`authorUserId`/`authoredAt` already plain strings).
   */
  getHistory: (request: HistoryRequest) => Promise<Result<GetHistoryWireResult, DomainError>>;
  /**
   * Produces a unified diff for a project: between two commits, or of the uncommitted working
   * changes against HEAD.
   *
   * @param request - The validated diff request.
   * @returns The use case's own `Result` (already a plain `{unified}` string, no mapping needed).
   */
  getDiff: (request: DiffRequest) => Promise<Result<GitDiffResult, DomainError>>;
  /**
   * Reads a single project-relative file's per-line authorship (a "blame").
   *
   * @param request - The validated blame request.
   * @returns The binding's wire-mapped `Result` (`authorUserId`/`authoredAt` already plain strings).
   */
  getBlame: (request: BlameRequest) => Promise<Result<GetBlameWireResult, DomainError>>;
  /**
   * Discards a file's uncommitted working-tree changes, or restores it to a chosen commit.
   *
   * @param request - The validated discard request.
   * @returns The use case's own `Result`.
   */
  discard: (request: DiscardRequest) => Promise<Result<DiscardChangesResult, DomainError>>;
  /**
   * Amends the project's most-recent commit.
   *
   * @param request - The validated amend request.
   * @returns The use case's own `Result`.
   */
  amend: (request: AmendRequest) => Promise<Result<AmendCommitResult, DomainError>>;
  /**
   * Previews what a pull would bring in, without applying it: a live fetch, then the incoming
   * commits and the paths they touch.
   *
   * @param request - The validated preview request.
   * @returns The binding's wire-mapped `Result` (`authorUserId`/`authoredAt` already plain strings).
   */
  previewPull: (request: PreviewRequest) => Promise<Result<PreviewPullWireResult, DomainError>>;
  /**
   * Previews what a push would send out, without applying it: the outgoing commits and the paths
   * they touch, purely local.
   *
   * @param request - The validated preview request.
   * @returns The binding's wire-mapped `Result` (`authorUserId`/`authoredAt` already plain strings).
   */
  previewPush: (request: PreviewRequest) => Promise<Result<PreviewPushWireResult, DomainError>>;
  /** Optional shared secret; when set, requests without a matching header are rejected (401). */
  secret?: string;
  /** Logger for failures. */
  logger: Logger;
}

/**
 * Builds the node HTTP request handler for the internal git short-op endpoints (status,
 * behind-ahead, stage, unstage, commit, connect, branches, branch-create, pull-complete, undo-pull,
 * conflicts, conflict-stages, conflict-resolve). Separated from the server so it can be
 * unit-tested with injected functions.
 *
 * @param deps - The op functions, optional secret, and logger.
 * @returns A node `http` request handler.
 */
export function createGitOpsRequestHandler(
  deps: GitOpsHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    // Authenticate BEFORE matching the path, so a caller without the secret gets 401 for every
    // request. Checking the path first would answer 404 for an unknown path and 401 for a known one,
    // an oracle an unauthenticated caller could use to enumerate which internal endpoints exist.
    if (deps.secret && !secretMatches(request.headers[SECRET_HEADER], deps.secret)) {
      request.resume();
      response.writeHead(401).end();
      return;
    }
    if (
      request.method !== 'POST' ||
      (path !== GIT_STATUS_PATH &&
        path !== GIT_BEHIND_AHEAD_PATH &&
        path !== GIT_STAGE_PATH &&
        path !== GIT_UNSTAGE_PATH &&
        path !== GIT_COMMIT_PATH &&
        path !== GIT_CONNECT_PATH &&
        path !== GIT_BRANCHES_PATH &&
        path !== GIT_BRANCH_CREATE_PATH &&
        path !== GIT_PULL_COMPLETE_PATH &&
        path !== GIT_UNDO_PULL_PATH &&
        path !== GIT_CONFLICTS_PATH &&
        path !== GIT_CONFLICT_STAGES_PATH &&
        path !== GIT_CONFLICT_RESOLVE_PATH &&
        path !== GIT_HISTORY_PATH &&
        path !== GIT_DIFF_PATH &&
        path !== GIT_BLAME_PATH &&
        path !== GIT_DISCARD_PATH &&
        path !== GIT_AMEND_PATH &&
        path !== GIT_PREVIEW_PULL_PATH &&
        path !== GIT_PREVIEW_PUSH_PATH)
    ) {
      request.resume(); // drain any body so the keep-alive connection stays healthy
      response.writeHead(404).end();
      return;
    }

    let raw: string;
    try {
      raw = await readBody(request);
    } catch {
      // Body exceeded the cap (or a read error). The socket is still open (readBody no longer
      // destroys it), so guard against a double-write and respond 413. `connection: close` makes
      // Node close the socket after the response, discarding the unread oversize body rather than
      // leaving it lingering on a reusable keep-alive connection.
      if (!response.headersSent) response.writeHead(413, { connection: 'close' }).end();
      return;
    }

    let call: () => Promise<Result<unknown, DomainError>>;
    let label: string;
    switch (path) {
    case GIT_STATUS_PATH: {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getStatus(parsed);
      label = 'status';

    break;
    }
    case GIT_BEHIND_AHEAD_PATH: {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getBehindAhead(parsed);
      label = 'behind-ahead';

    break;
    }
    case GIT_STAGE_PATH:
    case GIT_UNSTAGE_PATH: {
      const parsed = parseStageChangesBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      const isStage = path === GIT_STAGE_PATH;
      call = () => (isStage ? deps.stage(parsed) : deps.unstage(parsed));
      label = isStage ? 'stage' : 'unstage';

    break;
    }
    case GIT_COMMIT_PATH: {
      const parsed = parseCommitChangesBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.commit(parsed);
      label = 'commit';

    break;
    }
    case GIT_CONNECT_PATH: {
      const parsed = parseConnectBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.connect(parsed);
      label = 'connect';

    break;
    }
    case GIT_BRANCHES_PATH: {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getBranches(parsed);
      label = 'branches';

    break;
    }
    case GIT_BRANCH_CREATE_PATH: {
      const parsed = parseCreateBranchBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.createBranch(parsed);
      label = 'branch-create';

    break;
    }
    case GIT_PULL_COMPLETE_PATH: {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.completePull(parsed);
      label = 'pull-complete';

    break;
    }
    case GIT_UNDO_PULL_PATH: {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.undoPull(parsed);
      label = 'undo-pull';

    break;
    }
    case GIT_CONFLICTS_PATH: {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.listConflicts(parsed);
      label = 'conflicts';

    break;
    }
    case GIT_CONFLICT_STAGES_PATH: {
      const parsed = parseConflictPathBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getConflictStages(parsed);
      label = 'conflict-stages';

    break;
    }
    case GIT_CONFLICT_RESOLVE_PATH: {
      const parsed = parseResolveConflictBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.resolveConflict(parsed);
      label = 'conflict-resolve';

    break;
    }
    case GIT_HISTORY_PATH: {
      const parsed = parseHistoryBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getHistory(parsed);
      label = 'history';

    break;
    }
    case GIT_DIFF_PATH: {
      const parsed = parseDiffBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getDiff(parsed);
      label = 'diff';

    break;
    }
    case GIT_BLAME_PATH: {
      const parsed = parseBlameBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getBlame(parsed);
      label = 'blame';

    break;
    }
    case GIT_DISCARD_PATH: {
      const parsed = parseDiscardBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.discard(parsed);
      label = 'discard';

    break;
    }
    case GIT_AMEND_PATH: {
      const parsed = parseAmendBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.amend(parsed);
      label = 'amend';

    break;
    }
    case GIT_PREVIEW_PULL_PATH: {
      const parsed = parsePreviewPullBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.previewPull(parsed);
      label = 'preview-pull';

    break;
    }
    default: {
      const parsed = parsePreviewPushBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.previewPush(parsed);
      label = 'preview-push';
    }
    }

    try {
      const result = await call();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(toEnvelope(result)));
    } catch (error) {
      deps.logger.error({ err: error }, `${label} failed`);
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `${label} failed` }));
    }
  };
}

/** Inputs needed to start the internal git-ops RPC server. */
export interface InternalGitServerOptions {
  /** Interface to bind to — defaults to loopback for safety. */
  host: string;
  /** Port to listen on. */
  port: number;
  /** Optional shared secret enforced on every request. */
  secret?: string;
  /** Optional server mTLS material; when set, the endpoint requires a valid API client certificate. */
  tls?: { cert: Buffer; key: Buffer; clientCa: Buffer };
  /** Logger. */
  logger: Logger;
  /** Reads a project's working-tree git status. */
  getStatus: GitOpsHandlerDeps['getStatus'];
  /** Compares the current branch to its already-fetched remote-tracking ref. */
  getBehindAhead: GitOpsHandlerDeps['getBehindAhead'];
  /** Stages the given files. */
  stage: GitOpsHandlerDeps['stage'];
  /** Unstages the given files. */
  unstage: GitOpsHandlerDeps['unstage'];
  /** Commits the currently staged changes. */
  commit: GitOpsHandlerDeps['commit'];
  /** Connects a project to an existing remote. */
  connect: GitOpsHandlerDeps['connect'];
  /** Lists a project's local branches and the one currently checked out. */
  getBranches: GitOpsHandlerDeps['getBranches'];
  /** Creates a new branch from the working tree's current branch tip. */
  createBranch: GitOpsHandlerDeps['createBranch'];
  /** Completes a project's currently conflicted operation. */
  completePull: GitOpsHandlerDeps['completePull'];
  /** Undoes a project's most recent pull. */
  undoPull: GitOpsHandlerDeps['undoPull'];
  /** Lists a project's currently conflicting files. */
  listConflicts: GitOpsHandlerDeps['listConflicts'];
  /** Reads one conflicting file's three-way (base/ours/theirs) stages. */
  getConflictStages: GitOpsHandlerDeps['getConflictStages'];
  /** Records one file's chosen conflict resolution. */
  resolveConflict: GitOpsHandlerDeps['resolveConflict'];
  /** Reads a project's (or a single file's) commit history. */
  getHistory: GitOpsHandlerDeps['getHistory'];
  /** Produces a unified diff for a project. */
  getDiff: GitOpsHandlerDeps['getDiff'];
  /** Reads a single project-relative file's per-line authorship (a "blame"). */
  getBlame: GitOpsHandlerDeps['getBlame'];
  /** Discards a file's uncommitted working-tree changes, or restores it to a chosen commit. */
  discard: GitOpsHandlerDeps['discard'];
  /** Amends the project's most-recent commit. */
  amend: GitOpsHandlerDeps['amend'];
  /** Previews what a pull would bring in, without applying it. */
  previewPull: GitOpsHandlerDeps['previewPull'];
  /** Previews what a push would send out, without applying it. */
  previewPush: GitOpsHandlerDeps['previewPush'];
}

/**
 * Starts the internal HTTP server that lets the API run the git short ops (status, behind-ahead,
 * stage, unstage, commit, connect, branches, branch-create, pull-complete, undo-pull, conflicts,
 * conflict-stages, conflict-resolve) worker-side, against the real git adapter. Binds to loopback
 * by default; pair with a shared secret and/or network policy in production. Returns the server so
 * the caller can close it on shutdown.
 *
 * @param options - Bind address, the op fns, optional secret/mTLS, logger.
 * @returns A promise resolving to the listening HTTP(S) server, or rejecting if the bind fails.
 */
export function startInternalGitServer(options: InternalGitServerOptions): Promise<http.Server> {
  const handler = createGitOpsRequestHandler({
    getStatus: options.getStatus,
    getBehindAhead: options.getBehindAhead,
    stage: options.stage,
    unstage: options.unstage,
    commit: options.commit,
    connect: options.connect,
    getBranches: options.getBranches,
    createBranch: options.createBranch,
    completePull: options.completePull,
    undoPull: options.undoPull,
    listConflicts: options.listConflicts,
    getConflictStages: options.getConflictStages,
    resolveConflict: options.resolveConflict,
    getHistory: options.getHistory,
    getDiff: options.getDiff,
    getBlame: options.getBlame,
    discard: options.discard,
    amend: options.amend,
    previewPull: options.previewPull,
    previewPush: options.previewPush,
    ...(options.secret ? { secret: options.secret } : {}),
    logger: options.logger,
  });
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handler(request, response);
  };
  // When mTLS material is provided, require a client certificate signed by the configured CA so the
  // mutation endpoints authenticate the API even off-loopback; otherwise plain HTTP on the bind host.
  const server = options.tls
    ? https.createServer(
        { requestCert: true, rejectUnauthorized: true, cert: options.tls.cert, key: options.tls.key, ca: options.tls.clientCa },
        listener,
      )
    : http.createServer(listener);

  // Resolve once listening, reject on an early bind error (e.g. EADDRINUSE). Without an 'error'
  // listener the event would be thrown as an uncaught exception and crash the whole git-worker
  // process — after other startup already ran — which main()'s catch could not intercept.
  return new Promise<http.Server>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      // After startup, keep logging late errors instead of crashing the process.
      server.on('error', (error) => options.logger.error({ err: error }, 'Git-worker internal RPC server error'));
      options.logger.info({ port: options.port, host: options.host, tls: Boolean(options.tls) }, 'Git-worker internal RPC server listening');
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });
}
