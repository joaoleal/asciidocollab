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
  getEditorText,
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
 * Renders of the same document vary by a few percent, so an exact floor would be asserting on that
 * noise. The margin is wide enough to absorb it and far too narrow to admit two renders running at
 * once, which would roughly halve the interval between refreshes.
 */
const SERIAL_REFRESH_MARGIN = 0.8;

/** Where the recorder parks its observations on the page's global object. */
const RECORDER_KEY = 'previewRefreshObservations';

/** Where the recorder parks the teardown for its current installation, so a retry can replace it. */
const RECORDER_TEARDOWN_KEY = 'previewRefreshRecorderTeardown';

/**
 * How many times a burst is attempted before its interruption is treated as a real fault.
 *
 * The burst is the harness setting up the condition the claim is about, and a single unlucky stall —
 * a GC pause, another worker landing on the same core — says nothing about the preview. Retrying makes
 * the setup deterministic instead of probabilistic. It is deliberately NOT a way to tolerate a busy
 * main thread: a thread genuinely too busy for the author to type is one of the failures this feature
 * exists to prevent, so exhausting every attempt still FAILS, loudly and with every attempt's widest
 * gap in the message.
 */
const SUSTAINED_BURST_ATTEMPTS = 3;

/** Where the single-refresh timer parks its two instants on the page's global object. */
const REFRESH_TIMER_KEY = 'previewRefreshCostTiming';

/**
 * Words typed to time one refresh.
 *
 * Deliberately nothing like a marker: they are left in the document when the burst starts, and a
 * word matching {@link MARKER_PATTERN} would be counted as one and wreck the marker sequence the
 * burst is judged on.
 */
const FIRST_PROBE_WORD = 'refreshprobealpha';
const SECOND_PROBE_WORD = 'refreshprobebeta';

/**
 * Size of the deliberately slow document, as a number of source blocks.
 *
 * Sheer length is a poor way to make a render slow: fifteen thousand lines of prose convert in a
 * fraction of a second, and a document large enough to be slow that way produces so much HTML that
 * applying it is what dominates. Syntax highlighting is where the time actually goes — every other
 * stage was measured and none of them approaches it. Conversion of a 1 MiB document is around 20 ms;
 * tables, admonitions, cross-references, attribute expansion, `ifeval` and a three-thousand-file
 * include tree are all in the same band. The highlighter is the only stage whose cost is measured in
 * hundreds of milliseconds, so the document is built out of what makes it work hardest.
 *
 * The size is calibrated against the engine, not fixed for good: the test asserts up front that one
 * render of this document really does outlast the cap, and says so when it stops doing so. That guard
 * fired when the conversion engine was replaced and the same document fell to 937 ms — under the cap,
 * which would have left the test passing while exercising none of the overlap it exists to rule out.
 * Re-calibrate whenever it fires again; never relax the guard.
 *
 * It fired a second time, and the recalibration changed the document's SHAPE rather than its size,
 * because what used to make it slow no longer exists. The blocks used to declare a language the
 * highlighter had never heard of, and the cost was auto-detection: every installed grammar tried in
 * turn. The render worker no longer guesses at an unknown language — it leaves the block alone, the
 * way the exporters' own highlighter does for a lexer it lacks — so those blocks became free and the
 * same 400-block document fell from roughly three seconds to 21 ms.
 *
 * What replaces it is a grammar the highlighter really has, given input that is expensive to SCAN and
 * yields almost nothing to mark up: a deeply nested parenthesis expression in Ruby. Measured at
 * 0.75 ms per KiB of source, linear in length over an eightfold range (no backtracking blow-up — the
 * cost is honest scanning), while the HTML it produces is only 1.02x the source, because the scan
 * ends up emitting hardly any token spans.
 *
 * That last ratio is the reason for this shape rather than a bigger version of the old one. Every
 * other way of buying highlighter time buys output with it: colouring ordinary code in Ruby, YAML or
 * Lisp emits a span per token and inflates the HTML two- to eightfold, so reaching the cap that way
 * needs 7 MiB or more of markup per refresh — and then applying it is what dominates, the typing
 * stalls, and the overlap this test exists to rule out can no longer be observed. Cost without output
 * is what the document needs, and paren-dense text in a real grammar is where it is found.
 *
 * Two dimensions, and the difference between them is the whole reason this document is shaped the way
 * it is. Highlighting cost tracks the VOLUME OF CODE, while what makes the document unpleasant to type
 * into is its NUMBER OF LINES — so cost is bought with long lines rather than with more of them.
 * Simply enlarging the block count to reach the cap was tried and does not work: at 1,200 blocks the
 * render outlasts the cap but the editor stalls for over a second mid-burst, and a burst with a pause
 * that long in it proves nothing about sustained typing.
 *
 * The volume it now takes does not fit in one file, and that is a hard limit rather than a preference:
 * the content endpoint refuses a body over a mebibyte, which is why the previous version of this
 * document sat at 922 KiB — right under it. So the document is a BOOK: a main file that includes its
 * parts, each part comfortably inside the limit, previewed with include bodies shown. That is the
 * shape a document this size really has, and it moves the volume off the surface being typed into
 * entirely — the editor holds the main file's handful of lines, so the "unpleasant to type into"
 * dimension stops competing with the cost one. At the size below the assembled document is measured
 * at roughly 2.7 seconds against the 2-second cap, from a browser, by the guard below.
 */
const SLOW_DOCUMENT_PARTS = 5;
/**
 * Source blocks per included part.
 *
 * Two ceilings meet here. Each part is one PUT to the content endpoint, whose body limit is a
 * mebibyte — at this count a part is about 826 KiB, a fifth under it. And the assembled total is what
 * has to outlast the cap: 400 blocks measured 2,173 ms in a browser against the 2,000 ms cap, close
 * enough that a slightly quicker machine would trip the guard for no reason, so the count is set
 * where the margin is about a quarter rather than a twelfth.
 */
const SLOW_DOCUMENT_BLOCKS_PER_PART = 100;
/** Blocks in the assembled document — what the render actually costs. */
const SLOW_DOCUMENT_BLOCKS = SLOW_DOCUMENT_PARTS * SLOW_DOCUMENT_BLOCKS_PER_PART;
/** Lines of code per block in the slow document. */
const SLOW_DOCUMENT_BLOCK_LINES = 8;
/**
 * How many times each code line's statement is repeated to form the line. This is the dimension that
 * carries the render cost, because it lengthens lines without adding any.
 */
const SLOW_DOCUMENT_LINE_REPEATS = 20;
/** A language the syntax highlighter HAS a grammar for, so every block is really scanned. */
const SLOW_DOCUMENT_LANGUAGE = 'ruby';
/**
 * The expression each code line is built from: nested parentheses, which the grammar has to consider
 * against every construct it knows and which resolve to almost no tokens. See the note above on why
 * the cost has to come without matching output.
 */
const SLOW_DOCUMENT_STATEMENT = '((((((((((a)(b))((c)(d))))((((e)(f))((g)(h)))))))))';

/** Budgets for the page-formatted preview, whose first render must compile and boot the wasm engine. */
const FIRST_PAGE_RENDER_TIMEOUT_MS = 120_000;
const PAGE_RENDER_SETTLE_TIMEOUT_MS = 60_000;
/** Budget for the first render of the slow document, which is large on purpose. */
const SLOW_FIRST_RENDER_TIMEOUT_MS = 90_000;
/** Budget for one timed refresh of an ordinary document; a refresh that never lands is a real fault. */
const REFRESH_MEASUREMENT_TIMEOUT_MS = 60_000;

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

/** The file name of one included part of the slow document. */
function slowDocumentPartName(part: number): string {
  return `slow-part-${part}.adoc`;
}

/**
 * One included part of the slow document: the source blocks that carry the render cost.
 *
 * Its rendered output is nonetheless nearly the same size as its source, which is the point: the
 * renderer must be the slow part, not the act of displaying what it produced, or the typing itself
 * would be what stalls and the burst would no longer be continuous.
 *
 * @param part - Which part this is, so no two parts are byte-identical.
 * @returns The part's AsciiDoc source.
 */
function slowDocumentPart(part: number): string {
  const lines: string[] = [];
  for (let index = 1; index <= SLOW_DOCUMENT_BLOCKS_PER_PART; index += 1) {
    lines.push(`[source,${SLOW_DOCUMENT_LANGUAGE}]`, '----');
    for (let line = 0; line < SLOW_DOCUMENT_BLOCK_LINES; line += 1) {
      // The leading triple keeps every line distinct, so nothing downstream can answer for one line by
      // remembering another; the repeated expression after it is what carries the cost.
      const repeated = Array.from({ length: SLOW_DOCUMENT_LINE_REPEATS }, () => SLOW_DOCUMENT_STATEMENT);
      lines.push(`(item ${part} ${index} ${line}) ${repeated.join(' ')}`);
    }
    lines.push('----', '');
  }
  return lines.join('\n');
}

/**
 * The main file of the slow document: a title, the includes, and the line markers are appended to.
 *
 * Small on purpose. It is the file the editor holds open and the burst types into, so everything that
 * makes the RENDER expensive lives in the parts it includes rather than in the text being edited.
 *
 * @returns The main file's AsciiDoc source.
 */
function slowDocumentMain(): string {
  const lines = ['= Slow Document', ''];
  for (let part = 1; part <= SLOW_DOCUMENT_PARTS; part += 1) {
    lines.push(`include::${slowDocumentPartName(part)}[]`, '');
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
      // Tear down any previous installation first: a burst may be retried, and a stacked observer /
      // listener pair would keep writing into the abandoned recording.
      const previousTeardown = Reflect.get(globalThis, options.teardownKey);
      if (typeof previousTeardown === 'function') previousTeardown();
      const observer = new MutationObserver(sample);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      const onKeydown = (): void => {
        keystrokes.push(performance.now());
      };
      document.addEventListener('keydown', onKeydown, true);
      Reflect.set(globalThis, options.teardownKey, () => {
        observer.disconnect();
        document.removeEventListener('keydown', onKeydown, true);
      });
    },
    { containerSelector, key: RECORDER_KEY, teardownKey: RECORDER_TEARDOWN_KEY, markerPattern: MARKER_PATTERN },
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
 * Time one whole refresh of the open document — from the keystroke that asked for it to the changed
 * text being on screen — and report what the RENDER part of that wait cost.
 *
 * This is measured rather than read off the application because the only figure the application
 * publishes is the development-only cost overlay, which is deliberately absent from a production
 * build; a check that depends on it means one thing in a development build and nothing in the build
 * the gate runs. What is measured here is instead the same thing in both: a refresh an author would
 * have watched happen.
 *
 * The preview must be idle when this is called, so the wait measured is one scheduled delay plus one
 * render and nothing else. Both instants are taken inside the page — the start is the keydown the
 * browser dispatched, not whenever the driver's `type` call returned — and the end is sampled per
 * animation frame, so what is timed is when the text was actually painted.
 *
 * What comes back is a LOWER BOUND on the render, and deliberately so. The whole wait is the
 * trailing delay the schedule chose plus the render, and the delay it chose is at most
 * {@link PREVIEW_DEBOUNCE_MS} — that is the ceiling of the adaptive delay, and a document slow
 * enough to matter here is clamped to exactly it. Subtracting the ceiling can therefore only ever
 * understate the render, never flatter it, which is the direction a guard that must not be talked
 * out of firing needs to err in.
 *
 * @param page - The Playwright page, with the document open and its preview settled.
 * @param containerSelector - The element whose text is the rendered preview.
 * @param probe - A word to type that does not already appear in the preview.
 * @param timeoutMs - How long to wait for the refresh; a refresh that never lands is a different fault.
 * @returns Milliseconds, floored at zero: at least what one render of this document costs.
 */
async function measuredRenderCostMs(
  page: Page,
  containerSelector: string,
  probe: string,
  timeoutMs: number,
): Promise<number> {
  await editorContent(page).click();
  await page.keyboard.press('Control+End');
  await page.evaluate(
    (options: { key: string; selector: string; probe: string }) => {
      const container = document.querySelector(options.selector);
      if (container === null) {
        throw new Error(`nothing matches ${options.selector} to observe`);
      }
      if ((container.textContent ?? '').includes(options.probe)) {
        throw new Error(`the preview already shows "${options.probe}", so its arrival cannot be timed`);
      }
      const timing = { lastKeystrokeAt: Number.NaN, shownAt: Number.NaN };
      Reflect.set(globalThis, options.key, timing);

      // Overwritten by every keystroke, so what remains when the text lands is the last one before
      // the refresh — the keystroke the trailing delay was actually counted from.
      const onKeyDown = (): void => {
        timing.lastKeystrokeAt = performance.now();
      };
      document.addEventListener('keydown', onKeyDown, true);

      // Re-queried each frame rather than held: a preview surface that is replaced on re-render
      // would leave a captured node detached, watching an element nothing writes to any more.
      const watch = (): void => {
        const surface = document.querySelector(options.selector);
        if ((surface?.textContent ?? '').includes(options.probe)) {
          timing.shownAt = performance.now();
          document.removeEventListener('keydown', onKeyDown, true);
          return;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    },
    { key: REFRESH_TIMER_KEY, selector: containerSelector, probe },
  );

  await page.keyboard.type(probe);
  await page.waitForFunction(
    (key: string) => {
      const timing: unknown = Reflect.get(globalThis, key);
      if (typeof timing !== 'object' || timing === null) return false;
      return Number.isFinite(Reflect.get(timing, 'shownAt'));
    },
    REFRESH_TIMER_KEY,
    { timeout: timeoutMs },
  );
  const measured: unknown = await page.evaluate((key: string) => {
    const timing: unknown = Reflect.get(globalThis, key);
    if (typeof timing !== 'object' || timing === null) return Number.NaN;
    return Number(Reflect.get(timing, 'shownAt')) - Number(Reflect.get(timing, 'lastKeystrokeAt'));
  }, REFRESH_TIMER_KEY);
  const wholeWaitMs = Number(measured);
  expect(
    Number.isFinite(wholeWaitMs),
    'the refresh landed but no keystroke was recorded before it',
  ).toBe(true);
  return Math.max(0, wholeWaitMs - PREVIEW_DEBOUNCE_MS);
}

/**
 * Print a measurement, so a run reports what this document cost rather than only that it passed —
 * the figure to re-calibrate against when the guard below it finally fires.
 *
 * @param line - The line to write, without its newline.
 */
function report(line: string): void {
  process.stdout.write(`\n  ${line}\n`);
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
 * The longest pause between two consecutive keystrokes of a burst.
 *
 * @param recording - What the recorder saw.
 * @returns The widest gap in milliseconds, or 0 when fewer than two keystrokes were seen.
 */
function widestKeystrokeGapMs(recording: Recording): number {
  let widest = 0;
  for (let index = 1; index < recording.keystrokes.length; index += 1) {
    const gap = recording.keystrokes[index] - recording.keystrokes[index - 1];
    if (gap > widest) widest = gap;
  }
  return widest;
}

/**
 * Delete back to `pristine`, one character at a time, checking the document after each.
 *
 * Deliberately NOT a count of what was typed. One of the two things that sends a burst round again is
 * the browser having received FEWER keystrokes than were sent — so on exactly the runs this is needed,
 * the number typed overstates the number that landed, and deleting that many eats into the fixture the
 * burst was appended to. Every later attempt would then be typing into a document the caller never
 * measured, which is the outcome restoring exists to prevent.
 *
 * Reading the document back is also what makes over-deletion impossible to do quietly: shrinking past
 * `pristine` throws here rather than surviving as a smaller experiment that still reports green.
 *
 * @param page - The Playwright page with the document open.
 * @param pristine - The editor text to restore, as {@link getEditorText} reads it.
 * @param maxDeletions - Upper bound on characters to remove; exceeding it is a harness fault.
 */
async function restoreDocument(page: Page, pristine: string, maxDeletions: number): Promise<void> {
  // Read ONCE to size the deletion, and once more to confirm it. Checking the document after every
  // character is the obvious way to write this and it is a trap: it costs a round trip per character,
  // which on a loaded CI runner spent the test's whole budget before it could reach the error it
  // exists to report — turning a clear "the burst was interrupted" into a bare timeout. The count
  // still comes from the DOCUMENT rather than from what was typed, which is the whole point.
  const current = await getEditorText(page);
  const excess = current.length - pristine.length;
  if (excess <= 0) {
    if (current === pristine) return;
    throw new Error(
      `restoring the document overshot: it is now ${current.length} characters against the ` +
        `${pristine.length} it started at, so the burst would be typed into a document the caller ` +
        'never measured',
    );
  }
  if (excess > maxDeletions) {
    throw new Error(
      `the document grew by ${excess} characters, more than the ${maxDeletions} the burst typed — ` +
        'something other than this harness is editing it',
    );
  }

  for (let index = 0; index < excess; index += 1) {
    await page.keyboard.press('Backspace');
  }

  const restored = await getEditorText(page);
  if (restored !== pristine) {
    throw new Error(
      `the document did not return to what the render cost was measured against after ${excess} ` +
        `deletions (${restored.length} characters against ${pristine.length})`,
    );
  }
}

/**
 * Type a burst into the open document and return what the preview did during it, retrying until the
 * burst was genuinely uninterrupted.
 *
 * A burst only proves something about SUSTAINED typing if no two consecutive keystrokes were far
 * enough apart for the trailing debounce to elapse between them — otherwise a refresh observed during
 * it shows only that the ordinary trailing debounce works. That precondition is the harness's job to
 * establish, so it is retried rather than asserted once and hoped for.
 *
 * Exhausting the attempts is a FAILURE, never a skip: the preview being unable to keep up with an
 * author is precisely the fault this spec guards, and skipping on it would hide the regression while
 * still reporting green.
 *
 * Each attempt RESTORES the document first, so every attempt is the same experiment. Left in place,
 * attempt 2 would type into a document twice the size while `renderCostMs` — and so the burst length
 * derived from it — still described the smaller one, making the retry measure something the caller
 * never asked about and its outcome depend on which attempt happened to succeed.
 *
 * @param page - The Playwright page with the document open and its preview showing.
 * @param containerSelector - The preview surface to observe.
 * @param renderCostMs - One measured refresh of this document, which sizes the burst.
 * @returns The recording of the sustained burst and the text that produced it.
 */
async function recordSustainedBurst(
  page: Page,
  containerSelector: string,
  renderCostMs: number,
): Promise<{ recording: Recording; typed: string }> {
  const attempts: string[] = [];
  // The document as the caller measured it — captured once, before anything is typed, so every attempt
  // is restored to the same text rather than to whatever the previous attempt left behind.
  const pristine = await getEditorText(page);
  let typedLastAttempt = 0;
  for (let attempt = 1; attempt <= SUSTAINED_BURST_ATTEMPTS; attempt += 1) {
    if (typedLastAttempt > 0) await restoreDocument(page, pristine, typedLastAttempt);
    await startRecording(page, containerSelector);
    const typed = burstText(burstDurationMs(renderCostMs));
    typedLastAttempt = typed.length;
    await page.keyboard.type(typed, { delay: KEYSTROKE_INTERVAL_MS });
    const recording = await readRecording(page);
    const receivedEveryCharacter = recording.keystrokes.length >= typed.length;
    const widestGapMs = widestKeystrokeGapMs(recording);
    if (receivedEveryCharacter && widestGapMs < PREVIEW_DEBOUNCE_MS) {
      return { recording, typed };
    }
    attempts.push(
      `attempt ${attempt}: ${recording.keystrokes.length}/${typed.length} keystrokes, ` +
        `widest pause ${Math.round(widestGapMs)} ms`,
    );
  }
  throw new Error(
    `could not type a sustained burst in ${SUSTAINED_BURST_ATTEMPTS} attempts — every one paused ` +
      `longer than the ${PREVIEW_DEBOUNCE_MS} ms trailing delay, so the preview never kept up with ` +
      `the typing (${attempts.join('; ')})`,
  );
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

    // Size the burst against one timed refresh of this document, so it spans several of them however
    // fast or slow the machine running it is.
    const renderCostMs = await measuredRenderCostMs(
      page,
      '[data-testid="asciidoc-output"]',
      FIRST_PROBE_WORD,
      REFRESH_MEASUREMENT_TIMEOUT_MS,
    );

    const { recording } = await recordSustainedBurst(
      page,
      '[data-testid="preview-scroll-container"]',
      renderCostMs,
    );

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

    const renderCostMs = await measuredRenderCostMs(
      page,
      '[aria-label="Rendered PDF pages"]',
      FIRST_PROBE_WORD,
      PAGE_RENDER_SETTLE_TIMEOUT_MS,
    );

    const { recording } = await recordSustainedBurst(
      page,
      '[aria-label="Rendered PDF pages"]',
      renderCostMs,
    );

    expectRefreshedWhileTyping(refreshesDuringTyping(recording), 'page-formatted');
  });

  test('a slow document refreshes one render at a time and keeps refreshing', async ({ page }) => {
    for (let part = 1; part <= SLOW_DOCUMENT_PARTS; part += 1) {
      await createAdocFile(page, projectId, slowDocumentPartName(part), slowDocumentPart(part));
    }
    const fileId = await createAdocFile(page, projectId, 'slow.adoc', slowDocumentMain());
    await setMainFile(page, projectId, fileId);
    await openProject(page, projectId);
    await openFile(page, 'slow.adoc', /Slow Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 60_000 });

    await page.getByRole('button', { name: /expand preview/i }).click();
    await expect(page.getByTestId('asciidoc-output')).toContainText('Markers land here.', {
      timeout: SLOW_FIRST_RENDER_TIMEOUT_MS,
    });
    // Show the included bodies. Hidden, each include is one placeholder block and the preview renders
    // the main file's five lines — nothing this test is about. The volume that makes a render outlast
    // the cap is in the parts, so it only reaches the renderer once they are being rendered.
    await page.getByTestId('show-includes-toggle').click();
    await expect(page.getByTestId('asciidoc-output')).toContainText('(item 1 1 0)', {
      timeout: SLOW_FIRST_RENDER_TIMEOUT_MS,
    });
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: SLOW_FIRST_RENDER_TIMEOUT_MS });

    // This check is only meaningful on a document that takes longer to render than the cap interval:
    // that is the case where a refresh released on every cap expiry would overlap the render still
    // running, and where holding it back instead is visible from outside. So the document is timed
    // first, twice — the cheaper of two timings of the same document is what everything below is
    // stated against, because the first render off a settled panel reads high and a floor built on a
    // high reading would fail on renders that were perfectly well serialised.
    const outputSelector = '[data-testid="asciidoc-output"]';
    const firstTimingMs = await measuredRenderCostMs(
      page,
      outputSelector,
      FIRST_PROBE_WORD,
      SLOW_FIRST_RENDER_TIMEOUT_MS,
    );
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: SLOW_FIRST_RENDER_TIMEOUT_MS });
    const secondTimingMs = await measuredRenderCostMs(
      page,
      outputSelector,
      SECOND_PROBE_WORD,
      SLOW_FIRST_RENDER_TIMEOUT_MS,
    );
    await expect(page.locator('[aria-label="up to date"]')).toBeVisible({ timeout: SLOW_FIRST_RENDER_TIMEOUT_MS });
    const renderCostMs = Math.round(Math.min(firstTimingMs, secondTimingMs));
    report(
      `one render of the ${SLOW_DOCUMENT_BLOCKS}-block document: at least ` +
        `${Math.round(firstTimingMs)} / ${Math.round(secondTimingMs)} ms → ${renderCostMs} ms taken, ` +
        `against the ${PREVIEW_MAX_WAIT_MS} ms cap it must outlast`,
    );

    // The figure is a lower bound on the render (the scheduled delay was subtracted at its ceiling),
    // so clearing the cap here means the real render clears it by at least as much — and a document
    // that has quietly become cheap enough to render inside the cap cannot slip past by reading as
    // one that has not. See the note on the document's size for what to do when this fires.
    expect(
      renderCostMs,
      `one render of this document takes at least ${renderCostMs} ms, which is under the ` +
        `${PREVIEW_MAX_WAIT_MS} ms cap interval — enlarge the document so renders genuinely outlast the cap`,
    ).toBeGreaterThan(PREVIEW_MAX_WAIT_MS);

    const { recording } = await recordSustainedBurst(
      page,
      '[data-testid="preview-scroll-container"]',
      renderCostMs,
    );


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
    // The floor is the cheaper of the two timings taken above, with a margin for the few percent one
    // render of the same document moves from the next. Two renders overlapping would halve the
    // interval, nowhere near that margin.
    for (let index = 1; index < during.length; index += 1) {
      expect(
        during[index].at - during[index - 1].at,
        'two refreshes landed closer together than one render of this document takes',
      ).toBeGreaterThanOrEqual(renderCostMs * SERIAL_REFRESH_MARGIN);
    }
  });
});
