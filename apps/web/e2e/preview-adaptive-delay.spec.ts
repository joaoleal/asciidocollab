import { test, expect, type Page } from '@playwright/test';
import { PREVIEW_ADAPTIVE_MIN_MS, PREVIEW_DEBOUNCE_MS } from '@/lib/editor-config';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, openFile, editorContent, expandPreview } from './helpers/editor';

// How long an author waits between stopping typing and seeing the preview catch up.
//
// A single fixed trailing delay has to be sized for the worst document the editor might be given, so
// every other document pays that price: on a short file the render finishes in a few tens of
// milliseconds and then the preview sits still for the rest of half a second. Deriving the delay from
// what the last render actually cost is meant to collapse that gap at the small end without moving the
// large end, and this spec is the check on both halves of that claim at once.
//
// These are performance assertions, deliberately. They are stated against figures recorded before any
// of this work landed (`specs/043-preview-responsiveness/baseline.md`, section 2), taken the same way
// this spec measures — the same generated documents, the same in-page wait for the typed text to
// appear in the preview — so the two are comparable rather than merely similar.

/** The preview's rendered-output container: the only surface an author actually reads. */
const OUTPUT_SELECTOR = '[data-testid="asciidoc-output"]';

/** Where the in-page refresh timer parks its two instants on the page's global object. */
const TIMER_KEY = 'previewRefreshTiming';

/**
 * The document sizes measured, in source lines, and what each one's refresh must come in under.
 *
 * The small document's target is the criterion this feature set itself; the large one's is the
 * recorded pre-change median, which the change must not regress. Both are per-size because they say
 * different things: one is a promise about how live a short document feels, the other a promise that
 * buying it cost a long document nothing.
 */
const SMALL_DOCUMENT_LINES = 100;
const LARGE_DOCUMENT_LINES = 15_000;

/** The target for a short document: the refresh must land within this of the last keystroke. */
const SMALL_DOCUMENT_TARGET_MS = 200;

/**
 * The recorded pre-change median for the large document, in milliseconds.
 *
 * From section 2 of `specs/043-preview-responsiveness/baseline.md`: three samples of 1,059 / 1,075 /
 * 1,031 ms on the same generated 15,000-line document. The post-change figure must be no later.
 */
const LARGE_DOCUMENT_BASELINE_MS = 1059;

/** The recorded pre-change median for the short document, quoted so a run reports what it improved on. */
const SMALL_DOCUMENT_BASELINE_MS = 509;

/**
 * The widest the schedule's own choice of delay can make two refreshes of one document differ.
 *
 * It may wait anywhere between the floor and the ceiling, so two samples can honestly differ by that
 * much before any render variation is counted.
 */
const DELAY_RANGE_MS = PREVIEW_DEBOUNCE_MS - PREVIEW_ADAPTIVE_MIN_MS;

/**
 * How much of the liveliest sample is allowed as ordinary render-to-render variation on top.
 *
 * Proportional, and that is the point: a machine that renders this document in 400 ms varies by tens
 * of milliseconds between renders, one that takes 2,000 ms varies by hundreds, and a fixed allowance
 * would be either uselessly loose on the first or a guaranteed flake on the second. Half is generous
 * for variation and still far too tight to admit a queued render, which costs a whole extra render.
 */
const RENDER_VARIATION_SHARE = 0.5;

/**
 * Assert that a document's refreshes stayed together, whatever this machine's absolute speed.
 *
 * This is the machine-independent half of the claim and it runs everywhere, including where the
 * recorded baseline does not apply. Both figures come from the same machine, the same document and
 * the same run, so what it measures is the SCHEDULE rather than the hardware: a schedule that let a
 * render queue behind another, or that compounded its delay, separates its samples by more than its
 * own range of choices plus the variation of a render, on any hardware at all.
 *
 * @param samples - Every refresh measured for one document, in milliseconds.
 * @param lines - The document's size, for the failure message.
 */
function expectSamplesHoldTogether(samples: readonly number[], lines: number): void {
  const fastest = Math.min(...samples);
  const slowest = Math.max(...samples);
  const allowance = Math.round(DELAY_RANGE_MS + fastest * RENDER_VARIATION_SHARE);
  expect(
    slowest - fastest,
    `the ${lines}-line document's refreshes ranged from ${fastest} to ${slowest} ms after the last ` +
      `keystroke — a spread of ${slowest - fastest} ms, wider than the ${allowance} ms the schedule ` +
      `could account for (its ${DELAY_RANGE_MS} ms of choice, plus half the ${fastest} ms liveliest ` +
      'sample for render variation), so something is queueing behind something else',
  ).toBeLessThanOrEqual(allowance);
}

/** How many refreshes are timed per document. Odd, so the median is a measured sample and not a mean. */
const SAMPLES_PER_DOCUMENT = 5;

/** Budget for one refresh to land; generous, since a failure to appear at all is a different fault. */
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * A document of roughly `lines` lines, with enough structure that conversion has real work to do.
 *
 * Deliberately the same generator the baseline harness used (`e2e/baseline/preview-baseline.spec.ts`):
 * the figures this spec is compared against were taken on these documents, and comparing against a
 * different document would be comparing two different things.
 *
 * @param lines - How many source lines the document should have.
 * @param marker - Distinguishing text put in the title, so one document is told from the other.
 * @returns The AsciiDoc source.
 */
function sizedDocument(lines: number, marker: string): string {
  const out: string[] = [`= Sized Document ${marker}`, '', `A ${lines}-line document.`, ''];
  let index = 0;
  while (out.length < lines) {
    index += 1;
    out.push(
      `== Section ${index}`,
      '',
      `Prose for section ${index}, long enough that the converter has real text to lay out and`,
      'the paragraph is not a single short line.',
      '',
      '* a bullet',
      '* another bullet',
      '',
      '[source,ruby]',
      '----',
      `def method_${index}(argument)`,
      '  argument * 2',
      'end',
      '----',
      '',
    );
  }
  return `${out.slice(0, lines).join('\n')}\n`;
}

/**
 * The middle of a set of samples: the mean of the two central values for an even count.
 *
 * @param samples - The measured figures.
 * @returns The median, rounded to whole milliseconds.
 */
function medianMs(samples: readonly number[]): number {
  const sorted = samples.toSorted((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return Math.round(value);
}

/**
 * Arm an in-page timer that will measure from the LAST keystroke to `needle` appearing in the preview.
 *
 * Both instants are taken by the page itself. Starting the clock in the test process instead would
 * begin it whenever the driver's last `type` call returned, which is some unknown time after the
 * browser handled the keystroke — an interval that is not part of what an author waits for and would
 * quietly flatter every figure here. Recording the keystroke inside the page removes it: the start is
 * the keydown the browser dispatched, and the end is the frame on which the text was on screen.
 *
 * The keydown listener keeps overwriting its instant, so what remains when the text appears is the
 * last keystroke before the refresh — which is the one the trailing delay was measured from.
 *
 * @param page - The page to arm.
 * @param needle - Text that appears only once this refresh has landed.
 */
async function armRefreshTimer(page: Page, needle: string): Promise<void> {
  await page.evaluate(
    (options: { key: string; selector: string; text: string }) => {
      const timing = { lastKeystrokeAt: Number.NaN, shownAt: Number.NaN };
      Reflect.set(globalThis, options.key, timing);

      const onKeyDown = (): void => {
        timing.lastKeystrokeAt = performance.now();
      };
      document.addEventListener('keydown', onKeyDown, true);

      // Sampled per animation frame: what is measured is when the text was painted, which is the only
      // thing an author experiences. A mutation observer would report a DOM change that may not have
      // reached the screen for another frame.
      const watch = (): void => {
        const output = document.querySelector(options.selector);
        if (output?.textContent?.includes(options.text) === true) {
          timing.shownAt = performance.now();
          document.removeEventListener('keydown', onKeyDown, true);
          return;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    },
    { key: TIMER_KEY, selector: OUTPUT_SELECTOR, text: needle },
  );
}

/**
 * Wait for the armed refresh to land and report how long it took from the last keystroke.
 *
 * @param page - The page the timer was armed on.
 * @returns The elapsed milliseconds.
 */
async function readRefreshDelayMs(page: Page): Promise<number> {
  await page.waitForFunction(
    (key: string) => {
      const timing: unknown = Reflect.get(globalThis, key);
      if (typeof timing !== 'object' || timing === null) return false;
      return Number.isFinite(Reflect.get(timing, 'shownAt'));
    },
    TIMER_KEY,
    { timeout: REFRESH_TIMEOUT_MS },
  );
  const elapsed: unknown = await page.evaluate((key: string) => {
    const timing: unknown = Reflect.get(globalThis, key);
    if (typeof timing !== 'object' || timing === null) return Number.NaN;
    return Number(Reflect.get(timing, 'shownAt')) - Number(Reflect.get(timing, 'lastKeystrokeAt'));
  }, TIMER_KEY);
  const value = Number(elapsed);
  expect(Number.isFinite(value), 'the refresh landed but no keystroke was recorded before it').toBe(true);
  return value;
}

/**
 * Type a unique marker at the end of the open document and time the refresh that follows it.
 *
 * @param page - The page to type into.
 * @param needle - The marker, unique to this sample so a previous one cannot satisfy the wait.
 * @returns Milliseconds from the last keystroke to the marker being on screen in the preview.
 */
async function timeOneRefresh(page: Page, needle: string): Promise<number> {
  await editorContent(page).click();
  await page.keyboard.press('Control+End');
  // Armed after the navigation keystrokes, so the recorded start is a keystroke that actually changed
  // the document rather than the one that moved the caret.
  await armRefreshTimer(page, needle);
  await page.keyboard.type(`\n\n${needle}`);
  return readRefreshDelayMs(page);
}

/**
 * Measure a document's refresh delay several times over.
 *
 * @param page - The page with the document open and its preview showing.
 * @param label - Distinguishes this document's markers from the other's.
 * @returns Every sample, in the order taken.
 */
async function refreshSamples(page: Page, label: string): Promise<number[]> {
  const samples: number[] = [];
  for (let attempt = 1; attempt <= SAMPLES_PER_DOCUMENT; attempt += 1) {
    samples.push(Math.round(await timeOneRefresh(page, `REFRESH-${label}-${attempt}`)));
  }
  return samples;
}

/**
 * Print a measurement so a run reports what it measured, not merely that it passed.
 *
 * @param line - The line to write, without its newline.
 */
function report(line: string): void {
  process.stdout.write(`\n  ${line}\n`);
}

test.describe('preview refresh delay after the last keystroke', () => {
  // Wide per-test budget, and serial. These are timing measurements: run beside two other browser
  // workers they would measure contention for this machine and report it as the preview being slow,
  // and the recorded figures they are compared against were taken serially on an idle machine.
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Preview Delay ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('a short document refreshes within a fifth of a second of the last keystroke', async ({ page }) => {
    const name = `size-${SMALL_DOCUMENT_LINES}.adoc`;
    await createAdocFile(
      page,
      projectId,
      name,
      sizedDocument(SMALL_DOCUMENT_LINES, `size-${SMALL_DOCUMENT_LINES}`),
    );
    await openProject(page, projectId);
    await openFile(page, name, /Sized Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await expandPreview(page);
    await expect(page.locator(OUTPUT_SELECTOR)).toContainText(`A ${SMALL_DOCUMENT_LINES}-line document.`, {
      timeout: 60_000,
    });
    // Settle before measuring: the first render of a session pays for the engine's start-up, which is
    // not part of what an author waits for after a keystroke.
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: 60_000 });

    const samples = await refreshSamples(page, String(SMALL_DOCUMENT_LINES));
    const measured = medianMs(samples);
    report(
      `refresh after last keystroke, ${SMALL_DOCUMENT_LINES} lines: ${samples.join(', ')} ms → median ` +
        `${measured} ms (baseline ${SMALL_DOCUMENT_BASELINE_MS} ms, target ≤ ${SMALL_DOCUMENT_TARGET_MS} ms; ` +
        `the delay floor is ${PREVIEW_ADAPTIVE_MIN_MS} ms)`,
    );

    // Read the floor alongside this when it fails. The wait cannot be shorter than the configured
    // floor plus one render plus the paint, so a figure close to the target says the schedule is
    // right and the remaining time is the render; a figure far above it says the schedule is not
    // deriving its delay from what the render actually cost.
    expectSamplesHoldTogether(samples, SMALL_DOCUMENT_LINES);

    // Enforced EVERYWHERE, deliberately. This is the criterion the feature set itself, on a 100-line
    // document whose render is tens of milliseconds on any machine that can run the suite at all — so
    // unlike the large document's recorded median, almost none of this figure is hardware. Gating it
    // on the runner once seemed reasonable and was simply wrong: it let a real regression pass on CI
    // while still reporting green.
    expect(
      measured,
      `the median refresh landed ${measured} ms after the last keystroke, against a target of ` +
        `${SMALL_DOCUMENT_TARGET_MS} ms and a recorded ${SMALL_DOCUMENT_BASELINE_MS} ms. The shortest ` +
        `delay the schedule may choose is ${PREVIEW_ADAPTIVE_MIN_MS} ms, so ` +
        `${measured - PREVIEW_ADAPTIVE_MIN_MS} ms of this was the render and the paint`,
    ).toBeLessThanOrEqual(SMALL_DOCUMENT_TARGET_MS);
  });

  test('a very large document refreshes no later than it did before', async ({ page }) => {
    const name = `size-${LARGE_DOCUMENT_LINES}.adoc`;
    await createAdocFile(
      page,
      projectId,
      name,
      sizedDocument(LARGE_DOCUMENT_LINES, `size-${LARGE_DOCUMENT_LINES}`),
    );
    await openProject(page, projectId);
    await openFile(page, name, /Sized Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 60_000 });

    await expandPreview(page);
    await expect(page.locator(OUTPUT_SELECTOR)).toContainText(`A ${LARGE_DOCUMENT_LINES}-line document.`, {
      timeout: 120_000,
    });
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: 120_000 });

    const samples = await refreshSamples(page, String(LARGE_DOCUMENT_LINES));
    const measured = medianMs(samples);
    report(
      `refresh after last keystroke, ${LARGE_DOCUMENT_LINES} lines: ${samples.join(', ')} ms → median ` +
        `${measured} ms (baseline ${LARGE_DOCUMENT_BASELINE_MS} ms; the delay ceiling is ` +
        `${PREVIEW_DEBOUNCE_MS} ms)`,
    );

    // The other half of the claim. A document this expensive renders for longer than half the fixed
    // delay, so doubling its cost exceeds the ceiling and the schedule waits exactly what it always
    // did — making a short document livelier must not have been paid for by making a long one slower.
    expectSamplesHoldTogether(samples, LARGE_DOCUMENT_LINES);

    // Enforced everywhere. Gating this on the runner was a guess that measurement disproved: the
    // median is 471 ms against a recorded 1059 ms, and most of it is the schedule's own delay (capped
    // at PREVIEW_DEBOUNCE_MS) rather than the render, so even a runner half this speed lands well
    // inside the figure. The comparison was never as hardware-bound as the gate assumed.
    expect(
      measured,
      `the median refresh landed ${measured} ms after the last keystroke, against a recorded ` +
        `${LARGE_DOCUMENT_BASELINE_MS} ms. The longest delay the schedule may choose is ` +
        `${PREVIEW_DEBOUNCE_MS} ms, the same fixed delay this document waited before`,
    ).toBeLessThanOrEqual(LARGE_DOCUMENT_BASELINE_MS);
  });
});
