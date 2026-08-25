import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import {
  DomainError,
  LiveContentFlushFailedError,
  type CommitChangesResult,
  type CompleteMergeResult,
  type CreateBranchResult,
  type GetBranchesResult,
  type GetGitStatusResult,
  type GitBehindAhead,
  type Result,
  type StageChangesResult,
  type UndoPullResult,
} from '@asciidocollab/domain';

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

/** Header carrying the optional shared secret. */
const SECRET_HEADER = 'x-git-worker-internal-secret';

/**
 * Hard cap on the request body. These bodies carry only a project/actor id, a commit message, or a
 * list of workspace-relative file paths — nowhere near the multi-megabyte content payloads the
 * collab edit endpoint handles — so a generous but firmly bounded 1 MiB comfortably covers even a
 * very large changeset's list of paths while still refusing an unbounded upload.
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

// Matches the strict UUID v4 format `ProjectId.create`/`UserId.create` themselves require (not the
// looser any-version pattern collab's internal endpoint uses for its ids, which are never turned
// into those value objects) — so a body that clears this check can never fail their construction at
// the composition-root boundary and surface as an unexpected 500 instead of this endpoint's 400.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Constant-time comparison of the request's secret header against the expected secret. Uses
 * `crypto.timingSafeEqual` so a network attacker cannot recover the secret byte-by-byte from
 * comparison timing — the only auth on these endpoints when mTLS is off. The length pre-check is
 * required by `timingSafeEqual` (it throws on differing lengths) and leaks only the secret's length.
 *
 * @param provided - The raw header value (string, array, or undefined for a missing header).
 * @param expected - The configured shared secret.
 * @returns True when the provided secret matches.
 */
function secretMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}

/** The raw (still-string) input for the status endpoint, as parsed from the request body. */
export interface GitStatusRequest {
  /** The project whose working-tree status to read, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
}

/** The raw (still-string) input for the stage/unstage endpoints, as parsed from the request body. */
export interface StageChangesRequest {
  /** The project whose working tree to act on, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** Workspace-relative POSIX paths of the files to stage/unstage. */
  readonly paths: readonly string[];
}

/** The raw (still-string) input for the commit endpoint, as parsed from the request body. */
export interface CommitChangesRequest {
  /** The project whose staged changes to commit, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The commit message. */
  readonly message: string;
}

/** The raw (still-string) input for the branch-create endpoint, as parsed from the request body. */
export interface CreateBranchRequest {
  /** The project to create the branch in, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The new branch's name. */
  readonly name: string;
}

/**
 * Validates and normalises a git-status request body. Returns null on any malformed input —
 * including non-UUID ids.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseGitStatusBody(raw: string): GitStatusRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, actorId } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
  return { projectId, actorId };
}

/**
 * Validates and normalises a stage/unstage request body (both endpoints share the same shape).
 * Returns null on any malformed input — non-UUID ids, or `paths` not an array of strings. An empty
 * `paths` array is accepted here: rejecting an empty stage/unstage set is the use case's own
 * `ValidationError` refusal, not a transport-level shape problem.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseStageChangesBody(raw: string): StageChangesRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, actorId, paths } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
  if (!Array.isArray(paths)) return null;
  const cleanPaths: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string') return null;
    cleanPaths.push(entry);
  }
  return { projectId, actorId, paths: cleanPaths };
}

/**
 * Validates and normalises a commit request body. Returns null on any malformed input — non-UUID
 * ids, or a non-string message. An empty/whitespace message is accepted here: rejecting it is the
 * use case's own `EmptyCommitMessageError` refusal, not a transport-level shape problem.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseCommitChangesBody(raw: string): CommitChangesRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, actorId, message } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
  if (typeof message !== 'string') return null;
  return { projectId, actorId, message };
}

/**
 * Validates and normalises a branch-create request body. Returns null on any malformed input —
 * non-UUID ids, or a non-string name. An empty/whitespace name is accepted here: rejecting it is
 * the use case's own `ValidationError` refusal, not a transport-level shape problem.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseCreateBranchBody(raw: string): CreateBranchRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const { projectId, actorId, name } = json;
  if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
  if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
  if (typeof name !== 'string') return null;
  return { projectId, actorId, name };
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

/**
 * Serializes a use case's `Result` onto the HTTP 200 envelope: a domain refusal is a NORMAL
 * outcome, not an HTTP error — only an unexpected throw (handled by the caller) becomes a 500. Uses
 * the error's stable `name` rather than its message, which may carry internals; the one documented
 * exception is `LiveContentFlushFailedError`, whose `path` field the caller needs to name the
 * offending file and is itself safe (a workspace-relative path, not a message).
 *
 * @param result - The use case's own `Result`.
 * @returns The wire envelope to serialize as the response body.
 */
function toEnvelope(result: Result<unknown, DomainError>): Record<string, unknown> {
  if (result.success) return { ok: true, data: result.value };
  const envelope: Record<string, unknown> = { ok: false, error: result.error.name };
  if (result.error instanceof LiveContentFlushFailedError) {
    envelope.path = result.error.path;
  }
  return envelope;
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
   * @returns The use case's own `Result`.
   */
  completePull: (request: GitStatusRequest) => Promise<Result<CompleteMergeResult, DomainError>>;
  /**
   * Undoes a project's most recent pull.
   *
   * @param request - The validated status-shaped request (same fields as a status request).
   * @returns The use case's own `Result`.
   */
  undoPull: (request: GitStatusRequest) => Promise<Result<UndoPullResult, DomainError>>;
  /** Optional shared secret; when set, requests without a matching header are rejected (401). */
  secret?: string;
  /** Logger for failures. */
  logger: Logger;
}

/**
 * Builds the node HTTP request handler for the internal git short-op endpoints (status,
 * behind-ahead, stage, unstage, commit, branches, branch-create, pull-complete, undo-pull).
 * Separated from the server so it can be unit-tested with injected functions.
 *
 * @param deps - The op functions, optional secret, and logger.
 * @returns A node `http` request handler.
 */
export function createGitOpsRequestHandler(
  deps: GitOpsHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (
      request.method !== 'POST' ||
      (path !== GIT_STATUS_PATH &&
        path !== GIT_BEHIND_AHEAD_PATH &&
        path !== GIT_STAGE_PATH &&
        path !== GIT_UNSTAGE_PATH &&
        path !== GIT_COMMIT_PATH &&
        path !== GIT_BRANCHES_PATH &&
        path !== GIT_BRANCH_CREATE_PATH &&
        path !== GIT_PULL_COMPLETE_PATH &&
        path !== GIT_UNDO_PULL_PATH)
    ) {
      request.resume(); // drain any body so the keep-alive connection stays healthy
      response.writeHead(404).end();
      return;
    }
    if (deps.secret && !secretMatches(request.headers[SECRET_HEADER], deps.secret)) {
      request.resume();
      response.writeHead(401).end();
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
    if (path === GIT_STATUS_PATH) {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getStatus(parsed);
      label = 'status';
    } else if (path === GIT_BEHIND_AHEAD_PATH) {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getBehindAhead(parsed);
      label = 'behind-ahead';
    } else if (path === GIT_STAGE_PATH || path === GIT_UNSTAGE_PATH) {
      const parsed = parseStageChangesBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      const isStage = path === GIT_STAGE_PATH;
      call = () => (isStage ? deps.stage(parsed) : deps.unstage(parsed));
      label = isStage ? 'stage' : 'unstage';
    } else if (path === GIT_COMMIT_PATH) {
      const parsed = parseCommitChangesBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.commit(parsed);
      label = 'commit';
    } else if (path === GIT_BRANCHES_PATH) {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.getBranches(parsed);
      label = 'branches';
    } else if (path === GIT_BRANCH_CREATE_PATH) {
      const parsed = parseCreateBranchBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.createBranch(parsed);
      label = 'branch-create';
    } else if (path === GIT_PULL_COMPLETE_PATH) {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.completePull(parsed);
      label = 'pull-complete';
    } else {
      const parsed = parseGitStatusBody(raw);
      if (!parsed) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid body' }));
        return;
      }
      call = () => deps.undoPull(parsed);
      label = 'undo-pull';
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
  /** Lists a project's local branches and the one currently checked out. */
  getBranches: GitOpsHandlerDeps['getBranches'];
  /** Creates a new branch from the working tree's current branch tip. */
  createBranch: GitOpsHandlerDeps['createBranch'];
  /** Completes a project's currently conflicted operation. */
  completePull: GitOpsHandlerDeps['completePull'];
  /** Undoes a project's most recent pull. */
  undoPull: GitOpsHandlerDeps['undoPull'];
}

/**
 * Starts the internal HTTP server that lets the API run the git short ops (status, behind-ahead,
 * stage, unstage, commit, branches, branch-create, pull-complete, undo-pull) worker-side, against
 * the real git adapter. Binds to loopback by default; pair with a shared secret and/or network
 * policy in production. Returns the server so the caller can close it on shutdown.
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
    getBranches: options.getBranches,
    createBranch: options.createBranch,
    completePull: options.completePull,
    undoPull: options.undoPull,
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
