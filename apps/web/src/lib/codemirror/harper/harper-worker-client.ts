import type { GrammarDialect } from './dialect';
import { HarperEngineInitError, type HarperEngine, type EngineLint } from './harper-engine';
import { WORKER_GONE_MESSAGE } from './harper-engine-proxy';

/**
 * Main-thread client around a {@link HarperEngine}. It owns three concerns the raw engine does not:
 *
 * 1. Warm-up and status — a fire-and-forget `setup()` on editor mount so first-lint latency is hidden,
 *    with an observable status. An init failure is surfaced (status `failed`) but not memoized, so a
 *    later attempt re-tries a clean init (spec degradation path and worker contract).
 * 2. Staleness guard — a monotonic sequence per lint request; a result whose request has since been
 *    superseded resolves to `null` and is discarded, so fast typing never renders stale underlines.
 * 3. Graceful degradation — if the engine cannot initialise, `lint()` resolves to `null` rather than
 *    throwing, so the lint source simply shows nothing and the editor stays usable (Principle X).
 *
 * Debounce is intentionally not here: the `@codemirror/lint` `linter({ delay })` source debounces the
 * lint calls at registration, so adding a second timer here would only double the latency.
 */

/** The lifecycle of the underlying WASM engine, from the client's point of view. */
export type EngineStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * The engine lifecycle as the Writing panel presents it. Adds `disabled` — grammar is gated off for
 * this project (not English, or turned off in the render-config), so the engine is never constructed —
 * a state the raw {@link EngineStatus} cannot express but the panel must distinguish from "still
 * loading" so it never shows an eternal "starting the checker" for a project that will never check.
 */
export type GrammarEngineStatus = 'loading' | 'ready' | 'failed' | 'disabled';

/**
 * Collapse the raw engine status into the panel-facing status. `idle` (pre-warm-up) and `loading` both
 * read as `loading`; `disabled` is never produced here — only the gate (which decides not to construct
 * the engine) can report it.
 *
 * @param status - The raw engine lifecycle status.
 * @returns The panel-facing status (never `disabled`).
 */
export function toGrammarEngineStatus(status: EngineStatus): Exclude<GrammarEngineStatus, 'disabled'> {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return 'loading';
}

/** A prose segment to lint, identified so results can be matched back to document ranges. */
export interface SegmentInput {
  /** A stable identifier for the segment within the current lint pass. */
  id: string;
  /** The extracted prose text of the segment. */
  text: string;
}

/** The lints found in one segment, with spans in that segment's own coordinates. */
export interface SegmentLints {
  /** The identifier of the segment these lints belong to. */
  id: string;
  /** The lints found in the segment. */
  lints: EngineLint[];
}

/**
 * Whether a lint rejection is the engine having gone away rather than having failed on its input.
 *
 * Teardown is routine — the editor unmounts, or grammar checking is switched off, with a pass in
 * flight — and there is nothing to report about it. Anything else is a broken engine, and the
 * difference matters because both arrive here as a rejected promise.
 *
 * @param error - The rejection thrown out of `engine.lint`.
 * @returns True when the worker was disposed underneath the call.
 */
function isEngineGoneError(error: unknown): boolean {
  return error instanceof Error && error.message === WORKER_GONE_MESSAGE;
}

/** A promise-based client over the Harper engine that adds warm-up, status, and a staleness guard. */
export interface HarperWorkerClient {
  /**
   * Begin, or retry, engine initialisation. Safe to call repeatedly.
   *
   * @returns A promise that resolves once the current attempt settles.
   */
  warmUp(): Promise<void>;
  /**
   * Read the current engine status.
   *
   * @returns The current lifecycle status.
   */
  getStatus(): EngineStatus;
  /**
   * Report whether the engine is initialised and able to lint.
   *
   * @returns True once the engine is ready.
   */
  isReady(): boolean;
  /**
   * Subscribe to status transitions.
   *
   * @param listener - Called with each new status.
   * @returns An unsubscribe function.
   */
  onStatusChange(listener: (status: EngineStatus) => void): () => void;
  /**
   * Lint the given segments, warming the engine up on demand.
   *
   * @param segments - The prose segments to lint.
   * @returns The per-segment lints (each carrying the rule that produced it), or `null` when the
   *   request was superseded or the engine is unavailable.
   */
  lint(segments: SegmentInput[]): Promise<SegmentLints[] | null>;
  /**
   * Apply one of a lint's suggestions to the segment text.
   *
   * @param segmentText - The segment the lint was found in.
   * @param lint - The lint whose suggestion is being applied.
   * @param suggestionIndex - The index into the lint's suggestions.
   * @returns The corrected segment text.
   */
  applySuggestion(segmentText: string, lint: EngineLint, suggestionIndex: number): Promise<string>;
  /**
   * Ignore future occurrences of a lint for this user.
   *
   * @param segmentText - The segment the lint was found in.
   * @param lint - The lint to stop reporting.
   * @returns A promise that resolves once the ignore is recorded.
   */
  ignore(segmentText: string, lint: EngineLint): Promise<void>;
  /**
   * Lint a segment and group the lints by their source rule.
   *
   * @param segmentText - The segment to lint.
   * @returns A map of rule name to the lints that rule produced.
   */
  organizedLints(segmentText: string): Promise<Record<string, EngineLint[]>>;
  /**
   * Add accepted dictionary terms so they stop being flagged.
   *
   * @param words - The terms to add.
   * @returns A promise that resolves once the words are imported.
   */
  importWords(words: string[]): Promise<void>;
  /**
   * Replace the worker's user dictionary with exactly `words`: clears any previously imported terms,
   * then imports the given set. This reconciles a removed or cleared term so it is flagged again
   * without a page reload (`importWords` alone is additive and cannot take a term back).
   *
   * @param words - The full set of accepted terms the worker should recognise.
   * @returns A promise that resolves once the dictionary has been reconciled.
   */
  resetWords(words: string[]): Promise<void>;
  /**
   * Export the user-added dictionary terms.
   *
   * @returns The list of added terms.
   */
  exportWords(): Promise<string[]>;
  /**
   * Import a privacy-hashed ignored-lints blob.
   *
   * @param json - The blob previously produced by `exportIgnoredLints`.
   * @returns A promise that resolves once the ignores are imported.
   */
  importIgnoredLints(json: string): Promise<void>;
  /**
   * Export the privacy-hashed ignored-lints blob for persistence.
   *
   * @returns The opaque ignored-lints blob.
   */
  exportIgnoredLints(): Promise<string>;
  /**
   * Switch the enforced English dialect.
   *
   * @param dialect - The dialect to enforce.
   * @returns A promise that resolves once the dialect is set.
   */
  setDialect(dialect: GrammarDialect): Promise<void>;
  /**
   * Read the current rule configuration.
   *
   * @returns The current rule configuration.
   */
  getLintConfig(): Promise<Record<string, boolean | null>>;
  /**
   * Enable or disable rules by name.
   *
   * @param config - A map of rule name to enabled state.
   * @returns A promise that resolves once the configuration is applied.
   */
  setLintConfig(config: Record<string, boolean | null>): Promise<void>;
  /**
   * Read the engine's one-line explanation of each rule, keyed by rule name.
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

/** Upper bound on cached per-segment lint results, so a long document does not grow the cache without limit. */
const SEGMENT_CACHE_MAX = 1000;

/**
 * How long warm-up may stay pending before it is treated as a failed init.
 *
 * The engine's worker can fail in ways that never settle the promise we are awaiting: harper.js does
 * not reject its pending request when its worker errors, so a worker-side throw leaves `setup()`
 * hanging forever, which would pin the panel on "loading" with no way out. Bounding the wait converts
 * that class of failure into the `failed` status the panel can actually report (and, because a failed
 * init is never memoized, a later attempt still retries cleanly). The bound is generous — it must
 * comfortably cover fetching and compiling tens of megabytes of WASM on a slow connection.
 */
const WARMUP_TIMEOUT_MS = 60_000;

/**
 * Create a Harper worker client wrapping a concrete engine.
 *
 * @param engine - The engine to drive (the real WASM adapter in the app, a fake in tests).
 * @returns A client that adds warm-up, observable status, and the staleness guard.
 */
export function createHarperWorkerClient(engine: HarperEngine): HarperWorkerClient {
  let status: EngineStatus = 'idle';
  let setupPromise: Promise<void> | null = null;
  let lintSeq = 0;
  const listeners = new Set<(status: EngineStatus) => void>();
  // Per-segment result cache keyed by segment text: an unchanged paragraph is never re-linted (research
  // R11). Cleared whenever the dictionary, ignores, dialect, or rule config change, since those alter
  // what a given text lints to. Bounded, evicting the oldest entry (Map preserves insertion order).
  // It holds the engine's `EngineLint` objects untouched, so a cache hit still carries each lint's rule
  // name and — crucially — the same object identity the engine registered for apply/ignore.
  const segmentCache = new Map<string, EngineLint[]>();

  /**
   * Store a segment's lints, evicting the oldest entry when the cache exceeds its bound.
   *
   * @param text - The segment text (the cache key).
   * @param lints - The lints found in that segment.
   */
  function cacheSegment(text: string, lints: EngineLint[]): void {
    segmentCache.set(text, lints);
    if (segmentCache.size > SEGMENT_CACHE_MAX) {
      const oldest = segmentCache.keys().next().value;
      if (oldest !== undefined) segmentCache.delete(oldest);
    }
  }

  /** Read the live status through a function so control-flow narrowing never fixes it to one variant. */
  function readStatus(): EngineStatus {
    return status;
  }

  function setStatus(next: EngineStatus): void {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener(status);
  }

  /**
   * Ensure the engine is set up. A failed init is not memoized: the shared `setupPromise` is cleared on
   * failure so a later call re-attempts a clean init.
   *
   * @returns True once the engine is ready, false if initialisation failed.
   */
  async function ensureReady(): Promise<boolean> {
    if (readStatus() === 'ready') return true;
    if (!setupPromise) {
      setStatus('loading');
      setupPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            engine.setup(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new HarperEngineInitError('Harper WASM engine did not finish loading in time')),
                WARMUP_TIMEOUT_MS,
              );
            }),
          ]);
          setStatus('ready');
        } catch (error) {
          setStatus('failed');
          setupPromise = null; // do not memoize the failure — allow a clean retry
          if (!(error instanceof HarperEngineInitError)) throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer); // never leave the watchdog pending
        }
      })();
    }
    await setupPromise;
    return readStatus() === 'ready';
  }

  return {
    async warmUp() {
      await ensureReady();
    },
    getStatus() {
      return readStatus();
    },
    isReady() {
      return readStatus() === 'ready';
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async lint(segments) {
      const seq = ++lintSeq;
      if (!(await ensureReady())) return null;
      const results: SegmentLints[] = [];
      for (const segment of segments) {
        const cached = segmentCache.get(segment.text);
        if (cached) {
          results.push({ id: segment.id, lints: cached });
          continue;
        }
        // A rejection here is usually the engine going away underneath the pass — the editor
        // unmounting with this call in flight, or a worker that died — and `null` is exactly what the
        // callers already treat as "no results this time": both of them say so where they check for
        // it. Letting it propagate instead would surface as an unhandled rejection out of a CodeMirror
        // lint source or an included-file pass, neither of which has anywhere to put an error.
        //
        // "Usually" is the whole reason this does not swallow indiscriminately. A rejection that is
        // NOT teardown — a wasm trap, a segment the engine cannot parse — is a broken engine, and
        // returning `null` for it reports a clean document forever: the reader sees no writing issues
        // and no indication that nothing is being checked. That failure is put through the same
        // `failed` status an init failure uses, which is the one channel the panel can report.
        //
        // And, exactly as an init failure does, it is NOT memoized. `setupPromise` has to be dropped
        // with the status: left in place it is an already-resolved promise that `ensureReady` awaits
        // before returning `readStatus() === 'ready'` — false, for the rest of the session. One
        // transient trap would then stop grammar checking permanently, on an engine that is fine and
        // that the proxy would have rebuilt on the next call, and no later pass could recover it.
        let lints: EngineLint[];
        try {
          lints = await engine.lint(segment.text);
        } catch (error) {
          if (!isEngineGoneError(error)) {
            setStatus('failed');
            setupPromise = null; // do not memoize the failure — allow a clean retry
          }
          return null;
        }
        if (seq !== lintSeq) return null; // superseded mid-flight — discard
        cacheSegment(segment.text, lints);
        results.push({ id: segment.id, lints });
      }
      if (seq !== lintSeq) return null;
      return results;
    },
    applySuggestion(segmentText, lint, suggestionIndex) {
      return engine.applySuggestion(segmentText, lint, suggestionIndex);
    },
    ignore(segmentText, lint) {
      segmentCache.clear(); // an ignored lint stops being reported — cached results are now stale
      return engine.ignore(segmentText, lint);
    },
    organizedLints(segmentText) {
      return engine.organizedLints(segmentText);
    },
    importWords(words) {
      segmentCache.clear(); // an added term stops being flagged — cached results are now stale
      return engine.importWords(words);
    },
    async resetWords(words) {
      segmentCache.clear(); // the accepted-terms set changed — cached results are now stale
      await engine.clearWords(); // drop the previous set so a removed term is reconciled away…
      await engine.importWords(words); // …then re-import the current set as the whole dictionary
    },
    exportWords() {
      return engine.exportWords();
    },
    importIgnoredLints(json) {
      segmentCache.clear(); // ignored lints suppress results — invalidate the cache
      return engine.importIgnoredLints(json);
    },
    exportIgnoredLints() {
      return engine.exportIgnoredLints();
    },
    setDialect(dialect) {
      segmentCache.clear(); // a dialect change alters which spellings are flagged
      return engine.setDialect(dialect);
    },
    getLintConfig() {
      return engine.getLintConfig();
    },
    setLintConfig(config) {
      segmentCache.clear(); // rule config changes what is reported
      return engine.setLintConfig(config);
    },
    getLintDescriptions() {
      // Not cached here: the caller reads it once when the engine turns ready and holds the map.
      return engine.getLintDescriptions();
    },
    dispose() {
      return engine.dispose();
    },
  };
}
