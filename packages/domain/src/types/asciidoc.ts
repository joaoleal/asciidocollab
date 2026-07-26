/**
 * Cross-boundary AsciiDoc structural shapes. The extraction-engine DTO contracts
 * (TextRange / Reference / ProjectSymbol / Diagnostic / IncludeEdge / ResolvedAttributeScope /
 * DocumentOrderEvent / UnresolvedInclude / DocumentTree / ConditionalExpr) are defined in the
 * zero-dependency `@asciidocollab/asciidoc-core` leaf — beside the extraction engine that produces
 * them — and re-exported here so the domain's cross-boundary type surface is unchanged. The
 * domain-only DTO (`MainFileClearedOutcome`) is defined below.
 */
export type {
  ConditionalExpr,
  TextRange,
  Reference,
  ProjectSymbol,
  Diagnostic,
  IncludeEdge,
  ResolvedAttributeScope,
  DocumentOrderEvent,
  UnresolvedInclude,
  DocumentTree,
} from '@asciidocollab/asciidoc-core';

/**
 * Typed outcome returned by move/rename when the project's configured main file
 * is cleared (rename-to-non-adoc / delete) — a shared DTO, not an ad-hoc signal
 * The client uses it to inform the user.
 */
export interface MainFileClearedOutcome {
  /** True when `Project.mainFileNodeId` was cleared by the operation. */
  mainFileCleared: boolean;
}
