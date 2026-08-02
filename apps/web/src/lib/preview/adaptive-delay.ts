import { PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS } from '@/lib/editor-config';

/**
 * The bounds a derived delay is clamped into, for a surface whose renders do not cost what the web
 * preview's do.
 *
 * The doubling rule below is the same for every surface; what differs is the range it is allowed to
 * land in. A page-formatted render is measured in seconds rather than milliseconds (see
 * `specs/043-preview-responsiveness/baseline.md` §5), so a ceiling sized for the web preview clamps
 * every realistic document to the same figure and the derivation stops saying anything. Passing wider
 * bounds lets it keep discriminating; passing none keeps the web preview's own.
 */
export interface AdaptiveDelayBounds {
  /** Shortest delay the derivation may produce. */
  readonly minMs: number;
  /** Longest delay the derivation may produce. */
  readonly maxMs: number;
}

/** The web preview's bounds, used when a caller names none. */
const DEFAULT_BOUNDS: AdaptiveDelayBounds = {
  minMs: PREVIEW_ADAPTIVE_MIN_MS,
  maxMs: PREVIEW_DEBOUNCE_MS,
};

/**
 * How long the live preview should wait after the last keystroke before refreshing, derived from what
 * the previous render cost.
 *
 * A single fixed trailing delay has to be sized for the worst document the editor might be asked to
 * show, so every other document pays that price too: on a short file a render that finishes in 50 ms
 * still sits behind a 500 ms wait, and the author spends ten times longer waiting than the work takes.
 * Deriving the wait from the last measured render collapses that gap — a cheap document refreshes
 * close to live, while an expensive one is scheduled no more eagerly than it is today, because the
 * derived value is capped at the same fixed delay it replaces.
 *
 * Doubling the last render's cost is what makes the two ends behave: while the doubled figure is
 * inside the bounds, the pause is longer than the last render took with room to spare, so refreshes
 * do not pile up on a document that is slow to convert, and it shrinks automatically as the document
 * gets cheaper. The result is clamped to [{@link PREVIEW_ADAPTIVE_MIN_MS}, {@link PREVIEW_DEBOUNCE_MS}]
 * so a very fast render cannot drive it towards re-rendering on every character, and a very slow one
 * cannot push it past the fixed delay authors already experience.
 *
 * The ceiling is where "longer than the last render" stops holding, and it is worth being plain about
 * it: a document costing more than half {@link PREVIEW_DEBOUNCE_MS} is clamped, so the pause is
 * SHORTER than that document's own render. Nothing regresses at that point — the wait is exactly the
 * fixed delay it would have been without any of this — the derived value simply stops being able to
 * outpace the render, and the schedule's own in-flight handling is what keeps forced refreshes from
 * stacking there (the maximum-wait cap in {@link file://../editor-config.ts}).
 *
 * The input is nullable because there is a genuine gap before the first render of a session completes,
 * when nothing has been measured at all. That is not "zero milliseconds" — it is the absence of a
 * measurement, and it is answered with the fixed delay rather than a guess.
 *
 * For the same reason, a *failed* render must leave the caller's stored measurement untouched instead
 * of clearing it or recording a zero: a failure carries no stage timings, so feeding it in would have
 * the schedule act on a number that was never observed, and — because the failure path is usually
 * fast — would read as "this document is cheap" precisely when the evidence says nothing at all. The
 * last successful render remains the best available estimate until another one succeeds.
 *
 * Pure by construction: it reads its bounds from configuration, touches no timers and no React state,
 * and affects only *when* a render is scheduled, never *what* that render produces.
 *
 * @param lastRenderMs - Total duration of the most recent *successful* render, or `null` if no
 *   render has completed yet.
 * @param bounds - The range the derived delay is clamped into. Defaults to the web preview's own.
 *   Note that the unmeasured fallback above is deliberately NOT the ceiling: before anything has been
 *   measured there is no evidence that this surface is expensive, and opening a preview should not
 *   start by waiting as long as its slowest document would earn.
 * @returns The trailing delay in milliseconds, within the given bounds.
 */
export function adaptiveDelayMs(
  lastRenderMs: number | null,
  bounds: AdaptiveDelayBounds = DEFAULT_BOUNDS,
): number {
  if (lastRenderMs === null) return PREVIEW_DEBOUNCE_MS;

  const doubled = lastRenderMs * 2;
  // The ceiling is applied first and the floor second, so the floor is the one that survives bounds
  // that cross. That case is a misconfiguration rather than a state to support — a ceiling set below
  // the shared floor — but it has to resolve the same way for every measurement, or one configuration
  // would produce a wait under the floor for a slow document and over the ceiling for a fast one. The
  // floor wins because it is the bound that keeps a cheap document from re-rendering on every
  // keystroke; exceeding the ceiling costs only promptness.
  return Math.max(Math.min(doubled, bounds.maxMs), bounds.minMs);
}
