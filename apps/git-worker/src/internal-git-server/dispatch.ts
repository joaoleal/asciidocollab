import type { DomainError, Result } from '@asciidocollab/domain';
import type { GitOpsHandlerDeps } from '../internal-git-server.js';
import {
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
} from './paths.js';
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
} from './request-parsers.js';

/** One dispatched request's resolved op-fn call and failure-log label, once its body has parsed. */
export interface DispatchOutcome {
  /** Invokes the matched op fn with the already-parsed, already-typed request. */
  readonly call: () => Promise<Result<unknown, DomainError>>;
  /** Short name for the failure log line if `call()` rejects. */
  readonly label: string;
}

/** Resolves one endpoint's dispatch outcome from a raw body, or null if the body fails to parse. */
type RouteResolver = (raw: string, deps: GitOpsHandlerDeps) => DispatchOutcome | null;

/**
 * Builds one dispatch-table entry: parses the raw body with `parse`, and — only once parsing
 * succeeds — wraps `op` (closed over the matching `deps` function) as `call`. Generic over each
 * endpoint's own parsed-request shape, so every entry keeps its exact parser and op wiring while
 * still fitting the same homogeneous table below.
 *
 * @param parse - The endpoint's own request-body parser.
 * @param op - The `deps` function this endpoint dispatches a successfully parsed request to.
 * @param label - The failure-log label to report if `op` rejects.
 * @returns A resolver ready for the dispatch table.
 */
function route<T>(
  parse: (raw: string) => T | null,
  op: (deps: GitOpsHandlerDeps, parsed: T) => Promise<Result<unknown, DomainError>>,
  label: string,
): RouteResolver {
  return (raw, deps) => {
    const parsed = parse(raw);
    if (parsed === null) return null;
    return { call: () => op(deps, parsed), label };
  };
}

/**
 * Maps every internal git-ops path to its parser, op-fn wiring, and failure-log label — replacing
 * a 20-arm switch that copy-pasted the same parse/validate/dispatch block per endpoint. The 400
 * response shape, status codes, labels, and every endpoint's behavior stay exactly as each `route`
 * call below wires them; `dispatchGitOpsRequest` is the one shared driver that walks this table.
 */
const DISPATCH_TABLE: Readonly<Record<string, RouteResolver>> = {
  [GIT_STATUS_PATH]: route(parseGitStatusBody, (deps, parsed) => deps.getStatus(parsed), 'status'),
  [GIT_BEHIND_AHEAD_PATH]: route(parseGitStatusBody, (deps, parsed) => deps.getBehindAhead(parsed), 'behind-ahead'),
  [GIT_STAGE_PATH]: route(parseStageChangesBody, (deps, parsed) => deps.stage(parsed), 'stage'),
  [GIT_UNSTAGE_PATH]: route(parseStageChangesBody, (deps, parsed) => deps.unstage(parsed), 'unstage'),
  [GIT_COMMIT_PATH]: route(parseCommitChangesBody, (deps, parsed) => deps.commit(parsed), 'commit'),
  [GIT_CONNECT_PATH]: route(parseConnectBody, (deps, parsed) => deps.connect(parsed), 'connect'),
  [GIT_BRANCHES_PATH]: route(parseGitStatusBody, (deps, parsed) => deps.getBranches(parsed), 'branches'),
  [GIT_BRANCH_CREATE_PATH]: route(parseCreateBranchBody, (deps, parsed) => deps.createBranch(parsed), 'branch-create'),
  [GIT_PULL_COMPLETE_PATH]: route(parseGitStatusBody, (deps, parsed) => deps.completePull(parsed), 'pull-complete'),
  [GIT_UNDO_PULL_PATH]: route(parseGitStatusBody, (deps, parsed) => deps.undoPull(parsed), 'undo-pull'),
  [GIT_CONFLICTS_PATH]: route(parseGitStatusBody, (deps, parsed) => deps.listConflicts(parsed), 'conflicts'),
  [GIT_CONFLICT_STAGES_PATH]: route(parseConflictPathBody, (deps, parsed) => deps.getConflictStages(parsed), 'conflict-stages'),
  [GIT_CONFLICT_RESOLVE_PATH]: route(parseResolveConflictBody, (deps, parsed) => deps.resolveConflict(parsed), 'conflict-resolve'),
  [GIT_HISTORY_PATH]: route(parseHistoryBody, (deps, parsed) => deps.getHistory(parsed), 'history'),
  [GIT_DIFF_PATH]: route(parseDiffBody, (deps, parsed) => deps.getDiff(parsed), 'diff'),
  [GIT_BLAME_PATH]: route(parseBlameBody, (deps, parsed) => deps.getBlame(parsed), 'blame'),
  [GIT_DISCARD_PATH]: route(parseDiscardBody, (deps, parsed) => deps.discard(parsed), 'discard'),
  [GIT_AMEND_PATH]: route(parseAmendBody, (deps, parsed) => deps.amend(parsed), 'amend'),
  [GIT_PREVIEW_PULL_PATH]: route(parsePreviewPullBody, (deps, parsed) => deps.previewPull(parsed), 'preview-pull'),
  [GIT_PREVIEW_PUSH_PATH]: route(parsePreviewPushBody, (deps, parsed) => deps.previewPush(parsed), 'preview-push'),
};

/**
 * Reports whether `path` is one of the internal git-ops endpoints, independent of the request
 * body. The handler checks this (together with the method) before reading the body, so an unknown
 * path still answers 404 without buffering a request whose body it will never parse.
 *
 * @param path - The request's path, with any query string already stripped.
 * @returns True if `path` matches a registered endpoint.
 */
export function isKnownGitOpsPath(path: string): boolean {
  return Object.hasOwn(DISPATCH_TABLE, path);
}

/**
 * Resolves the matched endpoint's op-fn call for an already-known path: parses `raw` with that
 * endpoint's own parser, and on success wraps the matching `deps` op fn as `call`. The handler
 * treats a null return as the shared 400 `{error: 'Invalid body'}` response; an unmatched `path`
 * likewise returns null, though the handler's own `isKnownGitOpsPath` gate means that never
 * happens in practice.
 *
 * @param path - The request's path, with any query string already stripped.
 * @param raw - The request's raw (not yet parsed) body.
 * @param deps - The op fns to dispatch a successfully parsed request to.
 * @returns The resolved call and label, or null if the body failed to parse (or the path is unmatched).
 */
export function dispatchGitOpsRequest(path: string, raw: string, deps: GitOpsHandlerDeps): DispatchOutcome | null {
  // `Object.hasOwn` guards against a bracket lookup resolving an inherited `Object.prototype`
  // member (`toString`, `valueOf`, ...) as if it were a registered resolver — defense-in-depth,
  // since every caller already gates on `isKnownGitOpsPath` (which uses the same guard) plus the
  // internal secret auth before this ever runs.
  if (!Object.hasOwn(DISPATCH_TABLE, path)) return null;
  const resolve = DISPATCH_TABLE[path];
  return resolve === undefined ? null : resolve(raw, deps);
}
