import type { Lint, Suggestion, WorkerLinter, Dialect } from 'harper.js';
import type { GrammarDialect } from './codemirror/harper/dialect';
import {
  HarperEngineInitError,
  type HarperEngine,
  type EngineLint,
  type EngineSuggestion,
} from './codemirror/harper/harper-engine';
import { resolveHarperWasmUrl } from './codemirror/harper/wasm-url';

/**
 * Constructs the Harper grammar engine and adapts its `WorkerLinter` to our {@link HarperEngine} seam.
 *
 * Per the T003 spike, `WorkerLinter` self-manages its own dedicated Web Worker + WASM, so this factory
 * is the whole "worker" — there is no separate `harper.worker.ts`. The WASM binary is self-hosted as a
 * same-origin vendored asset (`/vendor/harper/harper_wasm_bg.wasm`, copied by `build-harper-wasm.mjs`),
 * so linting works fully offline and no document text ever egresses (Principle X). The full binary is
 * used (the slim flavor drops rules we need for grammar/style).
 *
 * `harper.js` is imported dynamically inside `ensureLinter` so it stays OUT of the static module graph:
 * it is a large ESM+WASM package that cannot load under the commonjs jest runtime, and this factory is
 * transitively imported by the editor mount hook. Deferring the import means editor unit tests never
 * pull it, while the browser loads it lazily off the typing path. This module is the only one that
 * touches `harper.js`; because `WorkerLinter` does not work under Node, it is exercised in a real
 * browser (T041), and everything above the `HarperEngine` interface unit-tests against a fake engine.
 */

type HarperModule = typeof import('harper.js');

/** The raw Harper objects a lint needs for later apply/ignore, kept engine-side, never crossing the seam. */
interface LintReference {
  readonly lint: Lint;
  readonly suggestions: Suggestion[];
}

/**
 * Build a Harper engine bound to the given dialect. The WASM engine is loaded and constructed lazily on
 * the first call that needs it (`setup`, `lint`, …); an init failure surfaces as
 * {@link HarperEngineInitError} and is not memoized, so a later call re-attempts a clean init.
 *
 * @param dialect - The English dialect to enforce.
 * @returns A {@link HarperEngine} backed by a self-hosted `WorkerLinter`.
 */
export function createHarperEngine(dialect: GrammarDialect): HarperEngine {
  let currentDialect = dialect;
  let harper: HarperModule | null = null;
  let linter: WorkerLinter | null = null;

  // The `EngineLint` we hand out carries only plain data; the raw Harper objects apply/ignore need are
  // kept here, keyed by the exact `EngineLint` instance. A WeakMap gives a typed lookup with no cast and
  // lets a lint be garbage-collected once the view drops it.
  const references = new WeakMap<EngineLint, LintReference>();

  function dialectValue(harperModule: HarperModule, next: GrammarDialect): Dialect {
    return next === 'en-US' ? harperModule.Dialect.American : harperModule.Dialect.British;
  }

  function requireModule(): HarperModule {
    if (!harper) throw new Error('Harper module is not loaded yet');
    return harper;
  }

  function toEngineSuggestion(suggestion: Suggestion): EngineSuggestion {
    const { SuggestionKind } = requireModule();
    const kind = suggestion.kind();
    return {
      text: suggestion.get_replacement_text(),
      kind:
        kind === SuggestionKind.Remove
          ? 'remove'
          : (kind === SuggestionKind.InsertAfter ? 'insert-after' : 'replace'),
    };
  }

  /**
   * Flatten one raw Harper lint into plain data and register the raw objects apply/ignore will need.
   *
   * @param lint - The raw lint from the engine.
   * @param rule - The name of the rule that produced it (the `organizedLints` group key).
   * @returns The seam-safe lint, registered by identity for later apply/ignore.
   */
  function toEngineLint(lint: Lint, rule: string): EngineLint {
    const span = lint.span();
    const suggestions = lint.suggestions();
    const engineLint: EngineLint = {
      span: { start: span.start, end: span.end },
      kind: lint.lint_kind(),
      rule,
      message: lint.message(),
      suggestions: suggestions.map((suggestion) => toEngineSuggestion(suggestion)),
    };
    references.set(engineLint, { lint, suggestions });
    return engineLint;
  }

  /**
   * Flatten Harper's rule-keyed groups into one document-ordered list, carrying each lint's rule.
   *
   * `organizedLints` returns the lints grouped (and therefore ordered) by rule; the panel and the
   * underlines want them in document order, which is the order plain `lint()` returns and which
   * sorting on span restores exactly (verified against the engine: same lints, and `lint()`'s own
   * order is already ascending by span). Sorting keeps the same objects, so the WeakMap identity
   * apply/ignore depends on survives.
   *
   * @param groups - The rule-keyed groups from `organizedLints`.
   * @returns Every lint in the segment, in document order.
   */
  function flattenOrganized(groups: Record<string, Lint[]>): EngineLint[] {
    const flat: EngineLint[] = [];
    for (const [rule, lints] of Object.entries(groups)) {
      for (const lint of lints) flat.push(toEngineLint(lint, rule));
    }
    return flat.toSorted((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  }

  function referenceOf(engineLint: EngineLint): LintReference {
    const reference = references.get(engineLint);
    if (!reference) throw new Error('Unknown EngineLint — it was not produced by this engine');
    return reference;
  }

  /**
   * Lazily import `harper.js`, construct the `WorkerLinter`, and warm it up. Idempotent once ready; a
   * failure clears state so a later call re-attempts a clean init (never memoized).
   */
  async function ensureLinter(): Promise<WorkerLinter> {
    if (linter) return linter;
    try {
      const loaded = await import('harper.js');
      // Absolute, NOT the root-relative path: the URL is fetched inside a `blob:` worker, where a
      // root-relative path cannot be parsed (see `resolveHarperWasmUrl`).
      const binary = loaded.createBinaryModuleFromUrl(
        resolveHarperWasmUrl(globalThis.location.origin),
        'full',
      );
      const created = new loaded.WorkerLinter({ binary, dialect: dialectValue(loaded, currentDialect) });
      await created.setup();
      harper = loaded;
      linter = created;
      return created;
    } catch (error) {
      harper = null;
      linter = null;
      throw new HarperEngineInitError('Harper WASM engine failed to initialise', { cause: error });
    }
  }

  return {
    async setup() {
      await ensureLinter();
    },
    async lint(segmentText) {
      const active = await ensureLinter();
      // Linting goes through `organizedLints`, not `lint`, because the rule that fired is the one thing
      // a `Lint` cannot tell us (it exposes `lint_kind()` only) and the panel names it per issue. The
      // two are the same check: the harper.js wrapper hands both calls identical parser options
      // (`language`, `forceAllHeadings: false`, no regex mask, `dedup: true`), so the same lint set
      // comes back — grouped rather than flat, which `flattenOrganized` puts back in document order.
      const groups = await active.organizedLints(segmentText, { language: 'plaintext' });
      return flattenOrganized(groups);
    },
    async organizedLints(segmentText) {
      const active = await ensureLinter();
      const groups = await active.organizedLints(segmentText, { language: 'plaintext' });
      const result: Record<string, EngineLint[]> = {};
      for (const [rule, lints] of Object.entries(groups)) {
        result[rule] = lints.map((lint) => toEngineLint(lint, rule));
      }
      return result;
    },
    async applySuggestion(segmentText, lint, suggestionIndex) {
      const active = await ensureLinter();
      const { lint: rawLint, suggestions } = referenceOf(lint);
      const suggestion = suggestions[suggestionIndex];
      if (!suggestion) throw new Error(`No suggestion at index ${suggestionIndex}`);
      return active.applySuggestion(segmentText, rawLint, suggestion);
    },
    async ignore(segmentText, lint) {
      const active = await ensureLinter();
      await active.ignoreLint(segmentText, referenceOf(lint).lint);
    },
    async importWords(words) {
      const active = await ensureLinter();
      await active.importWords(words);
    },
    async clearWords() {
      const active = await ensureLinter();
      await active.clearWords();
    },
    async exportWords() {
      const active = await ensureLinter();
      return active.exportWords();
    },
    async importIgnoredLints(json) {
      const active = await ensureLinter();
      await active.importIgnoredLints(json);
    },
    async exportIgnoredLints() {
      const active = await ensureLinter();
      return active.exportIgnoredLints();
    },
    async setDialect(next) {
      currentDialect = next;
      const active = await ensureLinter();
      await active.setDialect(dialectValue(requireModule(), next));
    },
    async getLintConfig() {
      const active = await ensureLinter();
      return active.getLintConfig();
    },
    async setLintConfig(config) {
      const active = await ensureLinter();
      await active.setLintConfig(config);
    },
    async getLintDescriptions() {
      const active = await ensureLinter();
      return active.getLintDescriptions();
    },
    async dispose() {
      if (!linter) return;
      const active = linter;
      linter = null;
      harper = null;
      await active.dispose();
    },
  };
}
