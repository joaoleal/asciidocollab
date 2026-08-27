/**
 * @file Named audit action-type identifiers for events added by the audit-log
 * coverage feature (025). Centralized so new actions are not magic strings.
 * Existing inline action strings (e.g. 'project.created') are left in place.
 */

// Authentication & account events
export const AUDIT_AUTH_SIGNED_IN = 'auth.signed_in';
export const AUDIT_AUTH_SIGNED_OUT = 'auth.signed_out';
export const AUDIT_AUTH_REGISTERED = 'auth.registered';
export const AUDIT_AUTH_PASSWORD_CHANGED = 'auth.password_changed';
export const AUDIT_AUTH_PASSWORD_RESET = 'auth.password_reset';
export const AUDIT_AUTH_EMAIL_CHANGED = 'auth.email_changed';

// File & folder lifecycle events
export const AUDIT_FILE_CREATED = 'file.created';
export const AUDIT_FOLDER_CREATED = 'folder.created';
export const AUDIT_FILE_UPLOADED = 'file.uploaded';
export const AUDIT_FILE_MOVED = 'file.moved';
export const AUDIT_FILE_RENAMED = 'file.renamed';
export const AUDIT_SYMBOL_RENAMED = 'symbol.renamed';
export const AUDIT_PROJECT_CONTENT_REPLACED = 'project.content_replaced';
export const AUDIT_PROJECT_RENDER_CONFIG_UPDATED = 'project.render_config_updated';
export const AUDIT_DICTIONARY_TERM_ADDED = 'grammar.dictionary_term_added';
export const AUDIT_DICTIONARY_TERM_REMOVED = 'grammar.dictionary_term_removed';
export const AUDIT_GRAMMAR_SETTINGS_UPDATED = 'grammar.settings_updated';

// Project cloning events
export const AUDIT_PROJECT_CLONED = 'project.cloned';
export const AUDIT_PROJECT_CLONE_REQUESTED = 'project.clone_requested';

// Authorization events
export const AUDIT_AUTHZ_DENIED = 'authz.denied';

// Review comment & task events (feature 038)
export const AUDIT_REVIEW_ITEM_CREATED = 'review.item_created';
export const AUDIT_REVIEW_EDITED = 'review.edited';
export const AUDIT_REVIEW_REPLIED = 'review.replied';
export const AUDIT_REVIEW_RESOLVED = 'review.resolved';
export const AUDIT_REVIEW_REOPENED = 'review.reopened';
export const AUDIT_REVIEW_CONVERTED = 'review.converted';
export const AUDIT_REVIEW_ASSIGNED = 'review.assigned';
export const AUDIT_REVIEW_STATUS_CHANGED = 'review.status_changed';
export const AUDIT_REVIEW_REANCHORED = 'review.reanchored';
export const AUDIT_REVIEW_ITEM_DELETED = 'review.item_deleted';
export const AUDIT_REVIEW_DOCUMENT_CLEARED = 'review.document_cleared';
export const AUDIT_REVIEW_PROJECT_CLEARED = 'review.project_cleared';

// Git operation terminal outcomes, recorded by the git-worker run loop
export const AUDIT_GIT_OPERATION_SUCCEEDED = 'git.operation_succeeded';
export const AUDIT_GIT_OPERATION_FAILED = 'git.operation_failed';
export const AUDIT_GIT_OPERATION_ABORTED = 'git.operation_aborted';

// Git repository connection lifecycle
export const AUDIT_GIT_REPOSITORY_CONNECTED = 'git.repository_connected';
export const AUDIT_GIT_REPOSITORY_DISCONNECTED = 'git.repository_disconnected';

// Per-file conflict resolution
export const AUDIT_GIT_CONFLICT_RESOLVED = 'git.conflict_resolved';

// Completing (all conflicts resolved) or undoing a conflicted/clean pull
export const AUDIT_GIT_CONFLICTS_RESOLVED = 'git.conflicts_resolved';
export const AUDIT_GIT_PULL_UNDONE = 'git.pull_undone';

// A clean pull landed, but the reconciler hit drift it had to auto-repair or (folder-occupied path)
// drop — recorded so the user, who has no log access, can see which paths were affected and recover.
export const AUDIT_GIT_PULL_PARTIALLY_APPLIED = 'git.pull_partially_applied';

// The same drift surfaced while landing a clean branch switch's change-set (the switch counterpart to
// `git.pull_partially_applied`), recorded only when the reconciler reported at least one anomaly.
export const AUDIT_GIT_BRANCH_SWITCH_PARTIALLY_APPLIED = 'git.branch_switch_partially_applied';

// Project-level maintainer-editable git-ignore patterns
export const AUDIT_PROJECT_GIT_IGNORE_PATTERNS_UPDATED = 'project.git_ignore_patterns_updated';

// Short, synchronous mutating git actions (commit/amend/discard/stage/branch/credential)
export const AUDIT_GIT_CHANGES_COMMITTED = 'git.changes_committed';
export const AUDIT_GIT_COMMIT_AMENDED = 'git.commit_amended';
export const AUDIT_GIT_CHANGES_DISCARDED = 'git.changes_discarded';
export const AUDIT_GIT_CHANGES_STAGED = 'git.changes_staged';
export const AUDIT_GIT_CHANGES_UNSTAGED = 'git.changes_unstaged';
export const AUDIT_GIT_BRANCH_CREATED = 'git.branch_created';
export const AUDIT_GIT_CREDENTIAL_ROTATED = 'git.credential_rotated';
