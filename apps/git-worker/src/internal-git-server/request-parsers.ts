import type { ConflictResolution } from '@asciidocollab/domain';

// Matches the strict UUID v4 format `ProjectId.create`/`UserId.create` themselves require (not the
// looser any-version pattern collab's internal endpoint uses for its ids, which are never turned
// into those value objects) — so a body that clears this check can never fail their construction at
// the composition-root boundary and surface as an unexpected 500 instead of this endpoint's 400.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The parse/guard skeleton every `parse*Body` function shares: parse the raw JSON, reject anything
 * that is not a JSON object, then hand the object to the endpoint's own `validate` for its
 * field-specific checks. Returns null on unparseable JSON, on a non-object body, or whenever
 * `validate` itself returns null — the single "malformed input" signal these parsers all use.
 *
 * @param raw - The raw JSON request body.
 * @param validate - The endpoint's field-specific check, run on the parsed object.
 * @returns The validated request, or null if invalid.
 */
function parseBody<T>(raw: string, validate: (record: Record<string, unknown>) => T | null): T | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  return validate(json);
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

/** The raw (still-string) input for the connect endpoint, as parsed from the request body. */
export interface ConnectRequest {
  /** The project to connect, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The git hosting provider, e.g. `'github'`, `'gitlab'`, or `'bitbucket'`. */
  readonly provider: string;
  /** The remote repository's URL. */
  readonly remoteUrl: string;
  /** The plaintext access token to authenticate with. Never logged, echoed, or persisted as-is. */
  readonly token: string;
  /** The branch to check out initially. Defaults to `'main'` when omitted. */
  readonly branch?: string;
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

/** The raw (still-string) input for the conflict-stages endpoint, as parsed from the request body. */
export interface ConflictPathRequest {
  /** The project whose awaiting conflict to read from, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The conflicting file's path. */
  readonly path: string;
}

/** The raw (still-string) input for the conflict-resolve endpoint, as parsed from the request body. */
export interface ResolveConflictRequest {
  /** The project whose awaiting conflict this resolves a file for, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The conflicting file's path. */
  readonly path: string;
  /** The chosen resolution for this file. */
  readonly resolution: ConflictResolution;
  /** The user-edited merged content; present iff {@link resolution} is `'merged'`. */
  readonly mergedContent?: string;
}

/** The raw (still-string) input for the history endpoint, as parsed from the request body. */
export interface HistoryRequest {
  /** The project whose history to read, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** When given, restricts the history to the commits that touched this single project-relative file. */
  readonly path?: string;
  /** When given, caps the number of commits returned. */
  readonly limit?: number;
}

/** The raw (still-string) input for the diff endpoint, as parsed from the request body. */
export interface DiffRequest {
  /** The project whose repository to diff, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** When given, scopes the diff to this single project-relative file (whole tree when absent). */
  readonly path?: string;
  /** The earlier commit hash. Given together with `to` to diff between two commits. */
  readonly from?: string;
  /** The later commit hash. Given together with `from` to diff between two commits. */
  readonly to?: string;
}

/** The raw (still-string) input for the blame endpoint, as parsed from the request body. */
export interface BlameRequest {
  /** The project whose file to blame, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The project-relative path of the file to blame. */
  readonly path: string;
  /** When given, blames the file as of this commit; without it, the current working-tree file. */
  readonly ref?: string;
}

/** The raw (still-string) input for the discard endpoint, as parsed from the request body. */
export interface DiscardRequest {
  /** The project whose working tree to restore, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** Project-relative paths of the files to restore. */
  readonly paths: readonly string[];
  /** When given, restores each path to its content at this commit instead of dropping back to HEAD. */
  readonly fromCommit?: string;
}

/** The raw (still-string) input for the amend endpoint, as parsed from the request body. */
export interface AmendRequest {
  /** The project whose most-recent commit to amend, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The replacement commit message. When absent, the amended commit keeps its existing message. */
  readonly message?: string;
}

/**
 * The raw (still-string) input shared by the pull-preview and push-preview endpoints, as parsed
 * from the request body — both take the identical shape.
 */
export interface PreviewRequest {
  /** The project whose preview to compute, as a raw UUID string. */
  readonly projectId: string;
  /** The API's authenticated principal, as a raw UUID string. */
  readonly actorId: string;
  /** The branch to preview. Defaults to the project's current branch when omitted. */
  readonly branch?: string;
}

/**
 * Validates and normalises a git-status request body. Returns null on any malformed input —
 * including non-UUID ids.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseGitStatusBody(raw: string): GitStatusRequest | null {
  return parseBody(raw, ({ projectId, actorId }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    return { projectId, actorId };
  });
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
  return parseBody(raw, ({ projectId, actorId, paths }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (!Array.isArray(paths)) return null;
    const cleanPaths: string[] = [];
    for (const entry of paths) {
      if (typeof entry !== 'string') return null;
      cleanPaths.push(entry);
    }
    return { projectId, actorId, paths: cleanPaths };
  });
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
  return parseBody(raw, ({ projectId, actorId, message }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (typeof message !== 'string') return null;
    return { projectId, actorId, message };
  });
}

/**
 * Validates and normalises a connect request body. Returns null on any malformed input — non-UUID
 * ids, or a non-string/empty `provider`, `remoteUrl`, or `token`. Unlike the commit message/branch
 * name, these are rejected here rather than left to the use case: they name the shape of the
 * request itself (which remote, with which provider/credential), not a value the use case's own
 * domain rules judge. `branch`, like the other endpoints' optional fields, may be omitted or must
 * be a string when present.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseConnectBody(raw: string): ConnectRequest | null {
  return parseBody(raw, ({ projectId, actorId, provider, remoteUrl, token, branch }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (typeof provider !== 'string' || provider.length === 0) return null;
    if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) return null;
    if (typeof token !== 'string' || token.length === 0) return null;
    if (branch !== undefined && typeof branch !== 'string') return null;
    return { projectId, actorId, provider, remoteUrl, token, ...(branch === undefined ? {} : { branch }) };
  });
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
  return parseBody(raw, ({ projectId, actorId, name }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (typeof name !== 'string') return null;
    return { projectId, actorId, name };
  });
}

/** Narrows a request body's `resolution` string to the `ConflictResolution` values it may carry. */
function isConflictResolution(value: string): value is ConflictResolution {
  return value === 'ours' || value === 'theirs' || value === 'merged';
}

/**
 * Validates and normalises a conflict-stages request body. Returns null on any malformed input —
 * non-UUID ids, or a non-string path.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseConflictPathBody(raw: string): ConflictPathRequest | null {
  return parseBody(raw, ({ projectId, actorId, path }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (typeof path !== 'string') return null;
    return { projectId, actorId, path };
  });
}

/**
 * Validates and normalises a conflict-resolve request body. Returns null on any malformed input —
 * non-UUID ids, a non-string path, a `resolution` outside `'ours' | 'theirs' | 'merged'`, or a
 * `mergedContent` that is present but not a string. `mergedContent` is legitimately absent (not
 * merely `undefined`) for a non-`'merged'` resolution — the client omits it from the JSON body
 * entirely — so this only rejects it when present with the wrong type.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseResolveConflictBody(raw: string): ResolveConflictRequest | null {
  return parseBody(raw, ({ projectId, actorId, path, resolution, mergedContent }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (typeof path !== 'string') return null;
    if (typeof resolution !== 'string' || !isConflictResolution(resolution)) return null;
    if (mergedContent !== undefined && typeof mergedContent !== 'string') return null;
    return {
      projectId,
      actorId,
      path,
      resolution,
      ...(mergedContent === undefined ? {} : { mergedContent }),
    };
  });
}

/**
 * Validates and normalises a history request body. Returns null on any malformed input — non-UUID
 * ids, a non-string `path` when present, or a `limit` that is present but not a non-negative finite
 * number (rejecting it here, rather than leaving it to the use case, since it names the shape of
 * the request itself).
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseHistoryBody(raw: string): HistoryRequest | null {
  return parseBody(raw, ({ projectId, actorId, path, limit }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (path !== undefined && typeof path !== 'string') return null;
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) return null;
    return {
      projectId,
      actorId,
      ...(path === undefined ? {} : { path }),
      ...(limit === undefined ? {} : { limit }),
    };
  });
}

/**
 * Validates and normalises a diff request body. Returns null on any malformed input — non-UUID
 * ids, or a non-string `path`/`from`/`to` when present.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseDiffBody(raw: string): DiffRequest | null {
  return parseBody(raw, ({ projectId, actorId, path, from, to }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (path !== undefined && typeof path !== 'string') return null;
    if (from !== undefined && typeof from !== 'string') return null;
    if (to !== undefined && typeof to !== 'string') return null;
    return {
      projectId,
      actorId,
      ...(path === undefined ? {} : { path }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  });
}

/**
 * Validates and normalises a blame request body. Returns null on any malformed input — non-UUID
 * ids, a missing/empty/non-string `path` (required — blame always names a single file), or a
 * non-string `ref` when present.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseBlameBody(raw: string): BlameRequest | null {
  return parseBody(raw, ({ projectId, actorId, path, ref }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (typeof path !== 'string' || path.length === 0) return null;
    if (ref !== undefined && typeof ref !== 'string') return null;
    return { projectId, actorId, path, ...(ref === undefined ? {} : { ref }) };
  });
}

/**
 * Validates and normalises a discard request body. Returns null on any malformed input — non-UUID
 * ids, a non-array `paths` or a non-string entry within it, or a non-string `fromCommit` when
 * present. An empty `paths` array is accepted here (mirroring `parseStageChangesBody`): rejecting
 * an empty restore set is the route boundary's own dual-body validation, not a transport-level
 * shape problem.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseDiscardBody(raw: string): DiscardRequest | null {
  return parseBody(raw, ({ projectId, actorId, paths, fromCommit }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (!Array.isArray(paths)) return null;
    const cleanPaths: string[] = [];
    for (const entry of paths) {
      if (typeof entry !== 'string') return null;
      cleanPaths.push(entry);
    }
    if (fromCommit !== undefined && typeof fromCommit !== 'string') return null;
    return { projectId, actorId, paths: cleanPaths, ...(fromCommit === undefined ? {} : { fromCommit }) };
  });
}

/**
 * Validates and normalises an amend request body. Returns null on any malformed input — non-UUID
 * ids, or a non-string `message` when present. An empty/whitespace message is accepted here: rejecting
 * it is the use case's own `EmptyCommitMessageError` refusal, not a transport-level shape problem.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parseAmendBody(raw: string): AmendRequest | null {
  return parseBody(raw, ({ projectId, actorId, message }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (message !== undefined && typeof message !== 'string') return null;
    return { projectId, actorId, ...(message === undefined ? {} : { message }) };
  });
}

/**
 * Validates and normalises a pull/push preview request body. Returns null on any malformed input —
 * non-UUID ids, or a non-string `branch` when present. Shared implementation for
 * {@link parsePreviewPullBody}/{@link parsePreviewPushBody}, which take the identical shape.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
function parsePreviewBody(raw: string): PreviewRequest | null {
  return parseBody(raw, ({ projectId, actorId, branch }) => {
    if (typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) return null;
    if (typeof actorId !== 'string' || !UUID_REGEX.test(actorId)) return null;
    if (branch !== undefined && typeof branch !== 'string') return null;
    return { projectId, actorId, ...(branch === undefined ? {} : { branch }) };
  });
}

/**
 * Validates and normalises a pull-preview request body. See {@link parsePreviewBody}.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parsePreviewPullBody(raw: string): PreviewRequest | null {
  return parsePreviewBody(raw);
}

/**
 * Validates and normalises a push-preview request body. See {@link parsePreviewBody}.
 *
 * @param raw - The raw JSON request body.
 * @returns The parsed request, or null if invalid.
 */
export function parsePreviewPushBody(raw: string): PreviewRequest | null {
  return parsePreviewBody(raw);
}
