import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { PREVIEW_DEBOUNCE_MS, PREVIEW_MAX_WAIT_MS } from '@/lib/editor-config';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import {
  createAdocFile,
  setMainFile,
  openProject,
  openFile,
  editorContent,
  expandPreview,
} from './helpers/editor';

// Both preview formats refresh on a trailing debounce, so a burst of keystrokes collapses into one
// render once the typing stops. On its own that means an author who never pauses for longer than the
// trailing delay watches a preview that never moves: the render was postponed again by every
// keystroke, indefinitely. A maximum-wait cap bounds that postponement, so a sustained edit still
// refreshes while it is being typed.
//
// These specs drive real, uninterrupted typing and prove the refreshes happen DURING the burst — each
// one showing text entered after the previous one — rather than only after the typing stops. The last
// of them does it on a document slow enough that a scheduler stacking renders on top of each other
// would supersede its own results and show nothing at all until the burst ended.

// Resolved from the app root (Playwright's testDir is ./e2e). The page-formatted preview needs the
// vendored wasm engine to produce a PDF and the pdf.js worker to lay its text out in the DOM; without
// either there is nothing to observe, so that check gates on both.
const ENGINE_WASM_PATH = path.join(
  process.cwd(),
  'public',
  'vendor',
  'asciidoctor-pdf',
  'asciidoctor-pdf.wasm',
);
const PDF_WORKER_PATH = path.join(process.cwd(), 'public', 'vendor', 'pdfjs', 'pdf.worker.min.mjs');
const PAGE_PREVIEW_GATE_MESSAGE =
  'The page-formatted preview needs both the vendored Asciidoctor-PDF wasm engine ' +
  '(public/vendor/asciidoctor-pdf/asciidoctor-pdf.wasm) and the pdf.js worker ' +
  '(public/vendor/pdfjs/pdf.worker.min.mjs). Build them to run this check.';
const pagePreviewRenderable = existsSync(ENGINE_WASM_PATH) && existsSync(PDF_WORKER_PATH);

/**
 * How often a character is typed during a burst.
 *
 * A fifth of the trailing delay, so the debounce is restarted four times over before it could ever
 * elapse: the burst is uninterrupted by the only measure that matters here, and every refresh observed
 * during it was forced by the cap rather than granted by a pause. Derived from the configured delay so
 * the cadence follows it if it is retuned.
 */
const KEYSTROKE_INTERVAL_MS = Math.round(PREVIEW_DEBOUNCE_MS / 5);

/** Marker word typed into the document, e.g. `mk007 `; its trailing space separates it from the next. */
const MARKER_LENGTH = 6;
/** Finds a COMPLETE marker in previewed text; a half-typed one has no three digits and never matches. */
const MARKER_PATTERN = String.raw`mk(\d{3})`;

/**
 * How many refresh cycles a burst should span.
 *
 * One cycle is the cap interval, or one render when the document takes longer than that to render.
 * Five leaves ample room to observe several refreshes mid-burst without making the burst so long that
 * a slow document's test outgrows its budget.
 */
const BURST_REFRESH_CYCLES = 5;

/** Upper bound on a single burst, so an unexpectedly slow render cannot stretch a test indefinitely. */
const MAX_BURST_MS = 30_000;

/**
 * Fraction of a measured render cost that consecutive refreshes must still be apart.
 *
 * Renders of the same document vary by a few percent and the cost overlay reports only the most
 * recent one, so an exact floor would be asserting on that noise. The margin is wide enough to
 * absorb it and far too narrow to admit two renders running at once, which would roughly halve the
 * interval between refreshes.
 */
const SERIAL_REFRESH_MARGIN = 0.8;

/** Where the recorder parks its observations on the page's global object. */
const RECORDER_KEY = 'previewRefreshObservations';

/**
 * Size of the deliberately slow document, as a number of source blocks written in a language the
 * highlighter does not know.
 *
 * Sheer length is a poor way to make a render slow: fifteen thousand lines of prose convert in a
 * fraction of a second, and a document large enough to be slow that way produces so much HTML that
 * applying it is what dominates. Syntax highlighting is where the time actually goes, and an
 * unrecognised language costs the most — every known grammar is tried in turn to detect it. Enough
 * such blocks therefore render for seconds while staying small enough to type in comfortably.
 *
 * The size is calibrated against the engine, not fixed for good: the test asserts up front that one
 * render of this document really does outlast the cap, and says so when it stops doing so. That guard
 * fired when the conversion engine was replaced and the same document fell to 937 ms — under the cap,
 * which would have left the test passing while exercising none of the overlap it exists to rule out.
 * Re-calibrate whenever it fires again; never relax the guard.
 *
 * Two dimensions, and the difference between them is the whole reason this document is shaped the way
 * it is. Detection cost tracks the VOLUME OF CODE, while what makes the document unpleasant to type
 * into is its NUMBER OF LINES — so cost is bought with long lines rather than with more of them.
 * Simply enlarging the block count to reach the cap was tried and does not work: at 1,200 blocks the
 * render outlasts the cap but the editor stalls for over a second mid-burst, and a burst with a pause
 * that long in it proves nothing about sustained typing. At the density below the document renders for
 * roughly three seconds while staying near its original length.
 */
const SLOW_DOCUMENT_BLOCKS = 400;
/** Lines of code per block in the slow document. */
const SLOW_DOCUMENT_BLOCK_LINES = 8;
/**
 * How many times each code line's statement is repeated to form the line. This is the dimension that
 * carries the render cost, because it lengthens lines without adding any.
 */
const SLOW_DOCUMENT_LINE_REPEATS = 4;
/** A language the syntax highlighter has no grammar for, so it must detect one. */
const SLOW_DOCUMENT_LANGUAGE = 'pseudocode';

/** Budgets for the page-formatted preview, whose first render must compile and boot the wasm engine. */
const FIRST_PAGE_RENDER_TIMEOUT_MS = 120_000;
const PAGE_RENDER_SETTLE_TIMEOUT_MS = 60_000;
/** Budget for the first render of the slow document, which is large on purpose. */
const SLOW_FIRST_RENDER_TIMEOUT_MS = 90_000;

const SEED_DOCUMENT = [
  '= Continuous Typing',
  '',
  'A body paragraph the markers are appended to as they are typed.',
  '',
].join('\n');

/** One observed preview refresh: when the previewed text changed, and how far the typing had got. */
interface PreviewRefresh {
  /** Page-clock milliseconds at which the refresh landed. */
  readonly at: number;
  /** Highest complete marker number the preview showed, or 0 before any marker was rendered. */
  readonly marker: number;
}

/** What the in-page recorder saw during a burst. */
interface Recording {
  /** Every distinct previewed text, in the order they appeared. */
  readonly refreshes: readonly PreviewRefresh[];
  /** Page-clock milliseconds of each keystroke the browser received. */
  readonly keystrokes: readonly number[];
}

/**
 * Build a document that takes seconds to render, and whose rendered output is nonetheless small
 * enough that putting it on screen costs almost nothing.
 *
 * That separation is the point: the renderer must be the slow part, not the act of displaying what it
 * produced, or the typing itself would be what stalls and the burst would no longer be continuous.
 *
 * @param blockCount - How many source blocks to emit.
 * @returns The AsciiDoc source, ending in the line markers are appended to.
 */
function slowDocument(blockCount: number): string {
  const lines = ['= Slow Document', ''];
  for (let index = 1; index <= blockCount; index += 1) {
    lines.push(`[source,${SLOW_DOCUMENT_LANGUAGE}]`, '----');
    for (let line = 0; line < SLOW_DOCUMENT_BLOCK_LINES; line += 1) {
      const statement = `set value${line} to compute(${index}, ${line}) then keep each item where it is truthy`;
      lines.push(Array.from({ length: SLOW_DOCUMENT_LINE_REPEATS }, () => statement).join(' and then '));
    }
    lines.push('----', '');
  }
  lines.push('Markers land here.');
  return lines.join('\n');
}

/**
 * The text typed during a burst: numbered marker words, one keystroke at a time, enough of them to
 * keep typing for `durationMs`.
 *
 * @param durationMs - Roughly how long the burst should last.
 * @returns The string to type.
 */
function burstText(durationMs: number): string {
  const markerCount = Math.max(2, Math.ceil(durationMs / (KEYSTROKE_INTERVAL_MS * MARKER_LENGTH)));
  const markers: string[] = [];
  for (let index = 1; index <= markerCount; index += 1) {
    markers.push(`mk${String(index).padStart(3, '0')} `);
  }
  return markers.join('');
}

/**
 * Start watching a preview surface: record the page-clock time and marker progress of every distinct
 * previewed text, plus the time of every keystroke the browser receives.
 *
 * Reading the surface's own text is what makes this an observation rather than an assumption about the
 * scheduler — the only thing asserted on is what an author would have seen on screen, and when.
 *
 * @param page - The Playwright page.
 * @param containerSelector - The element whose text is the rendered preview.
 */
async function startRecording(page: Page, containerSelector: string): Promise<void> {
  await page.evaluate(
    (options) => {
      const container = document.querySelector(options.containerSelector);
      if (container === null) {
        throw new Error(`nothing matches ${options.containerSelector} to observe`);
      }
      const refreshes: { at: number; marker: number }[] = [];
      const keystrokes: number[] = [];
      Reflect.set(globalThis, options.key, { refreshes, keystrokes });

      const highestMarker = (text: string): number => {
        let highest = 0;
        for (const match of text.matchAll(new RegExp(options.markerPattern, 'g'))) {
          const value = Number(match[1]);
          if (value > highest) highest = value;
        }
        return highest;
      };

      let previous: string | null = null;
      const sample = (): void => {
        const text = container.textContent ?? '';
        if (text === previous) return;
        previous = text;
        refreshes.push({ at: performance.now(), marker: highestMarker(text) });
      };
      sample(); // the pre-burst baseline, so the first real refresh is recognisable as a change
      new MutationObserver(sample).observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      document.addEventListener('keydown', () => keystrokes.push(performance.now()), true);
    },
    { containerSelector, key: RECORDER_KEY, markerPattern: MARKER_PATTERN },
  );
}

/**
 * Read back what the recorder saw.
 *
 * @param page - The Playwright page the recorder was installed on.
 * @returns The observations, validated field by field.
 */
async function readRecording(page: Page): Promise<Recording> {
  const raw: unknown = await page.evaluate((key) => Reflect.get(globalThis, key), RECORDER_KEY);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('the preview recorder produced no observations');
  }
  const rawRefreshes = Reflect.get(raw, 'refreshes');
  const rawKeystrokes = Reflect.get(raw, 'keystrokes');
  if (!Array.isArray(rawRefreshes) || !Array.isArray(rawKeystrokes)) {
    throw new TypeError('the preview recorder produced observations of an unexpected shape');
  }
  const refreshes: PreviewRefresh[] = [];
  for (const entry of rawRefreshes) {
    refreshes.push({ at: Number(Reflect.get(entry, 'at')), marker: Number(Reflect.get(entry, 'marker')) });
  }
  return { refreshes, keystrokes: rawKeystrokes.map(Number) };
}

/**
 * What the last successful render cost, as the development-only cost overlay reports it.
 *
 * @param page - The Playwright page.
 * @param title - The overlay's title, which names the preview format it describes.
 * @param label - The row holding the whole-render figure.
 * @returns The figure in milliseconds, or -1 when the overlay has not reported one yet.
 */
async function reportedRenderCostMs(page: Page, title: string, label: string): Promise<number> {
  return page.evaluate((options): number => {
    const overlay = document.querySelector(`aside[aria-label="${options.title} render cost"]`);
    if (overlay === null) return -1;
    for (const term of overlay.querySelectorAll('dt')) {
      if (term.textContent !== options.label) continue;
      const figure = Number.parseInt(term.nextElementSibling?.textContent ?? '', 10);
      return Number.isFinite(figure) ? figure : -1;
    }
    return -1;
  }, { title, label });
}

/**
 * How long a burst should last to span {@link BURST_REFRESH_CYCLES} refreshes.
 *
 * A refresh cycle is the cap interval, or one whole render when the document takes longer than the cap
 * to render — the cap yields to a render already in flight, so a slow document refreshes at the pace it
 * can be rendered, not faster.
 *
 * @param renderCostMs - What one render of this document was measured to cost.
 * @returns The burst duration in milliseconds.
 */
function burstDurationMs(renderCostMs: number): number {
  const cycle = Math.max(PREVIEW_MAX_WAIT_MS, renderCostMs);
  return Math.min(MAX_BURST_MS, BURST_REFRESH_CYCLES * cycle);
}

/**
 * Assert a burst was genuinely uninterrupted: the browser received every character, and no two
 * consecutive keystrokes were far enough apart for the trailing debounce to elapse between them.
 *
 * Without this the whole exercise is worthless — a refresh observed after an accidental pause proves
 * only that the ordinary trailing debounce works.
 *
 * @param recording - What the recorder saw.
 * @param typed - The text that was typed.
 */
function expectUninterruptedTyping(recording: Recording, typed: string): void {
  expect(
    recording.keystrokes.length,
    'the browser must have received every character of the burst',
  ).toBeGreaterThanOrEqual(typed.length);
  let widestGapMs = 0;
  for (let index = 1; index < recording.keystrokes.length; index += 1) {
    const gap = recording.keystrokes[index] - recording.keystrokes[index - 1];
    if (gap > widestGapMs) widestGapMs = gap;
  }
  expect(
    widestGapMs,
    `typing paused for ${Math.round(widestGapMs)} ms — longer than the ${PREVIEW_DEBOUNCE_MS} ms trailing ` +
      'delay, so a refresh during this burst would prove nothing about sustained typing',
  ).toBeLessThan(PREVIEW_DEBOUNCE_MS);
}

/**
 * When the burst started and stopped, taken from the first and last keystroke the browser received.
 *
 * @param recording - What the recorder saw.
 * @returns The page-clock milliseconds bounding the burst.
 */
function burstWindow(recording: Recording): { readonly first: number; readonly last: number } {
  const first = recording.keystrokes[0];
  const last = recording.keystrokes.at(-1);
  if (first === undefined || last === undefined) throw new Error('no keystroke reached the browser');
  return { first, last };
}

/**
 * The refreshes that landed while the typing was still going on — strictly between the first and last
 * keystroke, so a refresh released by the burst ending does not count.
 *
 * @param recording - What the recorder saw.
 * @returns The mid-burst refreshes, in order.
 */
function refreshesDuringTyping(recording: Recording): readonly PreviewRefresh[] {
  const { first, last } = burstWindow(recording);
  return recording.refreshes.filter((refresh) => refresh.at > first && refresh.at < last);
}

/**
 * Assert the preview kept up with the typing: it refreshed repeatedly while the burst was still
 * running, and each of those refreshes showed a marker typed after the previous refresh had landed.
 *
 * The second half of that is what separates a real refresh from a re-paint of the same text: a preview
 * that only ever showed what was already on screen before the burst would satisfy a bare "it changed".
 *
 * @param during - The refreshes observed while typing continued.
 * @param format - How to name this preview format in a failure message.
 */
function expectRefreshedWhileTyping(during: readonly PreviewRefresh[], format: string): void {
  expect(
    during.length,
    `the ${format} preview must refresh while the typing continues, not only once it stops`,
  ).toBeGreaterThanOrEqual(2);
  expect(
    during[0].marker,
    `the first mid-burst ${format} refresh must show text typed during the burst`,
  ).toBeGreaterThanOrEqual(1);
  for (let index = 1; index < during.length; index += 1) {
    expect(
      during[index].marker,
      `each ${format} refresh must show text entered after the previous refresh`,
    ).toBeGreaterThan(during[index - 1].marker);
  }
}

test.describe('preview refresh during sustained typing', () => {
  // Wide per-test budget: a cold engine start, a large document, and bursts several refresh cycles long.
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Preview Refresh ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('the web-formatted preview refreshes while the author keeps typing', async ({ page }) => {
    const fileId = await createAdocFile(page, projectId, 'continuous.adoc', SEED_DOCUMENT);
    await setMainFile(page, projectId, fileId);
    await openProject(page, projectId);
    await openFile(page, 'continuous.adoc', /Continuous Typing/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await expandPreview(page);
    await expect(page.getByTestId('asciidoc-output')).toContainText('A body paragraph');
    // Settle first, so nothing left over from opening the panel is mistaken for a mid-burst refresh.
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: 30_000 });

    await editorContent(page).click();
    await page.keyboard.press('Control+End');

    await startRecording(page, '[data-testid="preview-scroll-container"]');
    const typed = burstText(burstDurationMs(await reportedRenderCostMs(page, 'Web preview', 'total')));
    await page.keyboard.type(typed, { delay: KEYSTROKE_INTERVAL_MS });

    const recording = await readRecording(page);
    expectUninterruptedTyping(recording, typed);
    expectRefreshedWhileTyping(refreshesDuringTyping(recording), 'web-formatted');
  });

  test('the page-formatted preview refreshes while the author keeps typing', async ({ page }) => {
    test.skip(!pagePreviewRenderable, PAGE_PREVIEW_GATE_MESSAGE);

    // The page-formatted preview renders the project's MAIN document, so the file being typed into has
    // to be that document for the typing to reach the rendered pages at all.
    const fileId = await createAdocFile(page, projectId, 'paged.adoc', SEED_DOCUMENT);
    await setMainFile(page, projectId, fileId);
    await openProject(page, projectId);
    await openFile(page, 'paged.adoc', /Continuous Typing/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await expandPreview(page);
    await page.getByTestId('preview-mode-pdf').click();
    const pages = page.locator('[aria-label="Rendered PDF pages"]');
    // The laid-out text of the first render — the engine produced a PDF and pdf.js placed its glyphs.
    await expect(pages).toContainText('A body paragraph', { timeout: FIRST_PAGE_RENDER_TIMEOUT_MS });
    await expect(page.locator('[aria-label="PDF preview"][aria-busy="true"]')).toHaveCount(0, {
      timeout: PAGE_RENDER_SETTLE_TIMEOUT_MS,
    });

    await editorContent(page).click();
    await page.keyboard.press('Control+End');

    await startRecording(page, '[aria-label="Rendered PDF pages"]');
    const typed = burstText(burstDurationMs(await reportedRenderCostMs(page, 'Page preview', 'render')));
    await page.keyboard.type(typed, { delay: KEYSTROKE_INTERVAL_MS });

    const recording = await readRecording(page);
    expectUninterruptedTyping(recording, typed);
    expectRefreshedWhileTyping(refreshesDuringTyping(recording), 'page-formatted');
  });

  test('a slow document refreshes one render at a time and keeps refreshing', async ({ page }) => {
    const fileId = await createAdocFile(page, projectId, 'slow.adoc', slowDocument(SLOW_DOCUMENT_BLOCKS));
    await setMainFile(page, projectId, fileId);
    await openProject(page, projectId);
    await openFile(page, 'slow.adoc', /Slow Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 60_000 });

    await page.getByRole('button', { name: /expand preview/i }).click();
    await expect(page.getByTestId('asciidoc-output')).toContainText('Markers land here.', {
      timeout: SLOW_FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: SLOW_FIRST_RENDER_TIMEOUT_MS });

    // This check is only meaningful on a document that takes longer to render than the cap interval:
    // that is the case where a refresh released on every cap expiry would overlap the render still
    // running, and where holding it back instead is visible from outside.
    const renderCostMs = await reportedRenderCostMs(page, 'Web preview', 'total');
    expect(
      renderCostMs,
      'the cost overlay must report what a render of this document costs',
    ).toBeGreaterThan(0);
    expect(
      renderCostMs,
      `one render of this document takes ${renderCostMs} ms, which is under the ${PREVIEW_MAX_WAIT_MS} ms ` +
        'cap interval — enlarge the document so renders genuinely outlast the cap',
    ).toBeGreaterThan(PREVIEW_MAX_WAIT_MS);

    await editorContent(page).click();
    await page.keyboard.press('Control+End');

    await startRecording(page, '[data-testid="preview-scroll-container"]');
    const typed = burstText(burstDurationMs(renderCostMs));
    await page.keyboard.type(typed, { delay: KEYSTROKE_INTERVAL_MS });

    const recording = await readRecording(page);
    expectUninterruptedTyping(recording, typed);

    // Refreshes keep coming for as long as the typing does — AND each one is a completed render whose
    // result was still current when it arrived. A schedule that released a refresh on every cap expiry
    // regardless of the one already running would have several renders outstanding at once; every
    // result but the last is then superseded before it lands and is discarded, so this preview would
    // have sat unchanged for the whole burst instead of showing the marker sequence advance.
    const during = refreshesDuringTyping(recording);
    expectRefreshedWhileTyping(during, 'web-formatted');

    // Still refreshing at the end of the burst, not just at the start of it.
    const { first, last } = burstWindow(recording);
    const midpoint = first + (last - first) / 2;
    expect(
      during.filter((refresh) => refresh.at > midpoint).length,
      'refreshes must keep coming for as long as the typing does, not stop after the first one',
    ).toBeGreaterThanOrEqual(1);

    // No two refreshes landed closer together than a single render of this document takes, which is
    // what serialised renders look like from outside: each one had to finish before the next began.
    // The floor is the cheaper of the two measurements of the same document — the first render is
    // taken cold and reads high — with a margin for the few percent the engine's own figures move
    // between runs. Two renders overlapping would halve the interval, nowhere near that margin.
    const warmRenderCostMs = Math.min(renderCostMs, await reportedRenderCostMs(page, 'Web preview', 'total'));
    for (let index = 1; index < during.length; index += 1) {
      expect(
        during[index].at - during[index - 1].at,
        'two refreshes landed closer together than one render of this document takes',
      ).toBeGreaterThanOrEqual(warmRenderCostMs * SERIAL_REFRESH_MARGIN);
    }
  });
});
