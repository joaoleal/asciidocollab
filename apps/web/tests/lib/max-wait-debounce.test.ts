import { createMaxWaitDebounce } from '@/lib/max-wait-debounce';

describe('createMaxWaitDebounce', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('fires once, delayMs after the last call in a quiet burst', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run);
    jest.advanceTimersByTime(400);
    expect(run).not.toHaveBeenCalled();

    // A fresh call restarts the trailing timer.
    debounce.schedule(run);
    jest.advanceTimersByTime(400);
    expect(run).not.toHaveBeenCalled();

    jest.advanceTimersByTime(100); // 500ms since the last call
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs the most recently scheduled callback only', () => {
    const first = jest.fn();
    const second = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(first);
    jest.advanceTimersByTime(100);
    debounce.schedule(second);
    jest.advanceTimersByTime(500);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('forces a run after maxWaitMs when calls keep arriving faster than delayMs', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    // Re-schedule every 400ms (< 500ms trailing delay) so the trailing timer never elapses.
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    // 2000ms of continuous typing has elapsed → the max-wait cap must have fired exactly once.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh max-wait window after each fire', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run);
    jest.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);

    // A new burst caps at maxWaitMs measured from its own first call, not the previous one.
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel() drops a pending run', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run);
    debounce.cancel();
    jest.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it('suppresses the forced run while the previous run is still in progress', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.setInProgress(true);
    // Keep typing past the cap: the cap elapses, but starting a second run while the first is still
    // in flight would break the one-run-at-a-time invariant, so it must be held back.
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the suppressed work immediately once the in-progress run reports it finished', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.setInProgress(true);
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    expect(run).not.toHaveBeenCalled();

    // No timer advance: the deferred work is owed and must not wait for another window.
    debounce.setInProgress(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps enforcing the cap on later bursts after a suppressed one', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.setInProgress(true);
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    debounce.setInProgress(false);
    expect(run).toHaveBeenCalledTimes(1);

    // A suppression must not consume the guarantee for the rest of the session: the next burst of
    // continuous typing is capped exactly like the first.
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not run early when a run finishes with nothing suppressed', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.setInProgress(true);
    debounce.schedule(run);
    jest.advanceTimersByTime(100);
    debounce.setInProgress(false);
    expect(run).not.toHaveBeenCalled();

    // The pending run still belongs to the trailing timer.
    jest.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops suppressed work so a later completion does not revive it', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.setInProgress(true);
    for (let elapsed = 0; elapsed < 2000; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    debounce.cancel();

    debounce.setInProgress(false);
    jest.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it('flush() runs the pending callback immediately, bypassing both timers', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run);
    debounce.flush();
    expect(run).toHaveBeenCalledTimes(1);

    // Both timers are disarmed by the flush, so nothing runs a second time.
    jest.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush() runs the latest scheduled callback and is a no-op with nothing pending', () => {
    const first = jest.fn();
    const second = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    debounce.schedule(first);
    debounce.schedule(second);
    debounce.flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    debounce.flush();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('flush() starts a fresh burst window', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run);
    jest.advanceTimersByTime(1900);
    debounce.flush();
    expect(run).toHaveBeenCalledTimes(1);

    // The cap of the new burst is measured from its own first call: a cap left over from the flushed
    // burst would elapse 100ms into this one.
    for (let elapsed = 0; elapsed < 1600; elapsed += 400) {
      debounce.schedule(run);
      jest.advanceTimersByTime(400);
    }
    expect(run).toHaveBeenCalledTimes(1);

    debounce.schedule(run);
    jest.advanceTimersByTime(400); // 2000ms into the new burst
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits the per-call trailing delay in place of the constructed one', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run, 120);
    jest.advanceTimersByTime(119);
    expect(run).not.toHaveBeenCalled();

    // The constructed 500ms would still have 380ms to go here.
    jest.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('falls back to the constructed trailing delay when a later call names none', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run, 120);
    debounce.schedule(run);
    jest.advanceTimersByTime(120);
    expect(run).not.toHaveBeenCalled();

    // Each call carries its own delay; the previous call's shorter one is not remembered.
    jest.advanceTimersByTime(380);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('applies the newest per-call trailing delay when calls name different ones', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run, 400);
    jest.advanceTimersByTime(100);
    // A cheaper measurement arrives mid-burst: the restarted timer runs on the new delay, so this
    // fires 120ms after THIS call rather than 400ms after it.
    debounce.schedule(run, 120);
    jest.advanceTimersByTime(120);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('measures the max-wait cap from the burst regardless of the per-call trailing delays', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    // Every call names a different trailing delay and every one of them is restarted before it can
    // elapse, so nothing but the cap can fire — and the cap must still come due 2000ms after the
    // FIRST call, not be pushed out or pulled in by whatever delay the latest call asked for.
    const delays = [400, 120, 300, 200, 480];
    for (let elapsed = 0; elapsed < 1900; elapsed += 100) {
      debounce.schedule(run, delays[(elapsed / 100) % delays.length]);
      jest.advanceTimersByTime(100);
    }
    expect(run).not.toHaveBeenCalled();

    debounce.schedule(run, 480);
    jest.advanceTimersByTime(100); // 2000ms into the burst
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lets the trailing run start once activity stops, even with a run still in progress', () => {
    const run = jest.fn();
    const debounce = createMaxWaitDebounce(500, 2000);

    debounce.schedule(run);
    jest.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
    debounce.setInProgress(true);

    debounce.schedule(run);
    jest.advanceTimersByTime(500);

    // The in-progress gate is on the FORCED refresh, which is what would otherwise stack runs while
    // activity continues. The trailing timer fires only once activity has actually stopped — the
    // moment the caller most wants the latest state applied — and an explicit trigger must not be
    // made to wait on a run that may never report completion.
    expect(run).toHaveBeenCalledTimes(2);
  });
});
