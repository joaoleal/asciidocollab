import { test, expect, type Page } from '@playwright/test';
import { MAX_ENGINE_REBUILDS, RENDER_WORKER_IDLE_RETENTION_MS } from '@/lib/editor-config';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import {
  createAdocFile,
  openProject,
  openFile,
  editorContent,
  collapsePreview,
} from './helpers/editor';

// The render engine is built once and held across everything that would otherwise throw it away, and
// the panel that uses it is mounted and unmounted constantly — another file, the other preview format,
// the panel closed and reopened. These specs drive exactly those moments and assert what an author
// would see and wait for: no panel that goes blank or claims the file cannot be previewed, no engine
// built a second time, an engine that comes back on its own when it dies, and a bounded number of
// attempts before the app says so and stops.
//
// Everything below is observed through the page: what was painted in the preview panel, and how many
// times the browser was asked to construct the render worker. The second of those is the platform's
// own record of an engine being started — it is not a look inside the holder, which is deliberately
// module-private and has no way of reporting its state.

/** The preview's rendered-output container. */
const OUTPUT_SELECTOR = '[data-testid="asciidoc-output"]';
/** The preview panel, which is where the whole of a switch plays out. */
const PANEL_SELECTOR = '[data-testid="preview-panel"]';
/** The message reserved for a file this panel genuinely cannot render. */
const UNAVAILABLE_MESSAGE = 'Preview not available for this file type';

/** Where the render-worker probe parks what it has seen on the page's global object. */
const PROBE_KEY = 'renderEngineStarts';
/** Where the panel watcher parks what it has seen on the page's global object. */
const PANEL_WATCH_KEY = 'previewPanelObservations';

/** How long a wait for previewed text may run before it is called a failure. */
const CONTENT_WAIT_TIMEOUT_MS = 60_000;

/** How many times a file is opened in the switching check; enough that a per-switch fault must show. */
const FILE_SWITCHES = 6;

/**
 * The recorded pre-change median time-to-content on a file switch, in milliseconds.
 *
 * From section 3 of `specs/043-preview-responsiveness/baseline.md`, taken the same way this spec
 * measures: the same two document sizes, the same alternation, timed in the page from the click to
 * the new file's text appearing in the preview.
 */
const BASELINE_FILE_SWITCH_MEDIAN_MS = 665;

/** The criterion is at least a halving of the recorded median. */
const FILE_SWITCH_TARGET_MS = Math.floor(BASELINE_FILE_SWITCH_MEDIAN_MS / 2);

/** Document sizes the file-switch measurement alternates between, in source lines — as recorded. */
const SWITCH_SIZES: readonly number[] = [100, 1500];

/** How many switches the measurement samples, matching the recorded baseline's four. */
const SWITCH_SAMPLES = 4;

/**
 * A document of roughly `lines` lines, with enough structure that conversion has real work to do.
 *
 * Deliberately the same generator the baseline harness used (`e2e/baseline/preview-baseline.spec.ts`):
 * the recorded figure this spec is compared against was taken on these documents, and a comparison
 * against a different document would be a comparison of two different things.
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
 * A short previewable document whose body text identifies it.
 *
 * @param title - The document title.
 * @param body - The paragraph the preview is checked for.
 * @returns The AsciiDoc source.
 */
function shortDocument(title: string, body: string): string {
  return [`= ${title}`, '', body, '', '== A Section', '', 'Some prose under a heading.', ''].join('\n');
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
  const value =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return Math.round(value);
}

/**
 * Watch every render worker the page constructs, for as long as the page lives.
 *
 * Installed before any of the application's own code runs. Wrapping the platform's `Worker`
 * constructor is what makes "the engine was started again" observable at all: the holder keeps its
 * worker in module scope with nothing exported that would report on it, and the alternative — timing
 * alone — cannot tell a cheap start from no start at all.
 *
 * A worker is recognised as the render engine by what it is SENT rather than by the name its chunk
 * happens to have: the engine is the worker that receives render requests (`requestId` + `content`).
 * The bundler names the chunk, and that name differs between development and production builds; the
 * protocol does not. No other worker in this app is sent that shape.
 *
 * @param page - The page to install the probe on.
 */
async function installRenderEngineProbe(page: Page): Promise<void> {
  await page.addInitScript((recordsKey: string) => {
    const NativeWorker = globalThis.Worker;
    const records: { url: string; startedAt: number; isEngine: boolean; worker: Worker }[] = [];
    Reflect.set(globalThis, recordsKey, records);

    class ProbedWorker extends NativeWorker {
      /**
       * Construct a worker and record it.
       *
       * @param scriptUrl - The worker entry point.
       * @param options - The worker options, passed through untouched.
       */
      constructor(scriptUrl: string | URL, options?: WorkerOptions) {
        super(scriptUrl, options);
        const record = {
          url: String(scriptUrl),
          startedAt: performance.now(),
          isEngine: false,
          worker: this,
        };
        records.push(record);
        const nativePostMessage = NativeWorker.prototype.postMessage.bind(this);
        Reflect.set(this, 'postMessage', (message: unknown, transfer?: Transferable[]) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'requestId' in message &&
            'content' in message
          ) {
            record.isEngine = true;
          }
          return transfer === undefined
            ? nativePostMessage(message)
            : nativePostMessage(message, transfer);
        });
      }
    }

    Reflect.set(globalThis, 'Worker', ProbedWorker);
  }, PROBE_KEY);
}

/**
 * How many render engines this page has started since it loaded.
 *
 * @param page - The page the probe was installed on.
 * @returns The count, or -1 when the probe is not there.
 */
async function renderEngineStarts(page: Page): Promise<number> {
  return page.evaluate((key: string) => {
    const records: unknown = Reflect.get(globalThis, key);
    if (!Array.isArray(records)) return -1;
    return records.filter((record) => Reflect.get(record, 'isEngine') === true).length;
  }, PROBE_KEY);
}

/**
 * Kill the render engine the way the browser does when a worker dies: stop the thread, then report it.
 *
 * `terminate()` is the real death — the worker is gone, and every render posted to it afterwards
 * falls into a void — but a worker the page terminated is one the page is not told about, because it
 * is assumed to know. The `error` event is how the browser reports a worker that died on its own, and
 * it is the only channel the holder supervises. Delivering it here is not a stand-in for the failure:
 * the engine really is dead either way, and this is the notification the browser would have sent.
 *
 * @param page - The page whose engine is killed.
 */
async function killRenderEngine(page: Page): Promise<void> {
  const killed = await page.evaluate((key: string) => {
    const records: unknown = Reflect.get(globalThis, key);
    if (!Array.isArray(records)) return false;
    const latest = records.findLast((record) => Reflect.get(record, 'isEngine') === true);
    if (latest === undefined) return false;
    const worker: unknown = Reflect.get(latest, 'worker');
    if (!(worker instanceof Worker)) return false;
    worker.terminate();
    worker.dispatchEvent(new ErrorEvent('error', { message: 'the render engine was terminated' }));
    return true;
  }, PROBE_KEY);
  expect(killed, 'an engine must have been started before it can be terminated').toBe(true);
}

/**
 * Wait until the preview's rendered output contains `needle`, and return how long that took.
 *
 * Timed inside the page, so the figure is the browser's own view of when the content appeared rather
 * than a round trip through the driver. Sampled per animation frame: what is measured is when the
 * text was on screen, which is the only thing an author experiences.
 *
 * @param page - The page to watch.
 * @param needle - Text that appears only in the document being waited for.
 * @returns The elapsed milliseconds.
 */
async function millisecondsUntilPreviewShows(page: Page, needle: string): Promise<number> {
  const elapsed = await page.evaluate(
    async (options: { selector: string; text: string; timeoutMs: number }) => {
      const startedAt = performance.now();
      const deadline = startedAt + options.timeoutMs;
      for (;;) {
        const output = document.querySelector(options.selector);
        if (output?.textContent?.includes(options.text) === true) return performance.now() - startedAt;
        if (performance.now() > deadline) return Number.NaN;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    },
    { selector: OUTPUT_SELECTOR, text: needle, timeoutMs: CONTENT_WAIT_TIMEOUT_MS },
  );
  expect(Number.isNaN(elapsed), `the preview never showed "${needle}"`).toBe(false);
  return elapsed;
}

/** How long a switch took to reach the editor and then the preview. */
interface SwitchTiming {
  /** Milliseconds until the newly opened document's text was in the editor. */
  readonly editorMs: number;
  /** Milliseconds until it was in the preview. */
  readonly previewMs: number;
}

/**
 * Time a file switch to the editor and to the preview at once, from the same instant.
 *
 * Both are measured because only the pair says where the wait went. The preview cannot show a document
 * the editor has not received yet, so the editor figure is the floor under it, and the gap between the
 * two is the only part the preview is responsible for.
 *
 * @param page - The page to watch.
 * @param editorNeedle - Text that appears only in the newly opened document's editor view.
 * @param previewNeedle - Text that appears only in its rendered output.
 * @returns Both elapsed times, in milliseconds.
 */
async function millisecondsUntilSwitchLands(
  page: Page,
  editorNeedle: string,
  previewNeedle: string,
): Promise<SwitchTiming> {
  const timing = await page.evaluate(
    async (options: {
      output: string;
      editor: string;
      previewText: string;
      editorText: string;
      timeoutMs: number;
    }) => {
      const startedAt = performance.now();
      const deadline = startedAt + options.timeoutMs;
      let editorMs = Number.NaN;
      let previewMs = Number.NaN;
      for (;;) {
        const editor = document.querySelector(options.editor);
        const output = document.querySelector(options.output);
        if (Number.isNaN(editorMs) && editor?.textContent?.includes(options.editorText) === true) {
          editorMs = performance.now() - startedAt;
        }
        if (output?.textContent?.includes(options.previewText) === true) {
          previewMs = performance.now() - startedAt;
          return { editorMs, previewMs };
        }
        if (performance.now() > deadline) return { editorMs, previewMs };
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    },
    {
      output: OUTPUT_SELECTOR,
      editor: '.cm-editor .cm-content',
      previewText: previewNeedle,
      editorText: editorNeedle,
      timeoutMs: CONTENT_WAIT_TIMEOUT_MS,
    },
  );
  expect(Number.isNaN(timing.previewMs), `the preview never showed "${previewNeedle}"`).toBe(false);
  return timing;
}

/** One moment at which the preview panel showed something no author should see between two files. */
interface PanelViolation {
  /** Which fault was on screen. */
  readonly kind: string;
  /** Page-clock milliseconds at which it was first seen. */
  readonly at: number;
}

/**
 * Start watching the preview panel for faults, sampling once per animation frame.
 *
 * Per frame rather than per DOM mutation on purpose: a state that appears and disappears inside one
 * frame was never painted, so nobody saw it, and calling that a blank panel would be asserting on
 * React's internals instead of on the product. Everything a frame boundary catches is something that
 * reached the screen.
 *
 * @param page - The page whose panel is watched.
 */
async function watchPreviewPanel(page: Page): Promise<void> {
  await page.evaluate(
    (options: { key: string; panel: string; output: string; unavailable: string }) => {
      const violations: { kind: string; at: number }[] = [];
      Reflect.set(globalThis, options.key, violations);
      const seen = new Set<string>();
      const note = (kind: string): void => {
        if (seen.has(kind)) return;
        seen.add(kind);
        violations.push({ kind, at: performance.now() });
      };
      const sample = (): void => {
        const panel = document.querySelector(options.panel);
        if (panel !== null) {
          if ((panel.textContent ?? '').includes(options.unavailable)) note('preview-unavailable-message');
          // The header's status word for a failed render, shown for exactly as long as the error
          // callout beneath it.
          if (panel.querySelector('[aria-label="preview error"]') !== null) note('render-error');
          if (panel.querySelector('[data-testid="engine-failure-notice"]') !== null) {
            note('engine-failure-notice');
          }
          const output = panel.querySelector(options.output);
          if (output === null || (output.textContent ?? '').trim() === '') note('blank-panel');
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    {
      key: PANEL_WATCH_KEY,
      panel: PANEL_SELECTOR,
      output: OUTPUT_SELECTOR,
      unavailable: UNAVAILABLE_MESSAGE,
    },
  );
}

/**
 * Read back what the panel watcher saw.
 *
 * @param page - The page the watcher was installed on.
 * @returns The faults, first sighting of each.
 */
async function previewPanelViolations(page: Page): Promise<readonly PanelViolation[]> {
  const raw: unknown = await page.evaluate((key: string) => Reflect.get(globalThis, key), PANEL_WATCH_KEY);
  if (!Array.isArray(raw)) throw new TypeError('the preview panel watcher produced no observations');
  return raw.map((entry) => ({
    kind: String(Reflect.get(entry, 'kind')),
    at: Number(Reflect.get(entry, 'at')),
  }));
}

/**
 * Open the preview panel and measure how long it took for the document to appear in it.
 *
 * @param page - The page whose panel is expanded.
 * @param needle - Text that appears only in the document being waited for.
 * @returns The elapsed milliseconds.
 */
async function millisecondsToExpandAndShow(page: Page, needle: string): Promise<number> {
  await page.getByRole('button', { name: /expand preview/i }).click();
  return millisecondsUntilPreviewShows(page, needle);
}

// The two "does not start the engine again" tests below once carried a second, timing-based corollary
// alongside the construction count: the returned panel had to reach its content in less than a
// measured engine start-up, on the reasoning that a repeated start-up would show up as extra time.
// That corollary is gone, and deliberately so.
//
// It only ever meant anything while a start-up was expensive enough to be told apart from noise, and
// the conversion engine's move to a pure-JavaScript implementation ended that: start-up now costs
// about 46–54 ms on this stack, straddling the 50 ms floor the comparison needed, so the corollary
// passed or failed on which side of it a given run happened to land. That is an outcome of the
// upgrade rather than a defect in the panel — the cost the corollary existed to prove was being
// avoided has itself very nearly gone away.
//
// Nothing is lost by dropping it. The construction count is the stronger of the two claims either
// way: it asserts directly that exactly one engine was ever built across the round trip, where the
// timing could only infer it from a duration, and a duration can be short for reasons that have
// nothing to do with how many engines were started.

/**
 * Print a measurement so a run reports what it measured, not merely that it passed.
 *
 * @param line - The line to write, without its newline.
 */
function report(line: string): void {
  process.stdout.write(`\n  ${line}\n`);
}

test.describe('preview across file, format and panel switches', () => {
  // Wide per-test budget: a cold engine start on a development build, plus several switches and, in
  // one case, four engine deaths and a rebuild after each.
  //
  // Serial for the sake of the figures. One of these tests compares a measured time against a recorded
  // baseline that was taken serially on an otherwise idle machine, and the rest print timings a reader
  // is meant to be able to trust; running them beside two other browser workers would measure
  // contention for this machine and report it as the preview being slow.
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    // Before any navigation: the probe has to be in place before the application constructs anything.
    await installRenderEngineProbe(page);
    await signIn(page);
    projectId = await createProject(page, `Preview Switch ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('switching between two AsciiDoc files never blanks the preview or calls it unavailable', async ({
    page,
  }) => {
    await createAdocFile(page, projectId, 'alpha.adoc', shortDocument('Alpha', 'Body text of alpha.'));
    await createAdocFile(page, projectId, 'beta.adoc', shortDocument('Beta', 'Body text of beta.'));
    await openProject(page, projectId);
    await openFile(page, 'alpha.adoc', /Alpha/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await millisecondsToExpandAndShow(page, 'Body text of alpha.');
    // Watch only from here: a panel with nothing rendered in it yet is not a panel that went blank,
    // and the first render is the moment there is something for a switch to preserve.
    await watchPreviewPanel(page);

    for (let round = 1; round <= FILE_SWITCHES; round += 1) {
      const target = round % 2 === 1 ? 'beta' : 'alpha';
      await openFile(page, `${target}.adoc`);
      await millisecondsUntilPreviewShows(page, `Body text of ${target}.`);
    }

    const violations = await previewPanelViolations(page);
    expect(
      violations.map((violation) => violation.kind),
      'the preview panel must show neither a fault nor an empty document while switching between two ' +
        'previewable files',
    ).toEqual([]);

    // The switching was real: the panel ends on the other document, having been through every round.
    await expect(page.getByTestId('asciidoc-output')).toContainText('Body text of alpha.');
    expect(await renderEngineStarts(page), 'switching file must not start another engine').toBe(1);
  });

  test('returning from the page-formatted preview does not start the engine again', async ({ page }) => {
    await createAdocFile(page, projectId, 'formats.adoc', shortDocument('Formats', 'Body text of formats.'));
    await openProject(page, projectId);
    await openFile(page, 'formats.adoc', /Formats/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    const coldMs = await millisecondsToExpandAndShow(page, 'Body text of formats.');
    expect(await renderEngineStarts(page), 'the first preview starts one engine').toBe(1);

    // The page-formatted preview replaces the web-formatted panel outright, so the engine's only
    // consumer goes away here — the moment a consumer-counted lifetime would shut it down.
    await page.getByTestId('preview-mode-pdf').click();
    await expect(page.locator(OUTPUT_SELECTOR)).toHaveCount(0);

    await page.getByTestId('preview-mode-html').click();
    const warmMs = await millisecondsUntilPreviewShows(page, 'Body text of formats.');

    expect(
      await renderEngineStarts(page),
      'coming back to the web-formatted preview must reuse the engine, not start a second one',
    ).toBe(1);

    report(
      `web → page → web: cold first content ${Math.round(coldMs)} ms, on return ${Math.round(warmMs)} ms; ` +
        'one engine built for both',
    );
  });

  test('closing the preview panel and reopening it does not start the engine again', async ({ page }) => {
    await createAdocFile(page, projectId, 'panel.adoc', shortDocument('Panel', 'Body text of panel.'));
    await openProject(page, projectId);
    await openFile(page, 'panel.adoc', /Panel/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    const coldMs = await millisecondsToExpandAndShow(page, 'Body text of panel.');
    expect(await renderEngineStarts(page), 'the first preview starts one engine').toBe(1);

    // Closing the panel unmounts it entirely: no preview format is on screen and the engine has no
    // consumer at all. This is the case a consumer-counted lifetime breaks silently — the count reaches
    // zero, the worker is destroyed, and reopening pays for a whole new engine while looking identical.
    const closedAt = Date.now();
    await collapsePreview(page);
    await expect(page.getByTestId('preview-panel')).toHaveAttribute('aria-label', 'expand preview');

    const warmMs = await millisecondsToExpandAndShow(page, 'Body text of panel.');
    const closedForMs = Date.now() - closedAt;

    // The panel was shut for a fraction of the retention window, so this measures retention working —
    // not a reopen that happened to beat a worker still being torn down.
    expect(
      closedForMs,
      'the panel must be reopened well inside the retention window for this to prove anything',
    ).toBeLessThan(RENDER_WORKER_IDLE_RETENTION_MS / 2);

    expect(
      await renderEngineStarts(page),
      'reopening the panel must pick the engine up again, not start a second one',
    ).toBe(1);

    report(
      `panel closed for ${closedForMs} ms and reopened: cold first content ${Math.round(coldMs)} ms, ` +
        `on reopen ${Math.round(warmMs)} ms; one engine built for both`,
    );
  });

  test('an engine that dies is rebuilt on its own and the preview keeps updating', async ({ page }) => {
    await createAdocFile(page, projectId, 'revive.adoc', shortDocument('Revive', 'Body text of revive.'));
    await openProject(page, projectId);
    await openFile(page, 'revive.adoc', /Revive/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await millisecondsToExpandAndShow(page, 'Body text of revive.');
    expect(await renderEngineStarts(page)).toBe(1);

    await killRenderEngine(page);

    // No reload, no reopening of the panel: type into the document exactly as an author would and the
    // preview must show it. Nothing else could — the engine that rendered everything up to here is
    // gone, so the only way this text is converted is a replacement that started by itself.
    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nTyped after the engine died.');
    const recoveredMs = await millisecondsUntilPreviewShows(page, 'Typed after the engine died.');

    report(`engine death → preview updating again in ${Math.round(recoveredMs)} ms with no reload`);

    expect(await renderEngineStarts(page), 'the dead engine must be replaced by exactly one other').toBe(2);
    await expect(page.getByTestId('engine-failure-notice')).toHaveCount(0);
  });

  test('repeated deaths stop after the bounded rebuilds and leave a notice with a retry', async ({ page }) => {
    await createAdocFile(page, projectId, 'bounded.adoc', shortDocument('Bounded', 'Body text of bounded.'));
    await openProject(page, projectId);
    await openFile(page, 'bounded.adoc', /Bounded/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });

    await millisecondsToExpandAndShow(page, 'Body text of bounded.');
    expect(await renderEngineStarts(page)).toBe(1);

    // One death more than the budget allows for: the last one is the one that must NOT be answered
    // with another engine.
    for (let death = 1; death <= MAX_ENGINE_REBUILDS + 1; death += 1) {
      await killRenderEngine(page);
    }

    const notice = page.getByTestId('engine-failure-notice');
    await expect(notice).toBeVisible();
    const startsAtFailure = await renderEngineStarts(page);
    expect(
      startsAtFailure,
      `the engine must be rebuilt ${MAX_ENGINE_REBUILDS} times and then no more`,
    ).toBe(1 + MAX_ENGINE_REBUILDS);

    // It has stopped, rather than being between attempts: left alone for several times the whole
    // sequence's duration, nothing further is started. A rebuild loop would be spinning here.
    await page.waitForTimeout(3000);
    expect(await renderEngineStarts(page), 'nothing may be rebuilt after the budget runs out').toBe(
      startsAtFailure,
    );

    // The way out is the author's to take, and it works: one more engine, the notice gone, renders
    // flowing again.
    await notice.getByRole('button', { name: /restart preview engine/i }).click();
    await expect(notice).toHaveCount(0);

    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nTyped after the manual retry.');
    await millisecondsUntilPreviewShows(page, 'Typed after the manual retry.');
    expect(await renderEngineStarts(page), 'the retry starts exactly one further engine').toBe(
      startsAtFailure + 1,
    );

    report(
      `${MAX_ENGINE_REBUILDS + 1} engine deaths: ${MAX_ENGINE_REBUILDS} automatic rebuilds, then a ` +
        'notice with a retry that starts one more',
    );
  });

  test('content appears on a file switch in at most half the recorded baseline time', async ({ page }) => {
    for (const size of SWITCH_SIZES) {
      await createAdocFile(page, projectId, `size-${size}.adoc`, sizedDocument(size, `size-${size}`));
    }
    await openProject(page, projectId);
    await openFile(page, `size-${SWITCH_SIZES[0]}.adoc`, /Sized Document/);
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
    await millisecondsToExpandAndShow(page, `A ${SWITCH_SIZES[0]}-line document.`);

    // The same alternation the baseline was taken with, from the same starting point: four switches
    // between the two documents, each timed from the click to the new document's text being on screen.
    const previewSamples: number[] = [];
    const editorSamples: number[] = [];
    for (let attempt = 0; attempt < SWITCH_SAMPLES; attempt += 1) {
      const target = SWITCH_SIZES[attempt % 2 === 0 ? 1 : 0];
      await openFile(page, `size-${target}.adoc`);
      const timing = await millisecondsUntilSwitchLands(
        page,
        `Sized Document size-${target}`,
        `A ${target}-line document.`,
      );
      previewSamples.push(Math.round(timing.previewMs));
      editorSamples.push(Math.round(timing.editorMs));
    }

    const measured = medianMs(previewSamples);
    report(
      `file switch time-to-content: ${previewSamples.join(', ')} ms → median ${measured} ms ` +
        `(baseline ${BASELINE_FILE_SWITCH_MEDIAN_MS} ms, target ≤ ${FILE_SWITCH_TARGET_MS} ms)\n` +
        `  of which the editor had the document at: ${editorSamples.join(', ')} ms → median ` +
        `${medianMs(editorSamples)} ms, so the preview added ${measured - medianMs(editorSamples)} ms`,
    );

    // One engine for the whole session, four switches included — the engine start-up the recorded
    // figure was paying on every switch is gone.
    expect(await renderEngineStarts(page), 'no file switch may start another engine').toBe(1);

    // Read the two medians together when this fails. The editor figure is when the newly opened
    // document was in the browser at all; everything after it is the preview's own delay, and a
    // preview that renders a switch as the deliberate exception to the typing debounce should add
    // little more than one render to it.
    expect(
      measured,
      `the median file switch showed content in ${measured} ms against a recorded ` +
        `${BASELINE_FILE_SWITCH_MEDIAN_MS} ms; at least a halving means ≤ ${FILE_SWITCH_TARGET_MS} ms. ` +
        `The document reached the editor after ${medianMs(editorSamples)} ms, so ` +
        `${measured - medianMs(editorSamples)} ms of the wait was the preview's own`,
    ).toBeLessThanOrEqual(FILE_SWITCH_TARGET_MS);
  });
});
