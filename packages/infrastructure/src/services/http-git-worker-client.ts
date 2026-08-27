import { createMtlsFetch } from './mtls-fetch';
import { GitWorkerTransportError, parseEnvelope, type GitWorkerResult } from './git-worker-envelope';
import type {
  GitWorkerRequestInput,
  GitWorkerStageInput,
  GitWorkerCommitInput,
  GitWorkerConnectInput,
  GitWorkerCreateBranchInput,
  GitWorkerConflictPathInput,
  GitWorkerResolveConflictInput,
  GitWorkerHistoryInput,
  GitWorkerDiffInput,
  GitWorkerBlameInput,
  GitWorkerDiscardInput,
  GitWorkerAmendInput,
  GitWorkerPreviewInput,
  GitWorkerStatusData,
  GitWorkerBehindAheadData,
  GitWorkerStageData,
  GitWorkerCommitData,
  GitWorkerConnectData,
  GitWorkerBranchListData,
  GitWorkerCreatedBranchData,
  GitWorkerConflictListData,
  GitWorkerConflictStagesData,
  GitWorkerResolveConflictData,
  GitWorkerCompleteMergeData,
  GitWorkerUndoPullData,
  GitWorkerHistoryData,
  GitWorkerDiffData,
  GitWorkerBlameData,
  GitWorkerDiscardData,
  GitWorkerPreviewPullData,
  GitWorkerPreviewPushData,
} from './git-worker-wire-types';

// Re-export the transport envelope and the wire-DTO vocabulary this client posts and reads, so
// importers that reference them from this module keep resolving after the split.
export { GitWorkerTransportError, type GitWorkerResult } from './git-worker-envelope';
export type {
  GitWorkerChangeType,
  GitWorkerChangeState,
  GitWorkerSyncStatus,
  GitWorkerPendingChange,
  GitWorkerStatusData,
  GitWorkerBehindAheadData,
  GitWorkerStageData,
  GitWorkerCommitData,
  GitWorkerRepositoryData,
  GitWorkerConnectData,
  GitWorkerBranchListData,
  GitWorkerCreatedBranchData,
  GitWorkerConflictSummaryData,
  GitWorkerConflictListData,
  GitWorkerConflictStagesData,
  GitWorkerResolveConflictData,
  GitWorkerCompleteMergeData,
  GitWorkerUndoPullData,
  GitWorkerHistoryCommit,
  GitWorkerHistoryData,
  GitWorkerDiffData,
  GitWorkerBlameLine,
  GitWorkerBlameData,
  GitWorkerDiscardData,
  GitWorkerPreviewCommit,
  GitWorkerPreviewPullData,
  GitWorkerPreviewPushData,
  GitWorkerRequestInput,
  GitWorkerStageInput,
  GitWorkerCommitInput,
  GitWorkerConnectInput,
  GitWorkerCreateBranchInput,
  GitWorkerConflictPathInput,
  GitWorkerResolveConflictInput,
  GitWorkerHistoryInput,
  GitWorkerDiffInput,
  GitWorkerBlameInput,
  GitWorkerDiscardInput,
  GitWorkerAmendInput,
  GitWorkerPreviewInput,
} from './git-worker-wire-types';

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

/** Path of the internal endpoint that reads a project's (or a single file's) commit history. Byte-matches the git-worker's own `GIT_HISTORY_PATH`. */
export const GIT_WORKER_HISTORY_PATH = '/internal/git/history';

/** Path of the internal endpoint that produces a unified diff. Byte-matches the git-worker's own `GIT_DIFF_PATH`. */
export const GIT_WORKER_DIFF_PATH = '/internal/git/diff';

/** Path of the internal endpoint that reads a single file's per-line authorship (blame). Byte-matches the git-worker's own `GIT_BLAME_PATH`. */
export const GIT_WORKER_BLAME_PATH = '/internal/git/blame';

/** Path of the internal endpoint that discards uncommitted changes, or restores a file from a commit. Byte-matches the git-worker's own `GIT_DISCARD_PATH`. */
export const GIT_WORKER_DISCARD_PATH = '/internal/git/discard';

/** Path of the internal endpoint that amends the project's most-recent commit. Byte-matches the git-worker's own `GIT_AMEND_PATH`. */
export const GIT_WORKER_AMEND_PATH = '/internal/git/amend';

/** Path of the internal endpoint that previews what a pull would bring in, without applying it. Byte-matches the git-worker's own `GIT_PREVIEW_PULL_PATH`. */
export const GIT_WORKER_PREVIEW_PULL_PATH = '/internal/git/preview-pull';

/** Path of the internal endpoint that previews what a push would send out, without applying it. Byte-matches the git-worker's own `GIT_PREVIEW_PUSH_PATH`. */
export const GIT_WORKER_PREVIEW_PUSH_PATH = '/internal/git/preview-push';

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
 * Transport-only client interface for the git-worker's synchronous internal RPC endpoints (status,
 * behind-ahead, stage, unstage, commit). Defined so routes can be exercised against a fake in
 * tests without an HTTP dependency.
 */
export interface GitWorkerClient {
  /**
   * Reads a project's working-tree git status.
   *
   * @param input - The project/actor to read status for.
   * @returns The worker's result envelope, carrying the git status on success.
   */
  getStatus(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerStatusData>>;
  /**
   * Compares the current branch to its already-fetched remote-tracking ref.
   *
   * @param input - The project/actor to compare.
   * @returns The worker's result envelope, carrying the behind/ahead counts on success.
   */
  getBehindAhead(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerBehindAheadData>>;
  /**
   * Stages the given files for the next commit.
   *
   * @param input - The project/actor and the paths to stage.
   * @returns The worker's result envelope, carrying the updated stage data on success.
   */
  stageChanges(input: GitWorkerStageInput): Promise<GitWorkerResult<GitWorkerStageData>>;
  /**
   * Unstages the given files.
   *
   * @param input - The project/actor and the paths to unstage.
   * @returns The worker's result envelope, carrying the updated stage data on success.
   */
  unstageChanges(input: GitWorkerStageInput): Promise<GitWorkerResult<GitWorkerStageData>>;
  /**
   * Commits the currently staged changes.
   *
   * @param input - The project/actor and the commit message.
   * @returns The worker's result envelope, carrying the new commit on success.
   */
  commitChanges(input: GitWorkerCommitInput): Promise<GitWorkerResult<GitWorkerCommitData>>;
  /**
   * Attaches an existing project to an already-existing remote: a connectivity/authentication
   * preflight against the remote, then the encrypted credential and the project's `GitRepository`
   * link are saved. Synchronous — no clone, no push.
   *
   * @param input - The project/actor, the remote to attach, and its credential.
   * @returns The worker's result envelope, carrying the connected repository on success.
   */
  connect(input: GitWorkerConnectInput): Promise<GitWorkerResult<GitWorkerConnectData>>;
  /**
   * Lists a project's local branches and the one currently checked out.
   *
   * @param input - The project/actor to list branches for.
   * @returns The worker's result envelope, carrying the branch list on success.
   */
  getBranches(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerBranchListData>>;
  /**
   * Creates a new branch from the working tree's current branch tip.
   *
   * @param input - The project/actor and the new branch's name.
   * @returns The worker's result envelope, carrying the created branch on success.
   */
  createBranch(input: GitWorkerCreateBranchInput): Promise<GitWorkerResult<GitWorkerCreatedBranchData>>;
  /**
   * Lists a project's currently conflicting files.
   *
   * @param input - The project/actor to list conflicts for.
   * @returns The worker's result envelope, carrying the conflict list on success.
   */
  listConflicts(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerConflictListData>>;
  /**
   * Reads one conflicting file's three-way (base/ours/theirs) stages.
   *
   * @param input - The project/actor and the conflicting file's path.
   * @returns The worker's result envelope, carrying the file's three-way stages on success.
   */
  getConflictStages(input: GitWorkerConflictPathInput): Promise<GitWorkerResult<GitWorkerConflictStagesData>>;
  /**
   * Records one file's chosen conflict resolution.
   *
   * @param input - The project/actor, the file, and its chosen resolution.
   * @returns The worker's result envelope, carrying the recorded resolution on success.
   */
  resolveConflict(input: GitWorkerResolveConflictInput): Promise<GitWorkerResult<GitWorkerResolveConflictData>>;
  /**
   * Completes a project's currently conflicted operation (a resolving commit for a `PULL`, or a resolved-changes landing with no commit for a `BRANCH_SWITCH`).
   *
   * @param input - The project/actor whose conflicted operation to complete.
   * @returns The worker's result envelope, carrying the completed merge outcome on success.
   */
  completePull(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerCompleteMergeData>>;
  /**
   * Undoes a project's most recent pull.
   *
   * @param input - The project/actor to undo the pull for.
   * @returns The worker's result envelope, carrying the undo outcome on success.
   */
  undoPull(input: GitWorkerRequestInput): Promise<GitWorkerResult<GitWorkerUndoPullData>>;
  /**
   * Reads a project's (or a single file's) commit history.
   *
   * @param input - The project/actor, and the optional path/limit to scope the history.
   * @returns The worker's result envelope, carrying the commit history on success.
   */
  getHistory(input: GitWorkerHistoryInput): Promise<GitWorkerResult<GitWorkerHistoryData>>;
  /**
   * Produces a unified diff for a project: between two commits, or of the uncommitted working changes against HEAD.
   *
   * @param input - The project/actor and the commit range (or working-tree diff request).
   * @returns The worker's result envelope, carrying the unified diff on success.
   */
  getDiff(input: GitWorkerDiffInput): Promise<GitWorkerResult<GitWorkerDiffData>>;
  /**
   * Reads a single project-relative file's per-line authorship (a "blame").
   *
   * @param input - The project/actor and the file to blame.
   * @returns The worker's result envelope, carrying the per-line blame on success.
   */
  getBlame(input: GitWorkerBlameInput): Promise<GitWorkerResult<GitWorkerBlameData>>;
  /**
   * Discards a file's uncommitted working-tree changes, or restores it to a chosen commit.
   *
   * @param input - The project/actor, the file, and the optional commit to restore from.
   * @returns The worker's result envelope, carrying the discard outcome on success.
   */
  discardChanges(input: GitWorkerDiscardInput): Promise<GitWorkerResult<GitWorkerDiscardData>>;
  /**
   * Amends the project's most-recent commit.
   *
   * @param input - The project/actor and the optional replacement commit message.
   * @returns The worker's result envelope, carrying the amended commit on success.
   */
  amendCommit(input: GitWorkerAmendInput): Promise<GitWorkerResult<GitWorkerCommitData>>;
  /**
   * Previews what a pull would bring in, without applying it: a live fetch, then the incoming commits and the paths they touch.
   *
   * @param input - The project/actor and the optional branch to preview.
   * @returns The worker's result envelope, carrying the incoming commits/paths on success.
   */
  previewPull(input: GitWorkerPreviewInput): Promise<GitWorkerResult<GitWorkerPreviewPullData>>;
  /**
   * Previews what a push would send out, without applying it: the outgoing commits and the paths they touch, purely local.
   *
   * @param input - The project/actor and the optional branch to preview.
   * @returns The worker's result envelope, carrying the outgoing commits/paths on success.
   */
  previewPush(input: GitWorkerPreviewInput): Promise<GitWorkerResult<GitWorkerPreviewPushData>>;
}

/**
 * {@link GitWorkerClient} implementation that delegates to the git-worker's internal HTTP server.
 * The worker owns the project's git working tree, so it is the only process that can run these
 * short git operations; this adapter is the api-side client that asks it to. Transport-only — it
 * carries no business logic, and speaks its own wire-level `data` types (declared in
 * `./git-worker-wire-types`) rather than importing domain result types.
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
      ...(input.branch === undefined ? {} : { branch: input.branch }),
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
      ...(input.mergedContent === undefined ? {} : { mergedContent: input.mergedContent }),
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

  async getHistory(input: GitWorkerHistoryInput): Promise<GitWorkerResult<GitWorkerHistoryData>> {
    return this.post<GitWorkerHistoryData>(GIT_WORKER_HISTORY_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  async getDiff(input: GitWorkerDiffInput): Promise<GitWorkerResult<GitWorkerDiffData>> {
    return this.post<GitWorkerDiffData>(GIT_WORKER_DIFF_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
  }

  async getBlame(input: GitWorkerBlameInput): Promise<GitWorkerResult<GitWorkerBlameData>> {
    return this.post<GitWorkerBlameData>(GIT_WORKER_BLAME_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      path: input.path,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
    });
  }

  async discardChanges(input: GitWorkerDiscardInput): Promise<GitWorkerResult<GitWorkerDiscardData>> {
    return this.post<GitWorkerDiscardData>(GIT_WORKER_DISCARD_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      paths: input.paths,
      ...(input.fromCommit === undefined ? {} : { fromCommit: input.fromCommit }),
    });
  }

  async amendCommit(input: GitWorkerAmendInput): Promise<GitWorkerResult<GitWorkerCommitData>> {
    return this.post<GitWorkerCommitData>(GIT_WORKER_AMEND_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      ...(input.message === undefined ? {} : { message: input.message }),
    });
  }

  async previewPull(input: GitWorkerPreviewInput): Promise<GitWorkerResult<GitWorkerPreviewPullData>> {
    return this.post<GitWorkerPreviewPullData>(GIT_WORKER_PREVIEW_PULL_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
    });
  }

  async previewPush(input: GitWorkerPreviewInput): Promise<GitWorkerResult<GitWorkerPreviewPushData>> {
    return this.post<GitWorkerPreviewPushData>(GIT_WORKER_PREVIEW_PUSH_PATH, {
      projectId: input.projectId,
      actorId: input.actorId,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
    });
  }
}
