/**
 * A restricted, non-`eval` conditional expression parsed from an `ifdef`/`ifndef`/`ifeval`
 * preprocessor directive (Constitution IX — no `eval`/`Function`). Evaluated against a
 * resolved attribute scope to decide whether the guarded content (or include) is active.
 */
export interface ConditionalExpr {
  /** The directive kind. */
  kind: 'ifdef' | 'ifndef' | 'ifeval';
  /** Attribute names for `ifdef`/`ifndef` (supports `,`/`+` operators); empty for `ifeval`. */
  attrs: string[];
  /**
   * How a multi-attribute `ifdef`/`ifndef` list combines: `'or'` (the `,` separator — any) or
   * `'and'` (the `+` separator — all). Absent for a single attribute or for `ifeval`. AsciiDoc does
   * not allow mixing the two separators in one directive, so a single combinator applies.
   */
  op?: 'and' | 'or';
  /** Restricted `ifeval` comparison (`lhs op rhs`), or `null` for `ifdef`/`ifndef`. */
  expr: { lhs: string; op: string; rhs: string } | null;
}

// The AsciiDoc structural DTO shapes the extraction engine produces and both the server
// (`@asciidocollab/domain`) and editor (`apps/web`) consume. They live here — beside the extraction
// engine and alongside `ConditionalExpr` — so the single source of truth owns its own contracts;
// `@asciidocollab/domain`'s `types/asciidoc` and `@asciidocollab/shared` re-export them unchanged.

/** A half-open text range within a file (document offsets). */
export interface TextRange {
  /** Start offset (inclusive). */
  from: number;
  /** End offset (exclusive). */
  to: number;
}

/** A reference from one file to a symbol/file/path elsewhere. */
export interface Reference {
  /** What kind of reference this is. */
  kind: 'xref' | 'include' | 'image' | 'attributeRef';
  /** The referenced symbol id, file path, or attribute name. */
  target: string;
  /** The file containing the reference. */
  fileId: string;
  /** The reference's location within its file. */
  range: TextRange;
}

/** A definable, referenceable symbol within the project. */
export interface ProjectSymbol {
  /** The kind of symbol. */
  kind: 'section' | 'anchor' | 'attribute';
  /** Section/anchor id or attribute name. */
  name: string;
  /** The file that defines the symbol. */
  fileId: string;
  /** The symbol definition's location. */
  range: TextRange;
}

/** An `include::` edge between two files in the include graph. */
export interface IncludeEdge {
  /** The including file. */
  from: string;
  /** The included file. */
  to: string;
  /** Location of the `include::` directive in the including file. */
  includeDirectiveRange: TextRange;
  /** Level offset declared on the include directive (`leveloffset=`), 0 if none. */
  leveloffset: number;
  /** Tag filter expression tokens from `tags=` (`null`/absent = no tag filter). */
  tags?: string[] | null;
  /** Line ranges from `lines=`; each `[start, end]` with an open-ended end as `null` (`null`/absent = no line filter). */
  lines?: Array<[number, number | null]> | null;
  /** Conditional guarding this include, when the directive is wrapped by one (`null`/absent = unconditional). */
  gatedBy?: ConditionalExpr | null;
}

/**
 * The effective attribute values at a position, or for a file's inherited context,
 * derived by walking the include tree from the project main file (root).
 */
export interface ResolvedAttributeScope {
  /** The file this scope applies to. */
  fileId: string;
  /** Attribute name → value in effect. */
  values: ReadonlyMap<string, string>;
  /**
   * How the scope was derived: `root` = the main file itself; `inherited` = from the
   * main file at this file's first-include point; `standalone` = no main file
   * configured, so only the file's own attributes resolve.
   */
  origin: 'root' | 'inherited' | 'standalone';
}

/**
 * An event in document reading order used to resolve attribute state across the include
 * tree. `attribute` covers `:name:` entries (and `:!name:` unset via `value: null`);
 * `inline-set` covers `{set:name:value}` / `{set:name!}`; `include` carries the matched
 * `include::` directive for expansion.
 */
export type DocumentOrderEvent =
  | { kind: 'attribute'; pos: number; name: string; value: string | null; locked?: boolean }
  | { kind: 'inline-set'; pos: number; name: string; value: string | null }
  | { kind: 'include'; pos: number; match: RegExpMatchArray };

/** An include target that could not be resolved (drives the unresolved-include diagnostic). */
export interface UnresolvedInclude {
  /** The file containing the unresolved include. */
  fromFile: string;
  /** The raw include target. */
  target: string;
  /** Location of the directive. */
  range: TextRange;
}

/**
 * A validation finding produced over the document tree.
 *
 * Owned here rather than in `@asciidocollab/domain` because BOTH sides produce these independently
 * over the same structural model — the server when it validates a project, and the editor when it
 * lints the open buffer (`apps/web/src/lib/codemirror/asciidoc-diagnostics.ts`) — and every `code`
 * below names a rule this package defines. It previously lived in the domain and reached the editor
 * through a `shared` re-export, which pointed `shared` UP at the domain for one type.
 */
export interface Diagnostic {
  /** Finding severity. */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable message. */
  message: string;
  /** Location of the finding. */
  range: TextRange;
  /** Machine-readable code. */
  code:
    | 'unterminated-block'
    | 'unknown-xref'
    | 'duplicate-id'
    | 'undefined-attribute'
    | 'unresolved-include';
}

/** The transitive include graph rooted at a main (or current) file. */
export interface DocumentTree {
  /** The root file (the configured main file, or the open file when none). */
  rootFileId: string;
  /** All files reachable via transitive `include::`. */
  nodes: string[];
  /** Include relationships. */
  edges: IncludeEdge[];
  /** Includes that could not be resolved. */
  unresolved: UnresolvedInclude[];
}
