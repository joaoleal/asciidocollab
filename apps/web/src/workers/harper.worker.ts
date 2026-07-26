/**
 * @file The Harper grammar Web Worker — the composition root that owns the WASM engine and serves the
 * {@link ToHarperWorker} protocol.
 *
 * Responsibilities that MUST live here (they touch the browser/WASM surface the rest of the module
 * stays free of): import `harper.js`, construct the `LocalLinter` over the vendored same-origin binary,
 * flatten Harper's WASM-backed objects into the plain {@link EngineLint} data the protocol carries, and
 * answer one message at a time.
 *
 * Every byte of Harper's WASM lives in THIS thread. The engine was previously driven through
 * `harper.js`'s own `WorkerLinter`, which does spawn a worker but also loads the binary on the caller's
 * thread (its RPC serializer rehydrates each `Lint` into main-thread WASM objects) — so the editor paid
 * a multi-hundred-millisecond stall while the reader typed, which is exactly what the live-preview
 * responsiveness spec catches. Owning the worker ourselves and shipping plain data back is what keeps
 * the checking off the typing path.
 *
 * Nothing here reaches the network beyond the same-origin vendored binary: no document text ever
 * egresses (Principle X). Everything above the {@link HarperEngine} seam is unit-tested against a fake
 * engine; this file, like the other worker entries, is verified in a real browser.
 */

import {
  createBinaryModuleFromUrl,
  Dialect,
  LocalLinter,
  SuggestionKind,
  type Lint,
  type Suggestion,
} from 'harper.js';
import { resolveHarperWasmUrl } from '../lib/codemirror/harper/wasm-url';
import type { GrammarDialect } from '../lib/codemirror/harper/dialect';
import {
  HarperEngineInitError,
  type EngineLint,
  type EngineSuggestion,
} from '../lib/codemirror/harper/harper-engine';
import type {
  FromHarperWorker,
  HarperCall,
  HarperValue,
  ToHarperWorker,
} from '../lib/codemirror/harper/harper-worker-protocol';

/** Harper parses our segments as plain prose: the AsciiDoc markup is already stripped upstream. */
const LINT_OPTIONS = { language: 'plaintext' } as const;

/** The dialect the engine starts on; the proxy applies the reader's own before any lint is requested. */
const INITIAL_DIALECT: GrammarDialect = 'en-US';

/** The linter for the current dialect, or null until the first call constructs it. */
let linter: LocalLinter | null = null;
let currentDialect: GrammarDialect = INITIAL_DIALECT;

/**
 * Map our dialect vocabulary onto Harper's.
 *
 * @param dialect - The dialect to enforce.
 * @returns The engine's matching dialect value.
 */
function dialectValue(dialect: GrammarDialect): Dialect {
  return dialect === 'en-US' ? Dialect.American : Dialect.British;
}

/**
 * Construct and warm the linter, once. A failure clears the slot rather than memoizing it, so a later
 * call re-attempts a clean init (spec degradation path and worker contract).
 *
 * @returns The ready linter.
 * @throws {HarperEngineInitError} When the WASM engine cannot be loaded.
 */
async function ensureLinter(): Promise<LocalLinter> {
  if (linter) return linter;
  try {
    // Absolute, same-origin URL: the binary is a vendored asset served from `public/`, and the engine
    // fetches it from here — this worker's own thread — so it never touches a cross-origin host.
    const binary = createBinaryModuleFromUrl(resolveHarperWasmUrl(globalThis.location.origin), 'full');
    const created = new LocalLinter({ binary, dialect: dialectValue(currentDialect) });
    await created.setup();
    linter = created;
    return created;
  } catch (error) {
    linter = null;
    throw new HarperEngineInitError('Harper WASM engine failed to initialise', { cause: error });
  }
}

/**
 * Flatten one raw suggestion into plain data.
 *
 * @param suggestion - The suggestion as the engine reports it.
 * @returns The seam-safe suggestion.
 */
function toEngineSuggestion(suggestion: Suggestion): EngineSuggestion {
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
 * Flatten one raw lint into the plain data the protocol carries.
 *
 * @param lint - The raw lint from the engine.
 * @param rule - The name of the rule that produced it (the `organizedLints` group key).
 * @returns The seam-safe lint.
 */
function toEngineLint(lint: Lint, rule: string): EngineLint {
  const span = lint.span();
  return {
    span: { start: span.start, end: span.end },
    kind: lint.lint_kind(),
    rule,
    message: lint.message(),
    suggestions: lint.suggestions().map((suggestion) => toEngineSuggestion(suggestion)),
  };
}

/**
 * Flatten Harper's rule-keyed groups into one document-ordered list, carrying each lint's rule.
 *
 * `organizedLints` returns the lints grouped (and therefore ordered) by rule; the panel and the
 * underlines want them in document order, which is the order plain `lint()` returns and which sorting
 * on span restores exactly (verified against the engine: same lints, and `lint()`'s own order is
 * already ascending by span).
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

/**
 * Re-resolve the raw lint an {@link EngineLint} stands for by linting its segment again.
 *
 * The raw `Lint` cannot cross the worker boundary — it is a handle into this thread's WASM memory —
 * and a structured clone of our flat copy carries no identity, so `applySuggestion`/`ignore` find their
 * lint the only way that stays true to the engine: they ask it for the segment's lints again and match
 * on the rule, span and message the caller was shown. Linting the same text with the same options is
 * deterministic, so the match is the lint the reader clicked on.
 *
 * @param segmentText - The segment the lint was found in.
 * @param engineLint - The flattened lint to resolve back to its engine object.
 * @returns The raw lint and its suggestions.
 * @throws {Error} When the lint is no longer reported for that text (the rules or dictionary changed).
 */
async function resolveLint(
  segmentText: string,
  engineLint: EngineLint,
): Promise<{ lint: Lint; suggestions: Suggestion[] }> {
  const active = await ensureLinter();
  const groups = await active.organizedLints(segmentText, LINT_OPTIONS);
  for (const lint of groups[engineLint.rule] ?? []) {
    const span = lint.span();
    if (span.start !== engineLint.span.start || span.end !== engineLint.span.end) continue;
    if (lint.message() !== engineLint.message) continue;
    return { lint, suggestions: lint.suggestions() };
  }
  throw new Error(`The “${engineLint.rule}” issue is no longer reported for this text`);
}

/**
 * Serve one call.
 *
 * @param call - The call to serve.
 * @returns The value to answer with.
 * @throws {HarperEngineInitError} When the WASM engine cannot be loaded.
 */
async function serve(call: HarperCall): Promise<HarperValue> {
  switch (call.method) {
    case 'setup': {
      await ensureLinter();
      return { method: 'setup', result: null };
    }
    case 'lint': {
      const active = await ensureLinter();
      // Linting goes through `organizedLints`, not `lint`, because the rule that fired is the one thing
      // a `Lint` cannot tell us (it exposes `lint_kind()` only) and the panel names it per issue. The
      // two are the same check: the harper.js wrapper hands both calls identical parser options
      // (`language`, `forceAllHeadings: false`, no regex mask, `dedup: true`), so the same lint set
      // comes back — grouped rather than flat, which `flattenOrganized` puts back in document order.
      const groups = await active.organizedLints(call.segmentText, LINT_OPTIONS);
      return { method: 'lint', result: flattenOrganized(groups) };
    }
    case 'organizedLints': {
      const active = await ensureLinter();
      const groups = await active.organizedLints(call.segmentText, LINT_OPTIONS);
      const result: Record<string, EngineLint[]> = {};
      for (const [rule, lints] of Object.entries(groups)) {
        result[rule] = lints.map((lint) => toEngineLint(lint, rule));
      }
      return { method: 'organizedLints', result };
    }
    case 'applySuggestion': {
      const active = await ensureLinter();
      const { lint, suggestions } = await resolveLint(call.segmentText, call.lint);
      const suggestion = suggestions[call.suggestionIndex];
      if (!suggestion) throw new Error(`No suggestion at index ${call.suggestionIndex}`);
      return {
        method: 'applySuggestion',
        result: await active.applySuggestion(call.segmentText, lint, suggestion),
      };
    }
    case 'ignore': {
      const active = await ensureLinter();
      const { lint } = await resolveLint(call.segmentText, call.lint);
      await active.ignoreLint(call.segmentText, lint);
      return { method: 'ignore', result: null };
    }
    case 'importWords': {
      const active = await ensureLinter();
      await active.importWords([...call.words]);
      return { method: 'importWords', result: null };
    }
    case 'clearWords': {
      const active = await ensureLinter();
      await active.clearWords();
      return { method: 'clearWords', result: null };
    }
    case 'exportWords': {
      const active = await ensureLinter();
      return { method: 'exportWords', result: await active.exportWords() };
    }
    case 'importIgnoredLints': {
      const active = await ensureLinter();
      await active.importIgnoredLints(call.json);
      return { method: 'importIgnoredLints', result: null };
    }
    case 'exportIgnoredLints': {
      const active = await ensureLinter();
      return { method: 'exportIgnoredLints', result: await active.exportIgnoredLints() };
    }
    case 'setDialect': {
      currentDialect = call.dialect; // remembered so a later re-init constructs on the same dialect
      const active = await ensureLinter();
      await active.setDialect(dialectValue(call.dialect));
      return { method: 'setDialect', result: null };
    }
    case 'getLintConfig': {
      const active = await ensureLinter();
      return { method: 'getLintConfig', result: await active.getLintConfig() };
    }
    case 'setLintConfig': {
      const active = await ensureLinter();
      await active.setLintConfig(call.config);
      return { method: 'setLintConfig', result: null };
    }
    case 'getLintDescriptions': {
      const active = await ensureLinter();
      return { method: 'getLintDescriptions', result: await active.getLintDescriptions() };
    }
    case 'dispose': {
      const active = linter;
      linter = null;
      await active?.dispose();
      return { method: 'dispose', result: null };
    }
  }
}

/**
 * Describe a thrown value for the wire.
 *
 * @param error - Whatever was thrown.
 * @returns A human-readable message.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One call at a time, in the order they arrive: the engine is a single WASM instance, and the proxy
// relies on that order (the dialect it posts on spawn must land before the first lint).
let queue: Promise<void> = Promise.resolve();

onmessage = function (event: MessageEvent<ToHarperWorker>): void {
  const { id, call } = event.data;
  queue = queue.then(async () => {
    try {
      const value = await serve(call);
      postMessage({ id, ok: true, value } satisfies FromHarperWorker);
    } catch (error) {
      postMessage({
        id,
        ok: false,
        error: {
          code: error instanceof HarperEngineInitError ? 'engine-init-failed' : 'call-failed',
          message: describeError(error),
        },
      } satisfies FromHarperWorker);
    }
  });
};
