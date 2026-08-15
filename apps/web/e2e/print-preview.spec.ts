import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The Print preview style, in a real browser.
 *
 * Almost everything this style promises is a layout fact — a column that keeps its width, a page that
 * scales to fit, a pane that scrolls sideways only once it has been zoomed past. None of those exist
 * until an engine has measured boxes against a viewport, so they belong here rather than in a jsdom
 * test, however convenient that would be.
 */

/** A document exercising the constructs the style claims to cover. */
const SOURCE = `= Print Preview
Author Name
v1.0, 2026-01-01

== First Section

Body text in a paragraph, with a https://example.com[link] and \`inline code\`.

* first bullet
* second bullet

. first step
. second step

[source,ruby]
----
puts 'hello'
----

NOTE: An admonition worth noticing.

****
A sidebar with something aside.
****

====
An example block.
====

[quote, Someone]
____
A quoted passage.
____

|===
| Heading A | Heading B

| cell one | cell two
|===

'''

== Second Section

More body text after the break.
`;

/**
 * Write a file's content through the API, so the document exists before the editor opens it.
 *
 * @param page - The signed-in page, for its cookie jar.
 * @param projectId - The project holding the file.
 * @param fileNodeId - The file to write.
 * @param content - The AsciiDoc source.
 */
async function writeFileContent(
  page: Page,
  projectId: string,
  fileNodeId: string,
  content: string,
): Promise<void> {
  const response = await page.request.put(
    `${API_URL}/projects/${projectId}/files/${fileNodeId}/content`,
    { headers: { 'Content-Type': 'text/plain' }, data: content },
  );
  if (!response.ok()) {
    throw new Error(`writeFileContent failed: ${response.status()} ${await response.text()}`);
  }
}

/**
 * Open the project, select the file, wait for the synced document, and expand the preview.
 *
 * @param page - The signed-in page.
 * @param projectId - The project to open.
 * @param fileName - The file to select.
 */
async function openPreview(page: Page, projectId: string, fileName: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`tree-node-${fileName}`).click();
  // The preview renders the collaboratively-synced document, so wait for the sync before expanding.
  await expect(page.locator('.cm-editor .cm-content')).toContainText('Body text', { timeout: 30_000 });
  await page.getByRole('button', { name: /expand preview/i }).click();
  await expect(page.getByTestId('asciidoc-output')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('asciidoc-output')).toContainText('Body text', { timeout: 15_000 });
}

/** Select the Print style and wait for the page column to be presented. */
async function selectPrintStyle(page: Page): Promise<void> {
  await page.getByTestId('preview-style-print').click();
  await expect(page.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'print');
  await expect(page.getByTestId('print-page-viewport')).toBeVisible();
}

/** Overflow in CSS pixels: how much wider the content is than the box that has to hold it. */
async function horizontalOverflow(page: Page, testId: string): Promise<number> {
  return page
    .getByTestId(testId)
    .evaluate((element) => element.scrollWidth - element.clientWidth);
}

test.describe('the Print preview style', () => {
  // Headroom for the collaborative sync the preview renders from, under parallel load.
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Print Preview ${Date.now()}`);
    const fileNodeId = await createTestFile(page, projectId, null, 'print.adoc');
    await writeFileContent(page, projectId, fileNodeId, SOURCE);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('offers three styles and says which one is active', async ({ page }) => {
    await openPreview(page, projectId, 'print.adoc');

    for (const style of ['asciidocollab', 'asciidoctor', 'print']) {
      await expect(page.getByTestId(`preview-style-${style}`)).toBeVisible();
    }
    await expect(page.getByTestId('preview-style-asciidocollab')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await selectPrintStyle(page);
    await expect(page.getByTestId('preview-style-print')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preview-style-asciidocollab')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // The option says what it is for rather than leaving an author to infer it from the word.
    await expect(page.getByTestId('preview-style-print')).toHaveAttribute('title', /PDF/i);
  });

  test('presents the same document as a page, losing no content', async ({ page }) => {
    await openPreview(page, projectId, 'print.adoc');
    const output = page.getByTestId('asciidoc-output');
    // `textContent`, not the rendered text: what must be identical is the content and its order, and
    // a style is allowed to change how that content is set — which is the whole point of this one.
    const before = await output.evaluate((element) => element.textContent);

    await selectPrintStyle(page);
    expect(await output.evaluate((element) => element.textContent)).toBe(before);

    // A page: a column of the theme's own width, inset by its margins, on its own paper colour.
    //
    // `offsetWidth`, not `getBoundingClientRect().width`: the claim being made is about the width the
    // column is LAID OUT at, and a bounding rectangle is measured after the ancestor's fit-to-width
    // transform has been applied to it. The two are different numbers by construction — the whole
    // design is that the page keeps its own width and the zoom only changes how large that layout is
    // drawn — so a rectangle here would measure the pane instead of the page and would go on matching
    // whatever the pane happened to be.
    const page_ = await output.evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        width: element.offsetWidth,
        paddingTop: Number.parseFloat(style.paddingTop),
        background: style.backgroundColor,
      };
    });
    // A4 at 96/72 is 793.7 CSS pixels; the page is drawn scaled but laid out at its own width.
    expect(page_.width).toBeGreaterThan(700);
    expect(page_.paddingTop).toBeGreaterThan(10);
    expect(page_.background).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('keeps updating live as the author types', async ({ page }) => {
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);

    await page.locator('.cm-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nA sentence typed under the Print style.\n');

    await expect(page.getByTestId('asciidoc-output')).toContainText(
      'A sentence typed under the Print style.',
      { timeout: 15_000 },
    );
  });

  test('follows the editor when scroll sync is on', async ({ page }) => {
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);
    await page.getByTestId('scroll-sync-toggle').click();

    const pane = page.getByTestId('preview-scroll-container');
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(0);

    // Put the caret deep in the document; the preview is asked to reveal the same place.
    await page.locator('.cm-editor .cm-content').click();
    await page.keyboard.press('Control+End');

    await expect
      .poll(async () => pane.evaluate((element) => element.scrollTop), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test('keeps the page at its paper width in a pane wider than it', async ({ page }) => {
    // Wide enough that the preview pane really is wider than an A4 page. The pane is half of what is
    // left after the file tree, so a 1600-wide window leaves it around 650 — NARROWER than the page,
    // and the page is then fitted down to it, which is the opposite of the case under test here.
    await page.setViewportSize({ width: 2200, height: 900 });
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);

    const viewport = page.getByTestId('print-page-viewport');
    const [box, paneWidth] = await Promise.all([
      viewport.evaluate((element) => element.getBoundingClientRect().width),
      page.getByTestId('preview-scroll-container').evaluate((element) => element.clientWidth),
    ]);
    // The premise, asserted rather than assumed: a pane narrower than the page would make everything
    // below pass for the wrong reason, because a fitted page is also narrower than its pane.
    // A4 is 793.7 CSS pixels and the pane insets it by 16 on each side.
    expect(paneWidth).toBeGreaterThan(793.7 + 32);
    // Its own width, not the pane's: a page that stretched would be a column, not a page.
    expect(box).toBeLessThan(paneWidth - 20);
    expect(box).toBeGreaterThan(700);
  });

  test('scales down to fit a narrow pane, without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);

    const viewport = page.getByTestId('print-page-viewport');
    const paneWidth = await page
      .getByTestId('preview-scroll-container')
      .evaluate((element) => element.clientWidth);
    const drawn = await viewport.evaluate((element) => element.getBoundingClientRect().width);

    expect(drawn).toBeLessThanOrEqual(paneWidth);
    expect(await horizontalOverflow(page, 'preview-scroll-container')).toBeLessThanOrEqual(1);
  });

  test('offers the PDF preview\'s zoom default, presets and limits, and redraws at the choice', async ({
    page,
  }) => {
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);

    const select = page.getByTestId('print-zoom-preset');
    // The default is fit-to-width, the same default the PDF preview starts at.
    await expect(select).toHaveValue('fit');
    const labels = await select.locator('option').allTextContents();
    expect(labels.filter((label) => !label.startsWith('Fit'))).toEqual([
      '75%',
      '100%',
      '125%',
      '150%',
      '200%',
    ]);

    const viewport = page.getByTestId('print-page-viewport');
    const fitted = await viewport.evaluate((element) => element.getBoundingClientRect().width);
    await select.selectOption('2');
    await expect
      .poll(async () => viewport.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(fitted);

    // The limits are the PDF preview's: the stepper stops rather than running on. The loop stops
    // pressing once the control says there is no further step — clicking a button that is already
    // disabled is not a press, it is a wait for it to become clickable, and it never will. The bound
    // is what makes the claim: a stepper that ran on would still be enabled after twelve presses and
    // fail the assertion below.
    //
    // But a loop whose condition is "while it is enabled" runs ZERO times over a stepper that was
    // never enabled at all, and `toBeDisabled` is then satisfied by a control that does nothing. So
    // the presses are counted: it must have been pressable to begin with, and it must have stopped
    // being pressable before the bound rather than because of it.
    const MOST_PRESSES = 12;
    const zoomIn = page.getByTestId('print-zoom-in');
    await expect(zoomIn).toBeEnabled();
    let presses = 0;
    while (presses < MOST_PRESSES && (await zoomIn.isEnabled())) {
      await zoomIn.click();
      presses += 1;
    }
    expect(presses, 'the stepper was pressable').toBeGreaterThan(0);
    expect(presses, 'and stopped itself rather than running out of presses').toBeLessThan(MOST_PRESSES);
    await expect(zoomIn).toBeDisabled();
    // …and every one of those presses went somewhere: the page at the top of the range is wider than
    // the one the preset above put it at, which a stepper that merely disabled itself would not be.
    const largest = await viewport.evaluate((element) => element.getBoundingClientRect().width);
    expect(largest).toBeGreaterThan(fitted);
  });

  test('scrolls sideways only once the author has zoomed past the pane', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);

    expect(await horizontalOverflow(page, 'preview-scroll-container')).toBeLessThanOrEqual(1);

    await page.getByTestId('print-zoom-preset').selectOption('2');
    await expect
      .poll(async () => horizontalOverflow(page, 'preview-scroll-container'))
      .toBeGreaterThan(1);
  });

  test('is still the active style after a reload and in another document', async ({ page }) => {
    await createTestFile(page, projectId, null, 'other.adoc');
    await openPreview(page, projectId, 'print.adoc');
    await selectPrintStyle(page);

    await page.reload();
    await expect(page.getByTestId('asciidoc-output')).toHaveAttribute(
      'data-preview-style',
      'print',
      { timeout: 20_000 },
    );

    await page.getByTestId('tree-node-other.adoc').click();
    await expect(page.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'print');
  });

  test('leaves a stored preference for an older style exactly as it was', async ({ page }) => {
    // The two original styles predate this one. Adding a third must not move anybody's preference.
    await openPreview(page, projectId, 'print.adoc');
    await page.getByTestId('preview-style-asciidoctor').click();
    await expect(page.getByTestId('asciidoc-output')).toHaveAttribute(
      'data-preview-style',
      'asciidoctor',
    );

    await page.reload();
    await expect(page.getByTestId('asciidoc-output')).toHaveAttribute(
      'data-preview-style',
      'asciidoctor',
      { timeout: 20_000 },
    );
    // No page framing survives: the wrappers are present under every style and carry nothing here.
    await expect(page.getByTestId('print-page-viewport')).not.toHaveAttribute('style');
  });

  test('settles at a pane height where the scrollbar decides its own scale', async ({ page }) => {
    // The loop this guards against, in the panel's own terms: the fit scale is measured from the
    // pane's `clientWidth`, and the box that scale produces is `columnHeight × scale` — so where a
    // scrollbar takes layout space, its appearance narrows the pane, which shrinks the scale, which
    // shortens the box, which can take the content back under the pane's height and remove the
    // scrollbar again. Simulated against that arithmetic there is no fixed point over a band of pane
    // heights ≈ `columnHeight × scrollbarWidth / pageWidth` wide — 855..873px for a 1000px column in
    // a 700px pane, one flip per animation frame. `scrollbar-gutter: stable` on the pane is what
    // takes `clientWidth` out of the loop, and only a browser can say whether it worked: jsdom lays
    // nothing out and has no scrollbars at all, so the jest suite can assert no more than that the
    // pane asks for the gutter.
    //
    // A SHORT document, because the band sits where the whole scaled document is about as tall as the
    // pane. The long fixture above is several pane-heights tall at any fit scale, so its scrollbar is
    // never in question and the test would pass without exercising anything.
    const shortFileId = await createTestFile(page, projectId, null, 'short.adoc');
    await writeFileContent(
      page,
      projectId,
      shortFileId,
      '= Short\n\nBody text, and not much of it.\n',
    );
    await page.setViewportSize({ width: 1200, height: 900 });
    await openPreview(page, projectId, 'short.adoc');
    await selectPrintStyle(page);

    const pane = page.getByTestId('preview-scroll-container');
    const geometry = await pane.evaluate((element: HTMLElement) => {
      const box = document.querySelector<HTMLElement>('[data-testid="print-page-viewport"]');
      if (box === null) throw new Error('the page frame is not on screen');
      const inset = Number.parseFloat(getComputedStyle(element).paddingTop) * 2;
      return {
        // What the gutter reserves. Zero means this browser draws scrollbars OVER the content, and
        // then `clientWidth` never depended on one and there was never a loop to break.
        gutter: element.offsetWidth - element.clientWidth,
        chrome: window.innerHeight - element.clientHeight,
        boxHeight: box.getBoundingClientRect().height,
        inset,
      };
    });
    test.skip(
      geometry.gutter === 0,
      'this browser overlays its scrollbars, so a scrollbar cannot change the measured width',
    );

    // The window height that puts the scaled page exactly at the pane's own height — the boundary the
    // scrollbar's appearance turns on — and a sweep across the band around it, because the band is a
    // few pixels wide and landing in it by arithmetic alone would be optimistic.
    const boundary = Math.round(geometry.chrome + geometry.boxHeight + geometry.inset);
    for (const offset of [-8, -4, 0, 4, 8]) {
      await page.setViewportSize({ width: 1200, height: boundary + offset });
      // Sampled once per animation frame: an oscillation is one flip per frame, so a state read once
      // would report whichever half of it happened to be current. The first samples are allowed to
      // move — a resize really does change the layout — and it is the tail that must stand still.
      const samples = await pane.evaluate(async (element: HTMLElement) => {
        const box = document.querySelector<HTMLElement>('[data-testid="print-page-viewport"]');
        if (box === null) throw new Error('the page frame is not on screen');
        const readings: string[] = [];
        for (let frame = 0; frame < 40; frame += 1) {
          await new Promise<number>((resolve) => requestAnimationFrame(resolve));
          readings.push(
            `${element.clientWidth}x${Math.round(box.getBoundingClientRect().height)}`,
          );
        }
        return readings;
      });
      const settled = new Set(samples.slice(-20));
      expect(
        [...settled],
        `the pane never settled at a window height of ${boundary + offset}`,
      ).toHaveLength(1);
    }
  });
});
