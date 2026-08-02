import { PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS } from '@/lib/editor-config';
import { adaptiveDelayMs } from '@/lib/preview/adaptive-delay';

describe('adaptiveDelayMs', () => {
  it('uses the documented default bounds under the test environment', () => {
    // The table below is written against these defaults; pin them so a changed
    // default shows up here rather than as a puzzling failure further down.
    expect(PREVIEW_ADAPTIVE_MIN_MS).toBe(120);
    expect(PREVIEW_DEBOUNCE_MS).toBe(500);
  });

  it('falls back to the fixed debounce when no render has been measured yet', () => {
    expect(adaptiveDelayMs(null)).toBe(PREVIEW_DEBOUNCE_MS);
  });

  it('gives a cheap render twice its own cost to settle', () => {
    expect(adaptiveDelayMs(100)).toBe(200);
  });

  it('never waits less than the floor, however fast the last render was', () => {
    expect(adaptiveDelayMs(30)).toBe(PREVIEW_ADAPTIVE_MIN_MS);
    expect(adaptiveDelayMs(0)).toBe(PREVIEW_ADAPTIVE_MIN_MS);
  });

  it('never waits longer than the fixed debounce, however slow the last render was', () => {
    expect(adaptiveDelayMs(250)).toBe(PREVIEW_DEBOUNCE_MS);
    expect(adaptiveDelayMs(600)).toBe(PREVIEW_DEBOUNCE_MS);
    expect(adaptiveDelayMs(60_000)).toBe(PREVIEW_DEBOUNCE_MS);
  });

  it('reaches the floor and the ceiling exactly at the doubling boundaries', () => {
    expect(adaptiveDelayMs(PREVIEW_ADAPTIVE_MIN_MS / 2)).toBe(PREVIEW_ADAPTIVE_MIN_MS);
    expect(adaptiveDelayMs(PREVIEW_DEBOUNCE_MS / 2)).toBe(PREVIEW_DEBOUNCE_MS);
  });

  it('never shortens the wait as the last render gets more expensive', () => {
    const samples = [0, 30, 59, 60, 61, 100, 175, 249, 250, 251, 600];
    // Called one argument at a time on purpose: passed as the mapper directly, each sample would
    // arrive with its array index as the bounds, and the delays being compared would be the ones no
    // caller ever asks for.
    const delays = samples.map((sample) => adaptiveDelayMs(sample));
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1]);
    }
  });

  it('is pure: the same measurement always yields the same delay', () => {
    expect(adaptiveDelayMs(100)).toBe(adaptiveDelayMs(100));
    expect(adaptiveDelayMs(null)).toBe(adaptiveDelayMs(null));
  });

  it('treats a nonsensical negative measurement as the floor rather than a negative wait', () => {
    expect(adaptiveDelayMs(-1)).toBe(PREVIEW_ADAPTIVE_MIN_MS);
  });

  it('answers a crossed pair of bounds with the floor, whatever the measurement was', () => {
    // Bounds where the floor sits above the ceiling are a misconfiguration — an operator can produce
    // them by setting one surface's ceiling below the shared floor. There is no delay that honours
    // both, so what matters is that the same mistake gives the same answer every time: a rule that
    // picked whichever bound the measurement happened to fall outside would return a wait below the
    // floor for one document and above the ceiling for the next, from one configuration. The floor is
    // the bound that is held, because it is the one protecting the machine from re-rendering on every
    // keystroke; overshooting the ceiling only makes the preview lazier than intended.
    const crossed = { minMs: 800, maxMs: 300 };

    expect(adaptiveDelayMs(50, crossed)).toBe(800);
    expect(adaptiveDelayMs(200, crossed)).toBe(800);
    expect(adaptiveDelayMs(5000, crossed)).toBe(800);
  });
});
