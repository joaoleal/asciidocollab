/**
 * AsciiDoc reference/symbol extraction + include-graph — the single source of truth used by BOTH the
 * server (`@asciidocollab/domain`, for find-references and move/rename rewriting) and the in-browser
 * editor (`apps/web`, over the live unsaved buffer). Consolidated into this zero-dependency leaf so the
 * two can never drift apart (no more hand-kept mirror).
 *
 * This barrel is the module's public surface, re-exported from the package root (`@asciidocollab/
 * asciidoc-core`). The implementation is split by concern into sibling files (grammar, text-ranges,
 * headings, document-order, level-offset, include-graph, attribute-scope, references,
 * include-selectors); import from the package root, not from the parts. The document-order attribute
 * engine (`document-order` + `attribute-scope`) is the single line-aware authority for attribute scope
 * (`resolveAttributeScope`, `resolveAttributeReferences`). `parseConditional` / `evaluateConditional`
 * are exported directly from the package root (the conditional-regions authority).
 */

export { realHeadingOffsets, headingToId } from './headings';
export { LEVELOFFSET_ENTRY_RE, VERBATIM_FENCE_RE } from './grammar';
// The verbatim/comment region scanner. Exported because "which characters are a code sample" is the
// same question for the editor's prose extraction as for reference/attribute extraction, and the
// grammar cannot answer it: a delimited block's body is modelled as flat raw lines, so a listing
// NESTED in an example/sidebar/quote block produces no node of its own.
export { verbatimRanges } from './text-ranges';
export {
  parseIncludeLevelOffset,
  hasIncludeLevelOffsetOption,
  applyLevelOffsetEntry,
  inheritedLevelOffset,
  effectiveLevelOffset,
  tracePersistedLevelOffset,
} from './level-offset';
export { applyLineAttributes, attributeEntryLineRanges } from './document-order';
export { extractReferences, extractSymbols, resolveReference, definitionSymbols } from './references';
export {
  extractAttributeDefinitions,
  extractOwnAttributes,
  resolveAttributeReferences,
  resolveAttributeScope,
  type ResolvedAttributeReference,
} from './attribute-scope';
export {
  buildIncludeGraph,
  buildIncludeGraphWithInheritance,
  type IncludeGraphResult,
} from './include-graph';
export { parseIncludeTags, parseIncludeLines } from './include-selectors';
