import type { GrammarDialect } from './dialect';

/**
 * The domain-typed seam between our code and the Harper WASM engine. Everything above this interface
 * (the worker client, lint source, panel) depends only on `HarperEngine` and these plain data types —
 * never on `harper.js` directly — so it all unit-tests against a fake engine.
 *
 * The one concrete implementation is the pair `harper-engine-proxy.ts` (main thread) +
 * `workers/harper.worker.ts` (the engine), which speak the `harper-worker-protocol.ts` messages. The
 * worker is the only module that imports `harper.js`, and therefore the only place the WASM binary is
 * ever loaded — the T003 spike's shortcut of driving `harper.js`'s own `WorkerLinter` from the main
 * thread looked equivalent but is not: its RPC serializer rehydrates every `Lint` into main-thread WASM
 * objects, so it loaded the binary here too and stalled the editor while the reader typed.
 */

/** A character range within a linted segment's text, as returned by Harper's `Lint.span()`. */
export interface EngineSpan {
  /** Offset of the first problem character within the segment text. */
  start: number;
  /** Offset just past the last problem character within the segment text. */
  end: number;
}

/** A single suggested fix for a lint. */
export interface EngineSuggestion {
  /** The replacement text, empty for a pure removal (Harper's `Suggestion.get_replacement_text()`). */
  readonly text: string;
  /** Whether the suggestion replaces the span, removes it, or inserts text after it. */
  readonly kind: 'replace' | 'remove' | 'insert-after';
}

/**
 * One issue Harper found in a segment, flattened to plain data. Rendering and mapping code read these
 * fields directly; `applySuggestion` and `ignore` take the whole `EngineLint` back so the engine can
 * re-resolve its own underlying lint object by identity, without that object ever crossing the seam.
 */
export interface EngineLint {
  /** The location of the problem, in the linted segment's own coordinates. */
  readonly span: EngineSpan;
  /** The general category from Harper's `Lint.lint_kind()`, such as `Spelling`, `Grammar`, or `Style`. */
  readonly kind: string;
  /**
   * The name of the individual rule that produced this lint, as the engine names it — `Albeit`,
   * `SpelledNumbers`, `SpellCheck`. These are exactly the keys of {@link HarperEngine.getLintConfig},
   * so a rule named on an issue is the same string the reader can search for and switch off in the
   * Rules list. It is engine-reported and must never be mapped to a fixed list of our own.
   *
   * `Lint` itself cannot answer this — it exposes only `lint_kind()` — so the only source is
   * `organizedLints`, whose keys ARE the rule names. Empty when a lint reached us with no rule to
   * attribute it to (nothing to name, so the UI shows no chip rather than a placeholder).
   */
  readonly rule: string;
  /** A human-readable description of the problem. */
  readonly message: string;
  /** The ordered suggested fixes, index-aligned with `applySuggestion`. */
  readonly suggestions: EngineSuggestion[];
}

/**
 * The subset of Harper's linter the app uses, expressed in domain vocabulary. Every method runs its
 * work off the main thread inside the engine's worker.
 */
export interface HarperEngine {
  /**
   * Complete the (idempotent) warm-up that constructs and loads the WASM engine.
   *
   * @returns A promise that resolves once the engine is ready to lint.
   * @throws {HarperEngineInitError} When the WASM engine fails to initialise.
   */
  setup(): Promise<void>;
  /**
   * Lint one prose segment as plaintext.
   *
   * @param segmentText - The extracted prose of a single block, with markup already removed.
   * @returns The lints found in document order, with spans in the segment's own coordinates and each
   *   carrying the {@link EngineLint.rule} that produced it.
   */
  lint(segmentText: string): Promise<EngineLint[]>;
  /**
   * Lint a segment and group the lints by their source rule for the panel and rules views.
   *
   * @param segmentText - The extracted prose of a single block.
   * @returns A map of rule name to the lints that rule produced.
   */
  organizedLints(segmentText: string): Promise<Record<string, EngineLint[]>>;
  /**
   * Apply one of a lint's suggestions to the segment text.
   *
   * @param segmentText - The segment the lint was found in.
   * @param lint - The lint whose suggestion is being applied.
   * @param suggestionIndex - The index into the lint's `suggestions`.
   * @returns The corrected segment text.
   */
  applySuggestion(segmentText: string, lint: EngineLint, suggestionIndex: number): Promise<string>;
  /**
   * Ignore future occurrences of a lint, stored as a privacy-respecting hash.
   *
   * @param segmentText - The segment the lint was found in, used to compute the ignore hash.
   * @param lint - The lint to stop reporting.
   * @returns A promise that resolves once the ignore is recorded.
   */
  ignore(segmentText: string, lint: EngineLint): Promise<void>;
  /**
   * Add accepted dictionary terms so they stop being flagged. Heavy, so callers batch terms.
   *
   * @param words - The terms to add to the dictionary.
   * @returns A promise that resolves once the words are imported.
   */
  importWords(words: string[]): Promise<void>;
  /**
   * Clear every word previously added via `importWords`, leaving the curated built-in dictionary
   * intact. Callers use this to reconcile a shrunk project dictionary (a removed or cleared term)
   * back into the running engine, since `importWords` is additive and cannot remove a term.
   *
   * @returns A promise that resolves once the added words are cleared.
   */
  clearWords(): Promise<void>;
  /**
   * Export the words added via `importWords` (never the curated built-in dictionary).
   *
   * @returns The list of user-added dictionary terms.
   */
  exportWords(): Promise<string[]>;
  /**
   * Import a privacy-hashed ignored-lints blob, appending to any existing ignores.
   *
   * @param json - The blob previously produced by `exportIgnoredLints`.
   * @returns A promise that resolves once the ignores are imported.
   */
  importIgnoredLints(json: string): Promise<void>;
  /**
   * Export the privacy-hashed ignored-lints blob so it can be persisted for this user.
   *
   * @returns The opaque ignored-lints blob.
   */
  exportIgnoredLints(): Promise<string>;
  /**
   * Switch the enforced English dialect. The caller decides when to re-lint afterwards.
   *
   * @param dialect - The dialect to enforce from now on.
   * @returns A promise that resolves once the dialect is set.
   */
  setDialect(dialect: GrammarDialect): Promise<void>;
  /**
   * Read the current rule on/off configuration. Keys are engine-reported and must never be hardcoded.
   *
   * @returns The current rule configuration.
   */
  getLintConfig(): Promise<Record<string, boolean | null>>;
  /**
   * Enable or disable rules by name. The engine ignores unknown keys.
   *
   * @param config - A map of rule name to enabled state (`null` restores the default).
   * @returns A promise that resolves once the configuration is applied.
   */
  setLintConfig(config: Record<string, boolean | null>): Promise<void>;
  /**
   * Read the engine's one-line explanation of each rule, keyed by the same rule names
   * {@link getLintConfig} and {@link EngineLint.rule} use. Read once per engine: the text is static
   * for a Harper version and there are hundreds of entries.
   *
   * @returns A map of rule name to its description.
   */
  getLintDescriptions(): Promise<Record<string, string>>;
  /**
   * Release the engine and its worker.
   *
   * @returns A promise that resolves once resources are freed.
   */
  dispose(): Promise<void>;
}

/** Thrown when the WASM engine fails to initialise; carries a structured code for the degradation path. */
export class HarperEngineInitError extends Error {
  readonly code = 'engine-init-failed';
  /**
   * Create an initialisation error.
   *
   * @param message - A human-readable description of the failure.
   * @param options - Standard error options such as the underlying `cause`.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HarperEngineInitError';
  }
}
