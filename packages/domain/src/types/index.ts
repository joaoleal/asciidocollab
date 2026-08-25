/** @file Barrel re-exports for domain types. */
export type { Result } from './result';
export type { SearchQuery, SearchMode, ReplaceSelection, PositionalEdit } from './search';
export type { RegistrationMethod } from './registration-method';
export type { RequestContext } from './request-context';
export type { GitOperationKind } from './git-operation-kind';
export type { GitOperationState } from './git-operation-state';
export { ACTIVE_GIT_OPERATION_STATES, TERMINAL_GIT_OPERATION_STATES } from './git-operation-state';
export type { GitSyncStatus } from './git-sync-status';
export { DEFAULT_GIT_SYNC_STATUS } from './git-sync-status';
export type { ConflictResolution } from './conflict-resolution';
// AsciiDoc structural DTOs — cross-boundary type contracts (re-exported type-only by shared).
export type {
  TextRange,
  Reference,
  ProjectSymbol,
  Diagnostic,
  ConditionalExpr,
  IncludeEdge,
  ResolvedAttributeScope,
  DocumentOrderEvent,
  UnresolvedInclude,
  DocumentTree,
  MainFileClearedOutcome,
} from './asciidoc';
