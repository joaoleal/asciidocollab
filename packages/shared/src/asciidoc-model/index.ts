/**
 * @file AsciiDoc structural DTO contracts, re-exported type-only as the cross-boundary contract.
 *
 * These come straight from the zero-dependency `@asciidocollab/asciidoc-core` leaf that DEFINES them,
 * beside the extraction engine that produces them. They used to be re-exported from
 * `@asciidocollab/domain` — which itself re-exports the very same declarations from asciidoc-core — so
 * the extra hop bought nothing and pointed `shared` UP at the domain, inverting the layering and
 * making every consumer of `@asciidocollab/shared` (the browser bundle included) pull the domain in
 * behind it.
 *
 * `MainFileClearedOutcome` is deliberately NOT re-exported here. It is a domain-owned outcome DTO with
 * no consumer outside the domain, so carrying it through this barrel only re-created that inversion
 * for a type nobody reads across the boundary. No logic lives in this package.
 */
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
} from '@asciidocollab/asciidoc-core';
