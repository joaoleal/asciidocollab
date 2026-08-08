/** @file Barrel re-exports for domain types. */
export type { Result } from './result';
export type { SearchQuery, SearchMode, ReplaceSelection, PositionalEdit } from './search';
export type { RegistrationMethod } from './registration-method';
export type { RequestContext } from './request-context';
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
