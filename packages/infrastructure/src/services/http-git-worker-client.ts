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

/**
 * Path of the internal endpoint that attaches an existing project to an already-existing remote: a
 * connectivity/authentication preflight, then the encrypted credential and the project's
 * `GitRepository` link are saved. Byte-matches the git-worker's own `GIT_CONNECT_PATH`
 * (`apps/git-worker/src/internal-git-server.ts`).
 */
export const GIT_WORKER_CONNECT_PATH = '/internal/git/connect';

/** Path of the internal endpoint that lists a project's local branches. */
export const GIT_WORKER_BRANCHES_PATH = '/internal/git/branches';

/** Path of the internal endpoint that creates a new local branch. */
export const GIT_WORKER_BRANCH_CREATE_PATH = '/internal/git/branch-create';

/**
 * Path of the internal endpoint that completes a project's currently conflicted operation (a
 * re-run merge with a resolving commit for a `PULL`, or a resolved-changes landing with no commit
 * for a `BRANCH_SWITCH`). Byte-matches the git-worker's own `GIT_PULL_COMPLETE_PATH`
 * (`apps/git-worker/src/internal-git-server.ts`) — confirmed by reading that file directly.
 */
export const GIT_WORKER_PULL_COMPLETE_PATH = '/internal/git/pull/complete';

/**
 * Path of the internal endpoint that undoes a project's most recent pull. Byte-matches the
 * git-worker's own `GIT_UNDO_PULL_PATH` — confirmed by reading that file directly.
 */
export const GIT_WORKER_UNDO_PULL_PATH = '/internal/git/undo-pull';

/**
 * Path of the internal endpoint that lists a project's currently conflicting files.
 *
 * NOTE: unlike every other path constant in this file, the git-worker's `internal-git-server.ts`
 * does NOT yet register a dispatch branch for this path (nor for
 * {@link GIT_WORKER_CONFLICT_STAGES_PATH} / {@link GIT_WORKER_CONFLICT_RESOLVE_PATH} below) —
 * confirmed by reading that file directly. `ListConflictsUseCase`/`GetConflictStagesUseCase`/
 * `ResolveConflictsUseCase` already exist in `@asciidocollab/domain` but are not yet constructed
 * in the worker's composition root or bound as RPC op fns. A follow-up worker-side task must add
 * matching request parsers + op-fn bindings using these exact path strings and the request-body
 * shapes this client posts (see each method below) before these three routes are functional
 * end-to-end against a real worker.
 */
export const GIT_WORKER_CONFLICTS_PATH = '/internal/git/conflicts';

/** Path of the internal endpoint that reads one conflicting file's three-way stages. See the note on {@link GIT_WORKER_CONFLICTS_PATH}. */
export const GIT_WORKER_CONFLICT_STAGES_PATH = '/internal/git/conflicts/stages';

/** Path of the internal endpoint that records one file's conflict resolution. See the note on {@link GIT_WORKER_CONFLICTS_PATH}. */
export const GIT_WORKER_CONFLICT_RESOLVE_PATH = '/internal/git/conflicts/resolve';

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
  /** This branch's ("ours") content. Empty for a binary conflict. */
  readonly ours: string;
  /** The incoming branch's ("theirs") content. Empty for a binary conflict. */
  readonly theirs: string;
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
  /**
   * Attaches an existing project to an already-existing remote: a connectivity/authentication
   * preflight against the remote, then the encrypted credential and the project's `GitRepository`
   * link are saved. Synchronous — no clone, no push.
   */
  connect(input: GitWorkerConnectInput): Promise<GitWorkerResult<GitWorkerConnectData>>;
  /** Lists a project's local branches and the one currently checked out. */
  getBranches(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerBranchListData>>;
  /** Creates a new branch from the working tree's current branch tip. */
  createBranch(input: GitWorkerCreateBranchInput): Promise<GitWorkerResult<GitWorkerCreatedBranchData>>;
  /** Lists a project's currently conflicting files. */
  listConflicts(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerConflictListData>>;
  /** Reads one conflicting file's three-way (base/ours/theirs) stages. */
  getConflictStages(input: GitWorkerConflictPathInput): Promise<GitWorkerResult<GitWorkerConflictStagesData>>;
  /** Records one file's chosen conflict resolution. */
  resolveConflict(input: GitWorkerResolveConflictInput): Promise<GitWorkerResult<GitWorkerResolveConflictData>>;
  /** Completes a project's currently conflicted operation (a resolving commit for a `PULL`, or a resolved-changes landing with no commit for a `BRANCH_SWITCH`). */
  completePull(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerCompleteMergeData>>;
  /** Undoes a project's most recent pull. */
  undoPull(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerUndoPullData>>;
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

  async connect(input: GitWorkerConnectInput): Promise<GitWorkerResult<GitWorkerConnectData>> {
    return this.post<GitWorkerConnectData>(GIT_WORKER_CONNECT_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      provider: input.provider,
      remoteUrl: input.remoteUrl,
      token: input.token,
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    });
  }

  async getBranches(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerBranchListData>> {
    return this.post<GitWorkerBranchListData>(GIT_WORKER_BRANCHES_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
    });
  }

  async createBranch(input: GitWorkerCreateBranchInput): Promise<GitWorkerResult<GitWorkerCreatedBranchData>> {
    return this.post<GitWorkerCreatedBranchData>(GIT_WORKER_BRANCH_CREATE_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      name: input.name,
    });
  }

  async listConflicts(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerConflictListData>> {
    return this.post<GitWorkerConflictListData>(GIT_WORKER_CONFLICTS_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
    });
  }

  async getConflictStages(input: GitWorkerConflictPathInput): Promise<GitWorkerResult<GitWorkerConflictStagesData>> {
    return this.post<GitWorkerConflictStagesData>(GIT_WORKER_CONFLICT_STAGES_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      path: input.path,
    });
  }

  async resolveConflict(input: GitWorkerResolveConflictInput): Promise<GitWorkerResult<GitWorkerResolveConflictData>> {
    return this.post<GitWorkerResolveConflictData>(GIT_WORKER_CONFLICT_RESOLVE_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      path: input.path,
      resolution: input.resolution,
      ...(input.mergedContent !== undefined ? { mergedContent: input.mergedContent } : {}),
    });
  }

  async completePull(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerCompleteMergeData>> {
    return this.post<GitWorkerCompleteMergeData>(GIT_WORKER_PULL_COMPLETE_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
    });
  }

  async undoPull(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerUndoPullData>> {
    return this.post<GitWorkerUndoPullData>(GIT_WORKER_UNDO_PULL_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
    });
  }
}
