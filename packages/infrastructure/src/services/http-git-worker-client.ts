import { createMtlsFetch } from './mtls-fetch';

/** Path of the internal endpoint that reads a project's working-tree git status. */
export const GIT_WORKER_STATUS_PATH = '/internal/git/status';

/** Path of the internal endpoint that compares the current branch to its remote. */
export const GIT_WORKER_BEHIND_AHEAD_PATH = '/internal/git/behind-ahead';

/** Path of the internal endpoint that stages files for the next commit. */
export const GIT_WORKER_STAGE_PATH = '/internal/git/stage';

/** Path of the internal endpoint that unstages files. */
export const GIT_WORKER_UNSTAGE_PATH = '/internal/git/unstage';

/** Path of the internal endpoint that commits the currently staged changes. */
export const GIT_WORKER_COMMIT_PATH = '/internal/git/commit';

/** Header carrying the shared secret expected by the git-worker's internal endpoints. */
const SECRET_HEADER = 'x-git-worker-internal-secret';

// Strip trailing '/' characters. Linear-time (no regex) to keep it ReDoS-free; equivalent to
// `s.replace(/\/+$/, '')`.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/** Configuration for the HTTP git-worker client adapter. */
export interface HttpGitWorkerClientConfig {
  /** Base URL of the git-worker's internal HTTP endpoint (e.g., `http://127.0.0.1:4010`). */
  baseUrl: string;
  /** Optional shared secret sent as `x-git-worker-internal-secret` (defense-in-depth on the loopback path). */
  secret?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Client mTLS material; when set (and no explicit `fetch`), requests present this client certificate. */
  tls?: { cert: Buffer; key: Buffer; ca: Buffer };
  /** Injectable fetch (overrides `tls`); defaults to an mTLS fetch when `tls` is set, else the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * A NON-domain failure of the transport itself: a non-200 HTTP response (401 bad/missing secret,
 * 400 malformed body, 413 oversize, 500 unexpected worker error), a network/timeout error, or a
 * response body that does not parse as the expected `{ok, ...}` envelope. Distinct from a domain
 * refusal — which the worker reports as a 200 response with `{ok:false, error}` and which this
 * client instead RETURNS (never throws) as a `GitWorkerResult`. A caller can therefore tell the two
 * apart by whether the call threw at all: catch this type for a transport problem, otherwise read
 * `.ok` on the resolved `GitWorkerResult` for the worker's own (or absence of) a domain refusal.
 *
 * The message never includes the configured secret.
 */
export class GitWorkerTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GitWorkerTransportError';
  }
}

/** The kind of working-tree change a pending change represents, as reported over the wire. */
export type GitWorkerChangeType = 'added' | 'modified' | 'removed' | 'renamed' | 'copied';

/** Where a pending change currently stands in the working tree/index, as reported over the wire. */
export type GitWorkerChangeState = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

/** A repository's synchronisation standing relative to its remote, as reported over the wire. */
export type GitWorkerSyncStatus = 'UP_TO_DATE' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'CONFLICTED' | 'DISCONNECTED';

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

/**
 * The worker's own response envelope, reflected as-is: a domain success carries `data`; a domain
 * refusal carries the domain error's stable `name` (plus `path` for a `LiveContentFlushFailedError`).
 * This is NOT thrown — a domain refusal is a normal outcome the caller inspects via `.ok`. Contrast
 * with {@link GitWorkerTransportError}, which IS thrown, for a transport-level failure.
 */
export type GitWorkerResult<T> = { ok: true; data: T } | { ok: false; error: string; path?: string };

/**
 * Transport-only client interface for the git-worker's synchronous internal RPC endpoints (status,
 * behind-ahead, stage, unstage, commit). Defined so routes can be exercised against a fake in
 * tests without an HTTP dependency.
 */
export interface GitWorkerClient {
  /** Reads a project's working-tree git status. */
  getStatus(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerStatusData>>;
  /** Compares the current branch to its already-fetched remote-tracking ref. */
  getBehindAhead(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerBehindAheadData>>;
  /** Stages the given files for the next commit. */
  stageChanges(input: GitWorkerStageInput): Promise<GitWorkerResult<GitWorkerStageData>>;
  /** Unstages the given files. */
  unstageChanges(input: GitWorkerStageInput): Promise<GitWorkerResult<GitWorkerStageData>>;
  /** Commits the currently staged changes. */
  commitChanges(input: GitWorkerCommitInput): Promise<GitWorkerResult<GitWorkerCommitData>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses a worker response body as the `{ok, ...}` envelope. Throws {@link GitWorkerTransportError}
 * when the body does not match the expected shape — that is a transport-level problem (the worker
 * is supposed to only ever return this shape on a 200), not a domain refusal.
 *
 * @param body - The parsed JSON response body.
 * @returns The typed envelope.
 */
function parseEnvelope<T>(body: unknown): GitWorkerResult<T> {
  if (!isRecord(body) || typeof body.ok !== 'boolean') {
    throw new GitWorkerTransportError('git-worker response was not a recognised envelope');
  }
  if (body.ok) {
    return { ok: true, data: body.data as T };
  }
  if (typeof body.error !== 'string') {
    throw new GitWorkerTransportError('git-worker response was not a recognised envelope');
  }
  const result: GitWorkerResult<T> = { ok: false, error: body.error };
  if (typeof body.path === 'string') return { ...result, path: body.path };
  return result;
}

/**
 * {@link GitWorkerClient} implementation that delegates to the git-worker's internal HTTP server.
 * The worker owns the project's git working tree, so it is the only process that can run these
 * short git operations; this adapter is the api-side client that asks it to. Transport-only — it
 * carries no business logic, and defines its own wire-level `data` types rather than importing
 * domain result types.
 */
export class HttpGitWorkerClient implements GitWorkerClient {
  private readonly fetchImpl: typeof globalThis.fetch;

  /** @param config - Base URL, optional secret/timeout, and either mTLS material or an injected fetch. */
  constructor(private readonly config: HttpGitWorkerClientConfig) {
    this.fetchImpl =
      config.fetch ?? (config.tls ? createMtlsFetch(config.tls.cert, config.tls.key, config.tls.ca) : globalThis.fetch);
  }

  /**
   * POSTs a JSON body to an internal git-worker endpoint with the shared secret header and timeout,
   * and parses the response envelope. Centralised so every method builds the request — and applies
   * the auth secret — identically.
   *
   * @param path - The endpoint path.
   * @param body - The JSON-serialisable request body.
   * @returns The parsed `{ok, ...}` envelope.
   * @throws {GitWorkerTransportError} On a non-200 response, a fetch/timeout error, or a body that
   *   does not parse as JSON or does not match the envelope shape. Never includes the secret.
   */
  private async post<T>(path: string, body: unknown): Promise<GitWorkerResult<T>> {
    const url = `${stripTrailingSlashes(this.config.baseUrl)}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.secret) headers[SECRET_HEADER] = this.config.secret;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitWorkerTransportError(`git-worker request to ${path} failed: ${message}`, { cause: error });
    }

    if (!response.ok) {
      throw new GitWorkerTransportError(`git-worker request to ${path} failed with status ${response.status}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GitWorkerTransportError(`git-worker response from ${path} was not valid JSON: ${message}`);
    }

    return parseEnvelope<T>(json);
  }

  async getStatus(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerStatusData>> {
    return this.post<GitWorkerStatusData>(GIT_WORKER_STATUS_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
    });
  }

  async getBehindAhead(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerBehindAheadData>> {
    return this.post<GitWorkerBehindAheadData>(GIT_WORKER_BEHIND_AHEAD_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
    });
  }

  async stageChanges(input: GitWorkerStageInput): Promise<GitWorkerResult<GitWorkerStageData>> {
    return this.post<GitWorkerStageData>(GIT_WORKER_STAGE_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      paths: input.paths,
    });
  }

  async unstageChanges(input: GitWorkerStageInput): Promise<GitWorkerResult<GitWorkerStageData>> {
    return this.post<GitWorkerStageData>(GIT_WORKER_UNSTAGE_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      paths: input.paths,
    });
  }

  async commitChanges(input: GitWorkerCommitInput): Promise<GitWorkerResult<GitWorkerCommitData>> {
    return this.post<GitWorkerCommitData>(GIT_WORKER_COMMIT_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      message: input.message,
    });
  }
}
