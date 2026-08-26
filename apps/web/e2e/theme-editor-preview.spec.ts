import { existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';
import { createAdocFile, openProject, openFile, setMainFile, writeFileContent } from './helpers/editor';

/**
 * End-to-end proof that the theme editor's sample preview shows what the project actually renders.
 *
 * The theme editor is a split view: the theme's YAML on the left, a sample document rendered with it
 * on the right. That preview is the ONLY way an author judges a theme — nothing else in the product
 * shows a theme's effect before it is committed to the project — so a preview that renders the sample
 * under different conditions from the export is worse than no preview at all: it is confidently wrong,
 * and it is wrong in exactly the way that is hardest to notice, because a plausible page is still a
 * page. Both defects below shipped, and both were reported the same way: "the PDF shows a different
 * style than the one on screen".
 *
 * **Why these have to be end-to-end.** Each defect lives in the wiring BETWEEN correct parts. The
 * render config was read correctly, the snapshot builder layered attributes correctly, the extension
 * registry loaded exactly what it was handed, and the Ruby gated on the per-render selection exactly
 * as it should — verified directly against the wasm engine. What no single-package test could see is
 * whether the project's page setup and the project's extension selection ever REACH the sample the
 * author is looking at. Between the settings and the canvas sit a render config fetch, an
 * asynchronously fetched extension bundle, a debounced render driver and a warm VM in a worker, and
 * an omission anywhere in that chain renders a perfectly good PDF of the wrong thing.
 *
 * The assertions are therefore about the rendered document rather than about props: the page's
 * ORIENTATION, which no assertion about attribute maps can stand in for, and the page COUNT, which
 * moves only if the extension's Ruby actually ran.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Resolved from the app root (Playwright's testDir is ./e2e). Both vendored assets are needed here
// and they are independent: the wasm engine PRODUCES the sample's PDF, and the pdf.js worker paints
// it — and it is pdf.js that reports the page count and the page geometry these tests read.
const ENGINE_WASM_PATH = path.join(
  process.cwd(),
  'public',
  'vendor',
  'asciidoctor-pdf',
  'asciidoctor-pdf.wasm',
);
const PDF_WORKER_PATH = path.join(process.cwd(), 'public', 'vendor', 'pdfjs', 'pdf.worker.min.mjs');
const enginePresent = existsSync(ENGINE_WASM_PATH);
const pdfWorkerPresent = existsSync(PDF_WORKER_PATH);

const ENGINE_GATE_MESSAGE =
  'Asciidoctor-PDF wasm engine is not vendored; build it (pnpm --filter @asciidocollab/asciidoc-pdf build:wasm) to run the theme preview checks.';
const PDF_WORKER_GATE_MESSAGE =
  'The pdf.js worker is not vendored (public/vendor/pdfjs/pdf.worker.min.mjs), so the sample cannot be painted and neither its page count nor its page size can be read.';

/** The theme file. The name matters: the theme editor is routed to by the `*-theme.yml` convention. */
const THEME_FILE = 'sample-theme.yml';
/** A theme that changes nothing. These tests are about the CONDITIONS the sample renders under. */
const THEME = 'extends: default\n';

/** The project's own document, so the export has something to render. Not the theme sample. */
const MAIN_DOC = ['= Project Document', '', 'A paragraph, so the export has a page.', ''].join('\n');

/**
 * The extension whose selection is followed through to the preview.
 *
 * Chosen because its effect is COUNTABLE. `auto-license-page` turns the sample's `:license:`
 * attribute into a page of its own, so enabling it moves the page total by exactly one — measured
 * against the real engine (14 pages without it, 15 with it) rather than assumed. Most of the shipped
 * extensions rearrange a page instead of adding one: `multi-column-sections`, the one the original
 * report named, leaves the sample at 14 pages either way, and asserting on it would have meant
 * comparing pixels of a page the preview paints lazily and releases when it scrolls away.
 *
 * The defect is not specific to any extension — it is in the driver that gets a SELECTION to the
 * preview at all — so the extension that measures it most sharply is the right one to key on.
 */
const EXTENSION_ID = 'auto-license-page';

/** The A5 landscape page the project below is configured for; nothing else in the stack defaults to it. */
const PROJECT_PAGE_SIZE = 'A5';
const PROJECT_PAGE_LAYOUT = 'landscape';

// The first render downloads and instantiates the tens-of-MiB wasm engine and boots its Ruby VM, then
// paints the sample — a cold start that is slow on a loaded gate machine and fast everywhere else.
const FIRST_RENDER_TIMEOUT_MS = 120_000;
/** How long the preview may keep re-rendering before it is considered stuck rather than busy. */
const SETTLE_TIMEOUT_MS = 120_000;
/** How long a render has to START after the selection changes, before something is wrong. */
const RENDER_START_TIMEOUT_MS = 30_000;
/** Spacing between the readings {@link settledPageTotal} takes. */
const STABLE_INTERVAL_MS = 2000;
/**
 * How many equal readings in a row mean the preview has stopped moving.
 *
 * Four at the interval above is six seconds of continuous stillness — an order of magnitude over the
 * preview's own scheduling delay, so a gap BETWEEN two renders cannot be mistaken for the end of
 * them. That mistake is not hypothetical: a single reading taken while the panel was idle read the
 * count from before the selection change had been rendered at all, because the change was still
 * sitting in the debounce.
 */
const STABLE_READS = 4;
/** How long the preview has to reflect a change to the extension selection. */
const SELECTION_TIMEOUT_MS = 90_000;

/** Aspect-ratio agreement between the painted page and the exported one, absorbing canvas rounding. */
const ASPECT_TOLERANCE = 0.02;

/**
 * How long an extension's Ruby is held back before it reaches the browser.
 *
 * Not a slowdown for its own sake — it is the CONDITION the defect needs, and without it the test
 * cannot see the defect at all. The preview posts its render after a short delay; the source is
 * fetched over the network. Against a stack on the same machine the fetch reliably wins that race,
 * so the render carries the source, the extension applies, and a preview with no correcting
 * re-render whatsoever passes this test. Anywhere real — a deployment across a network, a cold
 * cache, a loaded server — the fetch loses, and then the render is posted with the extension's id
 * but not its code, the registry refuses the id, and the sample renders without it.
 *
 * Held for long enough to lose that race by a wide margin, so what is being tested is whether the
 * preview corrects itself when the source finally lands, and not how fast localhost is today.
 */
const SOURCE_FETCH_DELAY_MS = 8000;

/** The endpoint serving one extension's Ruby, which {@link SOURCE_FETCH_DELAY_MS} is applied to. */
const EXTENSION_SOURCE_ROUTE = /\/pdf-extensions\/[^/]+\/source$/;

/** The theme editor's preview half of the split view. */
function previewPanel(page: Page): Locator {
  return page.getByTestId('theme-preview-panel');
}

/** The preview's `<section>`, whose `aria-busy` is true exactly while a render is in flight. */
function previewSection(page: Page): Locator {
  return previewPanel(page).locator('[aria-label="PDF preview"]');
}

/** The canvas the sample's first page is painted into. */
function firstPageCanvas(page: Page): Locator {
  return previewPanel(page).locator('canvas').first();
}

/** The control that holds one extension out of the preview without touching the project. */
function comparisonToggle(page: Page): Locator {
  return page.getByTestId('extension-comparison-toggle');
}

/**
 * The width-to-height ratio of the sample's painted first page.
 *
 * Read from the canvas's INTRINSIC size, which pdf.js derives from the page's own dimensions, so it
 * reports the page the engine produced rather than however the panel happens to lay it out. Greater
 * than one is landscape; the engine's default page, and every page size the app offers, is portrait.
 */
async function paintedPageAspect(page: Page): Promise<number> {
  return firstPageCanvas(page).evaluate((element) =>
    element instanceof HTMLCanvasElement && element.height > 0 ? element.width / element.height : 0,
  );
}

/**
 * The sample's page count as the preview reports it, or 0 before the first render lands.
 *
 * The indicator is absent rather than zero until a document has been rendered, which is why this
 * counts the element instead of parsing whatever `innerText` an absent locator would throw over.
 */
async function pageTotal(page: Page): Promise<number> {
  const indicator = previewPanel(page).getByTestId('pdf-page-total');
  if ((await indicator.count()) === 0) return 0;
  const shown = await indicator.textContent();
  return Number((shown ?? '').trim());
}

/**
 * Wait until a render is actually underway.
 *
 * Changing the selection does not render immediately — the request is debounced — so the panel stays
 * idle for a moment afterwards, and anything that reads the preview in that moment is reading the
 * PREVIOUS document. Waiting for the panel to go busy is what separates "not started yet" from
 * "finished", which an idle panel alone cannot distinguish.
 */
async function waitForRenderToStart(page: Page): Promise<void> {
  await expect(previewSection(page)).toHaveAttribute('aria-busy', 'true', {
    timeout: RENDER_START_TIMEOUT_MS,
  });
}

/**
 * The page count once the preview has stopped changing it.
 *
 * A single read after the panel goes idle is not enough, for two different reasons. A selection
 * change legitimately produces TWO renders — the one posted immediately and the one posted when the
 * extension's Ruby finishes being fetched — so a read taken between them captures the intermediate
 * document; and the gap before the FIRST of them is idle too, so a read taken there captures the
 * document from before the change. {@link STABLE_READS} equal readings with the panel idle
 * throughout is long enough to be neither.
 *
 * @param page - The page showing the theme editor.
 * @returns The settled page count.
 */
async function settledPageTotal(page: Page): Promise<number> {
  let candidate = -1;
  let agreements = 0;
  await expect(async () => {
    const idle = (await previewSection(page).getAttribute('aria-busy')) === 'false';
    const current = await pageTotal(page);
    if (!idle || current <= 0) {
      candidate = -1;
      agreements = 0;
    } else if (current === candidate) {
      agreements += 1;
    } else {
      candidate = current;
      agreements = 1;
    }
    expect(agreements, 'the preview has settled on a page count').toBeGreaterThanOrEqual(
      STABLE_READS,
    );
  }).toPass({ intervals: [STABLE_INTERVAL_MS], timeout: SETTLE_TIMEOUT_MS });
  return candidate;
}

/** Store the project's render options, replacing whatever was there. */
async function putRenderConfig(page: Page, projectId: string, config: unknown): Promise<void> {
  const saved = await page.request.put(`${API_URL}/api/projects/${projectId}/render-config`, {
    data: config,
  });
  expect(saved.ok()).toBe(true);
}

/** The width-to-height ratio of an exported PDF's first page, via poppler. */
function exportedPageAspect(pdfPath: string): number {
  const info = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  const match = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(info);
  expect(match, `pdfinfo reported no page size for ${pdfPath}`).not.toBeNull();
  return Number(match![1]) / Number(match![2]);
}

/** True when the poppler tools the export assertion reads the PDF with are installed. */
function popplerAvailable(): boolean {
  try {
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a project holding the theme, a document for the export, and the given render options.
 *
 * The render config is stored BEFORE the project view is opened: it is read once when the view
 * mounts, so a project opened first and configured afterwards would render under the old options and
 * quietly pass whatever these tests asked of it.
 *
 * @param page - The signed-in page.
 * @param name - A distinguishing project name.
 * @param config - The render options to store.
 * @returns The new project's id.
 */
async function projectShowingTheme(page: Page, name: string, config: unknown): Promise<string> {
  const projectId = await createProject(page, name);
  const mainId = await createAdocFile(page, projectId, 'main.adoc', MAIN_DOC);
  await setMainFile(page, projectId, mainId);
  const themeId = await createTestFile(page, projectId, null, THEME_FILE);
  await writeFileContent(page, projectId, themeId, THEME);
  await putRenderConfig(page, projectId, config);
  return projectId;
}

test.describe('Theme editor — the sample preview shows what the project renders', () => {
  // Budgeted so that a run in which BOTH tests fail honestly still reaches the end and reports which
  // assertion failed. The per-test budget covers the waits inside each test with margin (the export
  // test's own timeouts sum to ~330 s, the extension test's to ~390 s, and on an idle machine they
  // finish in 25 s and 49 s), and one retry rather than the suite's two keeps the worst case —
  // 2 tests x 2 attempts x 7 minutes = 28 minutes — inside the config's 45-minute `globalTimeout`.
  // At the suite's default retries that worst case is an hour, and a ceiling that truncates a real
  // failure into "timed out" replaces the diagnostic with a hang. Locally the retry count matches the
  // config's own, so a bare `npx playwright test` still reports the first, un-retried result.
  test.describe.configure({ timeout: 420_000, retries: process.env.CI ? 1 : 0 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  test("renders the sample on the project's own page, and the export agrees", async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    test.skip(!pdfWorkerPresent, PDF_WORKER_GATE_MESSAGE);
    test.skip(!popplerAvailable(), 'poppler-utils is not installed; pdfinfo is needed to read the exported page size.');

    await signIn(page);
    const projectId = await projectShowingTheme(page, `Theme Preview Page ${Date.now()}`, {
      pdfPageSize: PROJECT_PAGE_SIZE,
      pdfPageLayout: PROJECT_PAGE_LAYOUT,
    });
    try {
      await openProject(page, projectId);
      await openFile(page, THEME_FILE, 'extends');

      await expect(firstPageCanvas(page)).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

      // THE assertion. The preview seeded only the backend intrinsics, so a project that had chosen a
      // landscape page previewed its theme on the engine's default PORTRAIT page. Page size and layout
      // set the measure every other theme setting is judged against — margins, line length, where a
      // heading falls — so this is not a detail of the preview: it is the frame the whole preview is
      // wrong inside. Nothing but the project's own configuration can make this page landscape.
      const previewAspect = await paintedPageAspect(page);
      expect(
        previewAspect,
        'the sample is previewed on the landscape page the project is configured for',
      ).toBeGreaterThan(1);

      // And the export produces the same page. This is the comparison the original report was made
      // from — the preview beside a PDF that disagreed with it — so it is asserted rather than
      // inferred from the two halves being configured alike.
      const exportButton = page.getByRole('button', { name: /export to pdf/i });
      await expect(exportButton).toBeEnabled({ timeout: 30_000 });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 180_000 }),
        exportButton.click(),
      ]);
      const pdfPath = path.join(mkdtempSync(path.join(tmpdir(), 'theme-preview-')), 'export.pdf');
      await download.saveAs(pdfPath);

      const exportedAspect = exportedPageAspect(pdfPath);
      expect(exportedAspect, 'the exported PDF is on the same landscape page').toBeGreaterThan(1);
      expect(
        Math.abs(previewAspect - exportedAspect),
        'the previewed page and the exported page are the same shape',
      ).toBeLessThan(ASPECT_TOLERANCE);
    } finally {
      await cleanupProject(page, projectId);
    }
  });

  test('follows the extension selection, including one taken back in', async ({ page }) => {
    test.skip(!enginePresent, ENGINE_GATE_MESSAGE);
    test.skip(!pdfWorkerPresent, PDF_WORKER_GATE_MESSAGE);

    await signIn(page);
    const projectId = await projectShowingTheme(page, `Theme Preview Extension ${Date.now()}`, {
      extensions: { enabled: [EXTENSION_ID] },
    });
    // Put the fetch behind the render, which is the order it arrives in everywhere but here.
    await page.route(EXTENSION_SOURCE_ROUTE, async (route) => {
      await new Promise((resolve) => {
        setTimeout(resolve, SOURCE_FETCH_DELAY_MS);
      });
      await route.continue();
    });
    try {
      await openProject(page, projectId);
      await openFile(page, THEME_FILE, 'extends');
      await expect(firstPageCanvas(page)).toBeVisible({ timeout: FIRST_RENDER_TIMEOUT_MS });

      // Hold the extension out of the preview. Only the preview changes — the project's selection is
      // untouched — which is what makes the two states below differ in exactly one thing.
      //
      // Measured FIRST, and it is the held-out state that is measured first on purpose: with nothing
      // to load, no later arrival can correct it, so it is the one reading in this test that is
      // settled the moment its render lands.
      await comparisonToggle(page).selectOption({ value: EXTENSION_ID });
      await expect(page.getByTestId('extension-comparison-state')).toBeVisible();
      await waitForRenderToStart(page);
      const withoutExtension = await settledPageTotal(page);
      expect(withoutExtension, 'the sample rendered without the extension').toBeGreaterThan(0);

      // Take it back in. This is the direction that was broken, and it was broken because the two
      // things it changes happen at once: the load list gains the id (so a render is posted straight
      // away) while the fetched Ruby for that id is discarded and re-requested (so the render posted
      // at that instant carries no sources and the registry refuses the id). The document then
      // rendered WITHOUT the extension, and nothing scheduled another render when the sources
      // arrived — same snapshot, same ids — so the preview kept showing the unextended sample until
      // the author happened to type. The export waited for the sources and did not have this problem,
      // which is precisely how the preview and the PDF beside it came to disagree.
      await comparisonToggle(page).selectOption({ label: 'with all extensions' });
      await waitForRenderToStart(page);
      await expect
        .poll(async () => pageTotal(page), {
          message: 'the preview reflects the extension being taken back in',
          timeout: SELECTION_TIMEOUT_MS,
        })
        .toBe(withoutExtension + 1);
    } finally {
      await cleanupProject(page, projectId);
    }
  });
});
