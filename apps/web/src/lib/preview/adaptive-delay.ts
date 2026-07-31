import { PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS } from '@/lib/editor-config';

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
 * Doubling the last render's cost is what makes the two ends behave: the pause is always long enough
 * for the previous render to have finished with room to spare, so refreshes do not pile up on a
 * document that is slow to convert, and it shrinks automatically as the document gets cheaper. The
 * result is clamped to [{@link PREVIEW_ADAPTIVE_MIN_MS}, {@link PREVIEW_DEBOUNCE_MS}] so a very fast
 * render cannot drive it towards re-rendering on every character, and a very slow one cannot push it
 * past the fixed delay authors already experience.
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
 * @returns The trailing delay in milliseconds, within the configured bounds.
 */
export function adaptiveDelayMs(lastRenderMs: number | null): number {
  if (lastRenderMs === null) return PREVIEW_DEBOUNCE_MS;

  const doubled = lastRenderMs * 2;
  if (doubled < PREVIEW_ADAPTIVE_MIN_MS) return PREVIEW_ADAPTIVE_MIN_MS;
  if (doubled > PREVIEW_DEBOUNCE_MS) return PREVIEW_DEBOUNCE_MS;
  return doubled;
}
