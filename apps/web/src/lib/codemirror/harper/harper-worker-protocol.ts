import type { GrammarDialect } from './dialect';
import type { EngineLint } from './harper-engine';

/**
 * @file The `postMessage` protocol between the main thread and the Harper grammar worker.
 *
 * One call in, one answer out, correlated by a monotonic `id` — the same hand-rolled discriminated-union
 * shape the PDF pipeline uses (`packages/asciidoc-pdf/src/protocol.ts`). Every payload is plain,
 * structured-cloneable data: no `harper.js` object ever crosses the boundary, which is what keeps the
 * WASM engine — and the ~18 MB binary it compiles — entirely inside the worker (worker-protocol
 * contract: "the worker holds all Harper WASM state; the main thread never loads WASM").
 *
 * The call vocabulary mirrors the {@link HarperEngine} seam one-for-one, so the proxy is a transport
 * and nothing more; the worker is the only place engine semantics live.
 */

/** One engine call, in the worker's vocabulary. Named fields (not a tuple) so each is self-describing. */
export type HarperCall =
  /** Complete the (idempotent) engine warm-up. */
  | { readonly method: 'setup' }
  /** Lint one prose segment, in document order. */
  | { readonly method: 'lint'; readonly segmentText: string }
  /** Lint one prose segment, grouped by the rule that produced each lint. */
  | { readonly method: 'organizedLints'; readonly segmentText: string }
  /** Apply the `suggestionIndex`-th suggestion of `lint` to `segmentText`. */
  | {
      readonly method: 'applySuggestion';
      readonly segmentText: string;
      readonly lint: EngineLint;
      readonly suggestionIndex: number;
    }
  /** Stop reporting `lint` in future passes. */
  | { readonly method: 'ignore'; readonly segmentText: string; readonly lint: EngineLint }
  /** Add accepted dictionary terms. */
  | { readonly method: 'importWords'; readonly words: readonly string[] }
  /** Drop every previously added term, leaving the curated dictionary intact. */
  | { readonly method: 'clearWords' }
  /** Read back the added terms. */
  | { readonly method: 'exportWords' }
  /** Import a privacy-hashed ignored-lints blob. */
  | { readonly method: 'importIgnoredLints'; readonly json: string }
  /** Export the privacy-hashed ignored-lints blob. */
  | { readonly method: 'exportIgnoredLints' }
  /** Switch the enforced English dialect. */
  | { readonly method: 'setDialect'; readonly dialect: GrammarDialect }
  /** Read the rule on/off configuration. */
  | { readonly method: 'getLintConfig' }
  /** Enable or disable rules by name. */
  | { readonly method: 'setLintConfig'; readonly config: Record<string, boolean | null> }
  /** Read the engine's one-line explanation of each rule. */
  | { readonly method: 'getLintDescriptions' }
  /** Release the engine's resources. */
  | { readonly method: 'dispose' };

/** The name of an engine call. */
export type HarperMethod = HarperCall['method'];

/**
 * What a call resolved to, tagged with the method that produced it so the proxy can pair an answer with
 * its question without a type assertion. Calls that answer nothing carry `null` rather than omitting the
 * field, so every value has the same shape.
 */
export type HarperValue =
  /** Warm-up completed. */
  | { readonly method: 'setup'; readonly result: null }
  /** The segment's lints, in document order. */
  | { readonly method: 'lint'; readonly result: EngineLint[] }
  /** The segment's lints, keyed by the rule that produced them. */
  | { readonly method: 'organizedLints'; readonly result: Record<string, EngineLint[]> }
  /** The segment text with the suggestion applied. */
  | { readonly method: 'applySuggestion'; readonly result: string }
  /** The lint is now ignored. */
  | { readonly method: 'ignore'; readonly result: null }
  /** The terms were added. */
  | { readonly method: 'importWords'; readonly result: null }
  /** The added terms were dropped. */
  | { readonly method: 'clearWords'; readonly result: null }
  /** The user-added dictionary terms. */
  | { readonly method: 'exportWords'; readonly result: string[] }
  /** The ignores were imported. */
  | { readonly method: 'importIgnoredLints'; readonly result: null }
  /** The opaque ignored-lints blob. */
  | { readonly method: 'exportIgnoredLints'; readonly result: string }
  /** The dialect is now in force. */
  | { readonly method: 'setDialect'; readonly result: null }
  /** The current rule configuration. */
  | { readonly method: 'getLintConfig'; readonly result: Record<string, boolean | null> }
  /** The rule configuration was applied. */
  | { readonly method: 'setLintConfig'; readonly result: null }
  /** Each rule's one-line description, keyed by rule name. */
  | { readonly method: 'getLintDescriptions'; readonly result: Record<string, string> }
  /** The engine released its resources. */
  | { readonly method: 'dispose'; readonly result: null };

/**
 * A failed call. `engine-init-failed` is the degradation path the client watches for (the WASM engine
 * could not be loaded at all); anything else is a per-call failure that leaves the engine usable.
 */
interface HarperWireError {
  /** Whether the engine itself could not start, or just this call failed. */
  readonly code: 'engine-init-failed' | 'call-failed';
  /** A human-readable description of the failure. */
  readonly message: string;
}

/** Main → worker: one call, tagged with the id its answer must carry. */
export interface ToHarperWorker {
  /** Monotonic correlation id, unique per worker. */
  readonly id: number;
  /** The call to make. */
  readonly call: HarperCall;
}

/** Worker → main: the answer to exactly one call. */
export type FromHarperWorker =
  | {
      /** The correlation id of the call being answered. */
      readonly id: number;
      /** The call succeeded. */
      readonly ok: true;
      /** What it resolved to. */
      readonly value: HarperValue;
    }
  | {
      /** The correlation id of the call being answered. */
      readonly id: number;
      /** The call failed. */
      readonly ok: false;
      /** Why it failed. */
      readonly error: HarperWireError;
    };

/**
 * Narrow an answer to the one produced by `method`.
 *
 * This is the boundary check that lets the proxy return a precisely-typed result with no assertion: a
 * mismatch means the worker answered a different question than it was asked, which the caller reports
 * rather than passing off as a result of the wrong shape.
 *
 * @param value - The answer the worker sent.
 * @param method - The method whose answer is expected.
 * @returns True when the answer was produced by that method.
 */
export function isValueOf<Method extends HarperMethod>(
  value: HarperValue,
  method: Method,
): value is Extract<HarperValue, { method: Method }> {
  return value.method === method;
}
