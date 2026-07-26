/**
 * Port: pre-expand a project's `include::` tree into a single sandbox-confined document.
 *
 * The PDF pipeline must inline every in-project include before the document reaches the Ruby VM, so the
 * VM sees one local file. That assembly logic — tag/line/leveloffset filters, conditional include-gating,
 * cycle and fan-out guards — is shared with the HTML preview, so this package consumes it through this
 * narrow contract instead of owning a second copy. The concrete assembler is supplied at the worker
 * composition root (it wraps the shared assembly primitive with the app's sandbox boundary); the
 * pipeline stage programs only against this interface.
 *
 * Everything the assembler needs is passed in: the root path, a file reader, and the sandbox
 * path-resolution policy. No I/O or path policy is hard-coded here, which keeps the engine
 * environment-agnostic and unit-testable with in-memory fakes — and keeps this package free of any
 * dependency on the web app.
 */

/** Reads a project-relative path's content, or null if the path is unavailable. */
export type ProjectFileReader = (path: string) => string | null;

/** Discriminated result of resolving a sandbox-confined include target. */
export type SandboxResolution =
  | {
      /** Resolution succeeded. */
      readonly ok: true;
      /** Normalized, project-relative path that is safe to read. */
      readonly path: string;
    }
  | {
      /** Resolution was rejected; the target is never read. */
      readonly ok: false;
      /** Why the target was rejected (e.g. `absolute`, `remote`, `traversal`, `empty`, `invalid`). */
      readonly reason: string;
    };

/**
 * Resolves an include target (referenced from a project-relative file) into a sandbox-confined
 * project-relative path, or rejects it. Supplied by the composition root so the engine never encodes a
 * concrete path policy of its own.
 */
export type SandboxPathResolver = (fromPath: string, target: string) => SandboxResolution;

/** A directive that could not be assembled, with the reason it was rejected or could not be resolved. */
export interface UnresolvedInclude {
  /** The project-relative path of the file containing the directive. */
  readonly from: string;
  /** The raw include target. */
  readonly target: string;
  /**
   * Why it was not assembled: a sandbox rejection reason (e.g. `remote`, `absolute`, `traversal`), or
   * `not-found` / `cycle` / `depth` / `limit`.
   */
  readonly reason: string;
}

/** Bounds and attribute-seeding options for an assembly request. */
export interface IncludeAssemblyOptions {
  /** Maximum include nesting depth before a directive is rejected with `depth`. */
  readonly maxDepth?: number;
  /** Global ceiling on the total number of include expansions (fan-out guard). */
  readonly maxExpansions?: number;
  /**
   * Attribute state already in effect where the root's content begins but not written as `:name:` lines
   * (renderer intrinsics + API-seeded values), so conditional include-gating and `{attr}` target
   * substitution agree with the eventual render.
   */
  readonly seedAttributes?: ReadonlyMap<string, string>;
  /** The `:leveloffset:` already in effect where the root is included in the wider document. */
  readonly baseOffset?: number;
  /**
   * When true, the assembler also returns a line→source provenance map ({@link AssembledDocument.sourceMap}):
   * for each assembled line, the origin file + source line. Used by preview renders so a click on a rendered
   * block can resolve to its exact source location. Off by default (the map has a cost and exports don't need it).
   */
  readonly withSourceMap?: boolean;
}

/** Everything needed to assemble a document tree from a root file. */
export interface IncludeAssemblyRequest {
  /** The project-relative path of the root (main) file. */
  readonly rootPath: string;
  /** Returns a project-relative path's content, or null if unavailable. */
  readonly readFile: ProjectFileReader;
  /** Resolves + sandbox-confines every include target relative to its referencing file. */
  readonly resolveSandboxedPath: SandboxPathResolver;
  /** Optional assembly bounds and attribute seeding. */
  readonly options?: IncludeAssemblyOptions;
}

/** The origin of one assembled line: the source file and the line within it. */
export interface AssembledLineOrigin {
  /** Project-relative path of the file this assembled line came from. */
  readonly path: string;
  /** 1-based line within {@link path}. */
  readonly sourceLine: number;
}

/** The assembled single-document result and its diagnostics. */
export interface AssembledDocument {
  /** The assembled document with every in-sandbox include inlined. */
  readonly content: string;
  /** Every directive that was rejected or could not be resolved, in encounter order. */
  readonly unresolved: readonly UnresolvedInclude[];
  /**
   * Line→source provenance, present only when {@link IncludeAssemblyOptions.withSourceMap} was set:
   * `lineToSource[i]` is the origin of assembled line `i + 1`. Parallel to the assembled content lines.
   */
  readonly sourceMap?: { readonly lineToSource: readonly AssembledLineOrigin[] };
}

/**
 * Pre-expands a project's `include::` tree into a single sandbox-confined document. Implemented at the
 * composition root over the shared assembly primitive; the PDF pipeline depends only on this interface.
 */
export interface IncludeAssembler {
  /**
   * Assemble the document rooted at `request.rootPath`, inlining sandbox-approved includes.
   *
   * @param request - The root path, file reader, sandbox resolver, and optional assembly bounds.
   * @returns The single inlined document plus every directive left unresolved.
   */
  assemble(request: IncludeAssemblyRequest): AssembledDocument;
}
