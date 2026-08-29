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
