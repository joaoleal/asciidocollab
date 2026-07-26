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
});
