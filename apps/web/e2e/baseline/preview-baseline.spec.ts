/**
 * Measures the live preview's behaviour as it is TODAY (a dev tool, not a check).
 *
 * Every comparative success criterion in this feature — refresh delay, file-switch time-to-content,
 * conversion time, main-thread cost — is judged against figures taken before anything changed. There
 * is one moment when those can be taken, so this spec exists to take them, and the artifact it feeds
 * (`specs/043-preview-responsiveness/baseline.md`) is what later work is measured against rather than
 * anyone's recollection.
 *
 * Hard-gated behind `BASELINE_MEASURE=1`: it is slow, it needs the dev stack, and it asserts almost
 * nothing — a normal suite run must not carry it.
 *
 * Run it with:
 *   BASELINE_MEASURE=1 pnpm --filter `@asciidocollab/web` exec playwright test preview-baseline \
 *     --project=chromium
 *
 * It writes one JSON summary to BASELINE_OUT (default: the repo's scratch dir) and logs it.
 */

import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from '../helpers/test-user';
import { signIn, createProject, cleanupProject } from '../helpers/test-project';
import {
  createAdocFile,
  setMainFile,
  openProject,
  openFile,
  expandPreview,
  editorContent,
} from '../helpers/editor';

const measureEnabled = process.env['BASELINE_MEASURE'] === '1';
const OUT_PATH = process.env['BASELINE_OUT'] ?? path.join(process.cwd(), 'baseline-measurements.json');

/** The document sizes the conversion-cost curve is taken over, in source lines. */
const SIZES = [100, 1500, 15_000] as const;

/** How long the sustained-typing session runs when main-thread cost is sampled. */
const TYPING_SESSION_MS = 15_000;

/** A document of roughly `lines` lines, with enough structure that conversion has real work to do. */
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

/** A document mixing diagrams and equations — the shape the main-thread figure is taken on. */
function diagramAndMathDocument(): string {
  const out: string[] = ['= Diagrams And Equations', ':stem:', '', 'Baseline document for main-thread cost.', ''];
  for (let index = 1; index <= 6; index += 1) {
    out.push(
      `== Part ${index}`,
      '',
      `Prose before the diagram in part ${index}.`,
      '',
      '[mermaid]',
      '----',
      `graph TD; A${index}[Start ${index}] --> B${index}{Choice}; B${index} -->|yes| C${index}[Go]; B${index} -->|no| D${index}[Stop];`,
      '----',
      '',
      'An inline equation stem:[a^2 + b^2 = c^2] and a block one:',
      '',
      '[stem]',
      '++++',
      String.raw`\sqrt{` + `${index * 4}} = ${index * 2}`,
      '++++',
      '',
    );
  }
  return `${out.join('\n')}\n`;
}

/** The preview's rendered-output container. */
const OUTPUT = '[data-testid="asciidoc-output"]';

/**
 * Wait until the preview's rendered output contains `needle`, and return how long that took.
 *
 * Timed inside the page so the figure is the browser's own view of when the content appeared, not a
 * round trip through the driver.
 */
async function millisecondsUntilPreviewShows(page: Page, needle: string): Promise<number> {
  return page.evaluate(async ({ selector, text }) => {
    const startedAt = performance.now();
    const deadline = startedAt + 60_000;
    for (;;) {
      const output = document.querySelector(selector);
      if (output?.textContent?.includes(text) === true) return performance.now() - startedAt;
      if (performance.now() > deadline) return Number.NaN;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  }, { selector: OUTPUT, text: needle });
}

/** The figures the development-only cost overlay is reporting, keyed by its own labels. */
async function readOverlay(page: Page, title: string): Promise<Record<string, number>> {
  return page.evaluate((overlayTitle) => {
    const overlay = document.querySelector(`aside[aria-label="${overlayTitle} render cost"]`);
    if (overlay === null) return {};
    const figures: Record<string, number> = {};
    for (const row of overlay.querySelectorAll('dt')) {
      const value = row.nextElementSibling?.textContent ?? '';
      const parsed = Number.parseFloat(value);
      if (!Number.isNaN(parsed)) figures[row.textContent ?? ''] = parsed;
    }
    return figures;
  }, title);
}

/** Main-thread cost as Chrome itself accounts for it, in milliseconds. */
interface MainThreadCost {
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  recalcStyleMs: number;
}

/**
 * Sample Chrome's own cumulative main-thread counters.
 *
 * The session is created and enabled ONCE by the caller and sampled twice: detaching between samples
 * stops the collection, and the second sample then reads the same numbers as the first — a delta of
 * exactly zero across a fifteen-second typing session, which is what that mistake looks like.
 */
async function sampleMainThreadCost(client: CdpSession): Promise<MainThreadCost> {
  const { metrics } = await client.send('Performance.getMetrics');
  const value = (name: string): number =>
    (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return {
    taskMs: value('TaskDuration'),
    scriptMs: value('ScriptDuration'),
    layoutMs: value('LayoutDuration'),
    recalcStyleMs: value('RecalcStyleDuration'),
  };
}

/** The CDP session shape this file uses — just enough to send the two commands above. */
interface CdpSession {
  send(method: 'Performance.enable'): Promise<unknown>;
  send(method: 'Performance.getMetrics'): Promise<{ metrics: { name: string; value: number }[] }>;
}

/**
 * Start counting long tasks in the page, and return a reader for the total.
 *
 * Recorded alongside Chrome's counters because they answer slightly different questions: the counters
 * say how much time the main thread spent working, and this says how much of that arrived in blocks
 * long enough for a person to feel.
 */
async function startLongTaskCounter(page: Page): Promise<() => Promise<{ count: number; totalMs: number }>> {
  await page.evaluate(() => {
    const window_: Window & { __adcLongTasks?: { count: number; totalMs: number } } = globalThis.window;
    window_.__adcLongTasks = { count: 0, totalMs: 0 };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window_.__adcLongTasks!.count += 1;
        window_.__adcLongTasks!.totalMs += entry.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  });
  return async () =>
    page.evaluate(() => {
      const window_: Window & { __adcLongTasks?: { count: number; totalMs: number } } = globalThis.window;
      const tally = window_.__adcLongTasks ?? { count: 0, totalMs: 0 };
      return { count: tally.count, totalMs: Math.round(tally.totalMs) };
    });
}

/** The bytes the page actually downloaded for the render worker's own chunk(s). */
async function renderWorkerBytes(page: Page): Promise<{ resources: number; encodedBytes: number }> {
  return page.evaluate(() => {
    const entries = performance
      .getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => 'encodedBodySize' in entry)
      .filter((entry) => /asciidoc-render|asciidoctor/i.test(entry.name));
    return {
      resources: entries.length,
      encodedBytes: entries.reduce((total, entry) => total + (entry.encodedBodySize || entry.transferSize), 0),
    };
  });
}

/**
 * The directory an installed package was unpacked into: the nearest ancestor of one of its entry
 * points that holds a `package.json`.
 *
 * Counting directory levels up from a resolved entry point instead would be a guess about the
 * package's internal layout, and a wrong guess resolves to a real directory that simply has nothing in
 * it — a missing-file error pointing at a path that never existed.
 */
function packageRoot(entryPoint: string): string {
  let directory = path.dirname(entryPoint);
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`no package.json above ${entryPoint}`);
    directory = parent;
  }
  return directory;
}

/**
 * Where the installed engine keeps its browser bundle, and its shipped minified twin if it has one.
 *
 * The layout is the engine's own and has moved between major versions — `dist/browser/asciidoctor.js`
 * beside a pre-minified `asciidoctor.min.js`, then `build/browser/index.js` with no minified twin at
 * all. Both are searched, and a version whose bundle is at neither path is an error rather than a
 * silently missing measurement, because a size row nobody can reproduce is worse than no size row.
 */
function engineBundlePaths(coreRoot: string): { bundle: string; shippedMinified: string | null } {
  const candidates = [
    { bundle: path.join(coreRoot, 'build', 'browser', 'index.js'), shippedMinified: null },
    {
      bundle: path.join(coreRoot, 'dist', 'browser', 'asciidoctor.js'),
      shippedMinified: path.join(coreRoot, 'dist', 'browser', 'asciidoctor.min.js'),
    },
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate.bundle)) continue;
    const shipped =
      candidate.shippedMinified !== null && existsSync(candidate.shippedMinified)
        ? candidate.shippedMinified
        : null;
    return { bundle: candidate.bundle, shippedMinified: shipped };
  }
  throw new Error(`no browser bundle found under ${coreRoot}; the engine's layout has moved again`);
}

/**
 * The size on disk of the conversion engine this build bundles.
 *
 * Recorded alongside what the page downloaded because the download figure is a development-server
 * figure: the dev server serves unminified, unsplit modules, so it says nothing about what ships. The
 * engine's own browser bundle is the same file whatever the bundler does with it, which makes it the
 * figure two engine versions can honestly be compared on.
 *
 * The minified figure is produced HERE, by one minifier, rather than read from whatever the engine
 * happened to publish. Only some versions ship a minified bundle, and two vendors' minifier settings
 * are not a comparison — measuring both sides with the same tool is. The shipped file's size is still
 * recorded when there is one, so a figure taken before this ran the minifier itself stays readable
 * next to the one taken after.
 */
function engineSourceBytes(): {
  file: string;
  bytes: number;
  minifiedBytes: number;
  minifiedBy: string;
  shippedMinifiedBytes: number | null;
  version: string;
} {
  const engineRoot = packageRoot(require.resolve('asciidoctor', { paths: [process.cwd()] }));
  const coreRoot = packageRoot(require.resolve('@asciidoctor/core', { paths: [engineRoot] }));
  const { bundle, shippedMinified } = engineBundlePaths(coreRoot);
  const engineVersion: string = require(path.join(engineRoot, 'package.json')).version;
  const minified = esbuild.transformSync(readFileSync(bundle, 'utf8'), { minify: true });
  return {
    file: path.relative(process.cwd(), bundle),
    bytes: statSync(bundle).size,
    minifiedBytes: Buffer.byteLength(minified.code, 'utf8'),
    minifiedBy: `esbuild ${esbuild.version}`,
    shippedMinifiedBytes: shippedMinified === null ? null : statSync(shippedMinified).size,
    version: engineVersion,
  };
}

test.describe('preview baseline', () => {
  test.skip(!measureEnabled, 'set BASELINE_MEASURE=1 to take the baseline measurements');
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  // Seeded from a previous run's file when one exists, so a single test can be re-measured without
  // discarding the figures the other tests already produced.
  const measurements: Record<string, unknown> = existsSync(OUT_PATH)
    ? { ...JSON.parse(readFileSync(OUT_PATH, 'utf8')), takenAt: new Date().toISOString() }
    : { takenAt: new Date().toISOString() };
  let projectId = '';

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  // Report the figures the way a Playwright run reports anything: as an attachment on the test that
  // produced them, which every reporter surfaces and which survives into the HTML report. Printing
  // them instead only works for someone watching the terminal, and is the console this suite has no
  // business writing to.
  //
  // An afterEach rather than the afterAll that writes the file, because attachments belong to a test:
  // `test.info()` is test-scoped, and the run is serial, so each test attaches everything measured so
  // far and the last one carries the complete set.
  test.afterEach(async () => {
    test.info().annotations.push({ type: 'baseline-measurements', description: OUT_PATH });
    await test.info().attach('baseline-measurements.json', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  });

  test.afterAll(() => {
    // Written as well as attached: the artifact the feature is measured against is this file, and it
    // has to outlive the report — including for a `--grep`'d re-measurement of a single figure.
    writeFileSync(OUT_PATH, `${JSON.stringify(measurements, null, 2)}\n`, 'utf8');
  });

  test('measures conversion cost across the document size range', async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Baseline ${Date.now()}`);

    const perSize: Record<string, unknown> = {};
    for (const size of SIZES) {
      const marker = `size-${size}`;
      await createAdocFile(page, projectId, `${marker}.adoc`, sizedDocument(size, marker));
    }
    await openProject(page, projectId);

    for (const size of SIZES) {
      const marker = `size-${size}`;
      await openFile(page, `${marker}.adoc`);
      if (size === SIZES[0]) await expandPreview(page);
      const shownMs = await millisecondsUntilPreviewShows(page, `A ${size}-line document.`);
      // The overlay reports what the render itself cost, which is the figure conversion time means;
      // the wait above additionally carries scheduling, worker round trip and paint.
      const overlay = await readOverlay(page, 'Web preview');
      perSize[marker] = { lines: size, shownMs: Math.round(shownMs), overlay };
      expect(Number.isNaN(shownMs)).toBe(false);
    }

    measurements['conversionBySize'] = perSize;
    measurements['engineSource'] = engineSourceBytes();
    measurements['renderWorkerDownload'] = await renderWorkerBytes(page);
  });

  test('measures the delay from the last keystroke to the refresh', async ({ page }) => {
    await signIn(page);
    await openProject(page, projectId);

    const samples: Record<string, number[]> = {};
    for (const size of SIZES) {
      const marker = `size-${size}`;
      await openFile(page, `${marker}.adoc`);
      if (size === SIZES[0]) await expandPreview(page);
      await millisecondsUntilPreviewShows(page, `A ${size}-line document.`);

      const perSize: number[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const needle = `KEYSTROKE-${size}-${attempt}`;
        await editorContent(page).click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(`\n\n${needle}`);
        const elapsed = await millisecondsUntilPreviewShows(page, needle);
        perSize.push(Math.round(elapsed));
      }
      samples[marker] = perSize;
    }
    measurements['keystrokeToRefreshMs'] = samples;
  });

  test('measures time-to-content when switching files', async ({ page }) => {
    await signIn(page);
    await openProject(page, projectId);
    await openFile(page, `size-${SIZES[0]}.adoc`);
    await expandPreview(page);
    await millisecondsUntilPreviewShows(page, `A ${SIZES[0]}-line document.`);

    const switches: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const target = SIZES[attempt % 2 === 0 ? 1 : 0]!;
      await openFile(page, `size-${target}.adoc`);
      switches.push(Math.round(await millisecondsUntilPreviewShows(page, `A ${target}-line document.`)));
    }
    measurements['fileSwitchToContentMs'] = switches;
  });

  test('measures main-thread cost across a sustained editing session', async ({ page }) => {
    await signIn(page);
    // This figure is the one most often re-measured on its own, and a `--grep`'d run never reaches the
    // test that creates the shared project. Make one here when there is none to borrow — and remember
    // that it is this test's to clear up, since the test that would otherwise do it did not run either.
    const ownsProject = projectId === '';
    if (ownsProject) projectId = await createProject(page, `Baseline main thread ${Date.now()}`);
    await createAdocFile(page, projectId, 'diagrams-and-math.adoc', diagramAndMathDocument());
    await openProject(page, projectId);
    await openFile(page, 'diagrams-and-math.adoc');
    await expandPreview(page);
    await millisecondsUntilPreviewShows(page, 'Baseline document for main-thread cost.');
    // Diagrams draw and equations typeset on the main thread after the first render; let that settle
    // so the session below measures editing, not first paint.
    await page.waitForTimeout(4000);

    const client: CdpSession = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    const readLongTasks = await startLongTaskCounter(page);
    const before = await sampleMainThreadCost(client);

    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    const startedAt = Date.now();
    let typed = 0;
    while (Date.now() - startedAt < TYPING_SESSION_MS) {
      await page.keyboard.type('typing ', { delay: 60 });
      typed += 1;
    }
    const after = await sampleMainThreadCost(client);
    const longTasks = await readLongTasks();

    measurements['sustainedTyping'] = {
      documentLines: diagramAndMathDocument().split('\n').length,
      sessionMs: TYPING_SESSION_MS,
      wordsTyped: typed,
      deltaMs: {
        task: Math.round(after.taskMs - before.taskMs),
        script: Math.round(after.scriptMs - before.scriptMs),
        layout: Math.round(after.layoutMs - before.layoutMs),
        recalcStyle: Math.round(after.recalcStyleMs - before.recalcStyleMs),
      },
      longTasks,
    };

    if (ownsProject) {
      await cleanupProject(page, projectId);
      projectId = '';
    }
  });

  test('measures the page-formatted path per stage', async ({ page }) => {
    await signIn(page);

    // A project per size, not a file per size. The page-formatted preview renders the PROJECT's main
    // document, so opening a different file in one project changes nothing about what it renders —
    // measured that way it reports the same render twice and the size curve is an illusion.
    const perSize: Record<string, unknown> = {};
    for (const size of [SIZES[0], SIZES[1]] as const) {
      const marker = `size-${size}`;
      const sizedProjectId = await createProject(page, `Baseline page ${size} ${Date.now()}`);
      const mainFileId = await createAdocFile(
        page,
        sizedProjectId,
        `${marker}.adoc`,
        sizedDocument(size, marker),
      );
      await setMainFile(page, sizedProjectId, mainFileId);
      await openProject(page, sizedProjectId);
      await openFile(page, `${marker}.adoc`);
      // The panel's open/closed state and its format are remembered per user, so a previous run can
      // leave it open and already page-formatted. Expand only when it is actually collapsed, and do
      // it without the helper's wait for web-format output, which never arrives in page format.
      const expandButton = page.getByRole('button', { name: /expand preview/i });
      if (await expandButton.isVisible().catch(() => false)) {
        await expandButton.click();
      }
      await page.getByTestId('preview-mode-pdf').click();

      // Wait for the render's own figures rather than for a painted page: the overlay is driven by
      // the result frame, so it is present exactly when there is something to record.
      const rendered = await page
        .locator('aside[aria-label="Page preview render cost"]')
        .waitFor({ state: 'visible', timeout: 240_000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(2000);
      perSize[marker] = { lines: size, rendered, overlay: await readOverlay(page, 'Page preview') };
      await cleanupProject(page, sizedProjectId);
    }
    measurements['pageFormatBySize'] = perSize;

    if (projectId) await cleanupProject(page, projectId);
  });
});
