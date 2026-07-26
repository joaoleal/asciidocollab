/**
 * @file `@asciidocollab/asciidoc-core` — the zero-dependency single source of truth for the AsciiDoc
 * preprocessor + structural rules that BOTH the server (`@asciidocollab/domain`) and the in-browser
 * editor (`apps/web`) must apply identically: conditional-region gating, `{ref}` attribute
 * substitution, the reference/symbol/include-graph EXTRACTION engine, and the shared structural types.
 * Living in a leaf package both sides import is what keeps the editor and the server from drifting
 * apart (the mirror they previously maintained by hand).
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
} from './types';
export { substitutePathAttributes } from './attribute-substitution';
export { isValidNewName, type RenamableSymbolKind } from './name-validation';
export { isThemeFilePath, resolveThemePath, themeFilePaths, THEME_FILENAME_CONVENTION } from './theme-file';
export {
  ENDIF_LINE_RE,
  CONDITIONAL_REGION_OPENER_RE,
  INCLUDE_LINE_RE,
  parseConditional,
  evaluateConditional,
  conditionalLineKind,
  ConditionalRegionStack,
} from './conditional-regions';
// The reference/symbol/include-graph extraction engine (its own barrel + concern sub-modules).
export * from './extraction';
// The environment-agnostic include-assembly primitive (I/O + sandbox path policy injected) shared by
// every rendering path so include semantics never drift between them.
export * from './assembly';
// The PDF converter-extension shape + ordering rule. Here rather than in `shared` because the
// renderer is bundled into a Web Worker and may not pull the domain ring in for a few interfaces;
// `shared` re-exports these alongside the manifest validation that needs a schema library.
export {
  orderPdfExtensions,
  compareExtensionIds,
  type PdfExtensionOrigin,
  type PdfExtensionManifest,
  type PdfExtensionThemeKey,
  type PdfExtensionThemeValueKind,
  type PdfExtensionCatalogueEntry,
} from './pdf-extensions';
