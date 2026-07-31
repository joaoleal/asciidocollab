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
    const delays = samples.map(adaptiveDelayMs);
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
});
