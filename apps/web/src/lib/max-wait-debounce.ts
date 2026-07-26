/**
 * A trailing debounce with a maximum-wait cap.
 *
 * Each {@link MaxWaitDebounce.schedule} call restarts a trailing timer of `delayMs`, so a burst of
 * rapid calls collapses to a single run `delayMs` after the burst stops. To stop continuous activity
 * from postponing the run forever, the first call of a burst also arms a separate max-wait timer of
 * `maxWaitMs` that is NOT restarted by later calls — so the run fires no later than `maxWaitMs` after
 * the burst began, even while calls keep arriving. Whichever timer fires first runs the latest
 * scheduled callback and disarms both, starting a fresh burst window on the next call.
 */

/** A trailing debounce whose run is also forced after a maximum wait. */
export interface MaxWaitDebounce {
  /**
   * Schedule `run` to fire after the trailing delay, or sooner if the max wait for the current burst
   * elapses first. Only the most recently scheduled `run` fires.
   *
   * @param run - The callback to invoke when the debounce fires.
   */
  schedule: (run: () => void) => void;
  /** Cancel any pending run and reset the burst window. */
  cancel: () => void;
}

/**
 * Create a {@link MaxWaitDebounce}.
 *
 * @param delayMs - Trailing debounce delay: how long after the last call the run fires.
 * @param maxWaitMs - Maximum time the run may be postponed while calls keep arriving.
 * @returns A debounce controller with `schedule` and `cancel`.
 */
export function createMaxWaitDebounce(delayMs: number, maxWaitMs: number): MaxWaitDebounce {
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRun: (() => void) | null = null;

  const cancel = (): void => {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    pendingRun = null;
  };

  const fire = (): void => {
    const run = pendingRun;
    cancel();
    run?.();
  };

  const schedule = (run: () => void): void => {
    pendingRun = run;
    if (trailingTimer !== null) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(fire, delayMs);
    // Arm the max-wait cap once per burst; deliberately not reset by later calls.
    if (maxWaitTimer === null) maxWaitTimer = setTimeout(fire, maxWaitMs);
  };

  return { schedule, cancel };
}
