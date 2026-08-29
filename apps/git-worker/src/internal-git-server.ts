import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import {
  DomainError,
  type AmendCommitResult,
  type CommitChangesResult,
  type CreateBranchResult,
  type DiscardChangesResult,
  type GetBranchesResult,
  type GetConflictStagesResult,
  type GetGitStatusResult,
  type GitBehindAhead,
  type GitDiffResult,
  type ResolveConflictsResult,
  type Result,
  type StageChangesResult,
} from '@asciidocollab/domain';
import { SECRET_HEADER, secretMatches } from './internal-git-server/auth.js';
import { toEnvelope } from './internal-git-server/envelope.js';
import { isKnownGitOpsPath, dispatchGitOpsRequest } from './internal-git-server/dispatch.js';
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
import type {
  ConnectRepositoryWireResult,
  CompleteMergeWireResult,
  UndoPullWireResult,
  ListConflictsWireResult,
  GetHistoryWireResult,
  PreviewPullWireResult,
  PreviewPushWireResult,
  GetBlameWireResult,
} from './internal-git-wire.js';

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

// Re-exported so every existing import site (the composition root, `git-wire-mappers.ts`, and this
// app's tests) can keep resolving these wire-DTO shapes from this module, even though the type
// definitions themselves now live in the co-located `internal-git-wire.ts`.
export type {
  GitRepositoryWireData,
  ConnectRepositoryWireResult,
  CompleteMergeWireResult,
  UndoPullWireResult,
  ListConflictsWireResult,
  HistoryWireCommit,
  GetHistoryWireResult,
  PreviewPullWireResult,
  PreviewPushWireResult,
  BlameWireLine,
  GetBlameWireResult,
} from './internal-git-wire.js';

// Re-exported so every existing import site (this app's tests, and any future caller) can keep
// resolving these path constants from this module, even though they now live beside the dispatch
// table that maps each one to its parser/op/label — see `internal-git-server/dispatch.ts`.
export {
  GIT_STATUS_PATH,
  GIT_BEHIND_AHEAD_PATH,
  GIT_STAGE_PATH,
  GIT_UNSTAGE_PATH,
  GIT_COMMIT_PATH,
  GIT_CONNECT_PATH,
  GIT_BRANCHES_PATH,
  GIT_BRANCH_CREATE_PATH,
  GIT_PULL_COMPLETE_PATH,
  GIT_UNDO_PULL_PATH,
  GIT_CONFLICTS_PATH,
  GIT_CONFLICT_STAGES_PATH,
  GIT_CONFLICT_RESOLVE_PATH,
  GIT_HISTORY_PATH,
  GIT_DIFF_PATH,
  GIT_BLAME_PATH,
  GIT_DISCARD_PATH,
  GIT_AMEND_PATH,
  GIT_PREVIEW_PULL_PATH,
  GIT_PREVIEW_PUSH_PATH,
} from './internal-git-server/paths.js';

/**
 * Hard cap on the request body. These bodies carry only a project/actor id, a commit message, or a
 * list of workspace-relative file paths — nowhere near the multi-megabyte content payloads the
 * collab edit endpoint handles — so a generous but firmly bounded 1 MiB comfortably covers even a
 * very large changeset's list of paths while still refusing an unbounded upload.
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

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
    if (request.method !== 'POST' || !isKnownGitOpsPath(path)) {
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

    // The dispatch table (`internal-git-server/dispatch.ts`) parses `raw` with the matched
    // endpoint's own parser and, on success, wires it to the matching `deps` op fn — the one shared
    // driver a 20-arm switch used to duplicate per endpoint.
    const outcome = dispatchGitOpsRequest(path, raw, deps);
    if (outcome === null) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
      return;
    }
    const { call, label } = outcome;

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
