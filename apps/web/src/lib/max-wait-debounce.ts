/**
 * A trailing debounce with a maximum-wait cap.
 *
 * Each {@link MaxWaitDebounce.schedule} call restarts a trailing timer of `delayMs`, so a burst of
 * rapid calls collapses to a single run `delayMs` after the burst stops. To stop continuous activity
 * from postponing the run forever, the first call of a burst also arms a separate max-wait timer of
 * `maxWaitMs` that is NOT restarted by later calls — so the run fires no later than `maxWaitMs` after
 * the burst began, even while calls keep arriving. Whichever timer fires first runs the latest
 * scheduled callback and disarms both, starting a fresh burst window on the next call.
 *
 * The caller can additionally report, through {@link MaxWaitDebounce.setInProgress}, that a previous
 * run has not finished yet. The max-wait cap then holds its run back instead of starting a second one
 * concurrently, and releases it the moment the caller reports completion. Holding it back without
 * that release would be worse than not capping at all: the guarantee would fire once and then lapse
 * silently for the rest of the session.
 *
 * Note which of the two intervals a caller may vary and which it may not. The trailing delay is
 * per-call ({@link MaxWaitDebounce.schedule} takes one), because how long it is worth pausing before
 * acting depends on what the action currently costs — a caller that measures its own work can spend a
 * shorter pause on cheap work and a longer one on expensive work, and each call is the moment that
 * knowledge is current. The cap is not per-call and is fixed at construction: it is a promise about
 * the burst as a whole — "this will run within `maxWaitMs` of activity starting" — and a promise that
 * could be re-stated by every call is no promise at all, since a stream of calls would keep moving the
 * deadline it is supposed to bound. That is the same reason later calls do not restart it.
 */

/** A trailing debounce whose run is also forced after a maximum wait. */
export interface MaxWaitDebounce {
  /**
   * Schedule `run` to fire after the trailing delay, or sooner if the max wait for the current burst
   * elapses first. Only the most recently scheduled `run` fires.
   *
   * @param run - The callback to invoke when the debounce fires.
   * @param trailingDelayMs - Trailing delay for THIS call, overriding the constructed one. Carried on
   *   the call rather than held as settable state so the delay is always the one the caller knew
   *   about at the moment it scheduled, and so nothing can leave a stale delay behind for a later
   *   caller to inherit. Omit to use the constructed delay. It never affects the max-wait cap.
   */
  schedule: (run: () => void, trailingDelayMs?: number) => void;
  /** Cancel any pending run and reset the burst window. */
  cancel: () => void;
  /**
   * Run the pending callback now, bypassing both timers, and start a fresh burst window. A no-op
   * when nothing is pending. Used when waiting is pointless because the reason to wait is gone — a
   * file switch, for instance, where the debounce exists to absorb typing that has just ended.
   *
   * @returns Whether there was a pending callback, and so whether anything ran. A caller holding a
   *   fallback of its own needs this: what is pending here is always the more recent of the two, so
   *   "nothing was pending" is what tells it to fall back rather than drop the fallback silently.
   */
  flush: () => boolean;
  /**
   * Report whether the work a previous run started is still running.
   *
   * While busy, the max-wait cap suppresses its run rather than starting a second one alongside the
   * first. Reporting completion releases exactly one suppressed run immediately, so the work the cap
   * promised still happens — just serialised behind the run that was already in flight.
   *
   * @param busy - True when a run is in flight, false when it has finished.
   */
  setInProgress: (busy: boolean) => void;
}

/**
 * Create a {@link MaxWaitDebounce}.
 *
 * @param delayMs - Default trailing debounce delay: how long after the last call the run fires, for
 *   calls that do not name one of their own.
 * @param maxWaitMs - Maximum time the run may be postponed while calls keep arriving.
 * @returns A debounce controller with `schedule`, `cancel`, `flush` and `setInProgress`.
 */
export function createMaxWaitDebounce(delayMs: number, maxWaitMs: number): MaxWaitDebounce {
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRun: (() => void) | null = null;
  let inProgress = false;
  let deferredByProgress = false;

  const disarm = (): void => {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    pendingRun = null;
    deferredByProgress = false;
  };

  // `inProgress` deliberately survives cancel(): it mirrors the caller's own run lifecycle, which
  // cancel does not control. Clearing it would claim a run had finished while it is still in flight.
  const cancel = disarm;

  const fire = (): void => {
    const run = pendingRun;
    disarm();
    run?.();
  };

  const onMaxWaitElapsed = (): void => {
    // The timer has fired, so it no longer needs disarming; the next schedule() re-arms it.
    maxWaitTimer = null;
    if (inProgress) {
      // Suppress rather than run: the forced refresh must not stack a second run on the one already
      // going. The flag is the promise to run this work as soon as that one reports completion.
      deferredByProgress = true;
      return;
    }
    fire();
  };

  const schedule = (run: () => void, trailingDelayMs?: number): void => {
    pendingRun = run;
    if (trailingTimer !== null) clearTimeout(trailingTimer);
    // The TRAILING timer deliberately does not consult `inProgress`. It fires only once activity has
    // actually stopped, which is when the caller most wants the latest state applied — and holding it
    // back would make an explicit, non-typing trigger (a file switch, a setting change) wait on a run
    // that may never report completion. The in-progress gate exists for the FORCED refresh during
    // continuous activity, which is the case that would otherwise stack runs indefinitely.
    //
    // Each call's own delay is used and none is remembered: a delay derived from a measurement is
    // only as good as the measurement was when the call was made, and carrying the previous call's
    // value forward would apply a figure the caller has since revised.
    trailingTimer = setTimeout(fire, trailingDelayMs ?? delayMs);
    // Arm the max-wait cap once per burst; deliberately not reset by later calls, and never derived
    // from the trailing delay — see the note on the interface about which interval may vary.
    if (maxWaitTimer === null) maxWaitTimer = setTimeout(onMaxWaitElapsed, maxWaitMs);
  };

  const flush = (): boolean => {
    if (pendingRun === null) return false;
    fire();
    return true;
  };

  const setInProgress = (busy: boolean): void => {
    inProgress = busy;
    if (busy || !deferredByProgress) return;
    deferredByProgress = false;
    // The cap already came due for this work, so it has waited long enough: run it now instead of
    // making it queue behind another full burst window.
    if (pendingRun !== null) fire();
  };

  return { schedule, cancel, flush, setInProgress };
}
