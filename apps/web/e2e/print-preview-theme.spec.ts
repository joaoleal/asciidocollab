import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** The file tree marks the open file with the selected-row token. */
const SELECTED = /(?:^|\s)bg-primary\/10(?:\s|$)/;

/**
 * The Print preview wearing the project's own theme, in a real browser.
 *
 * A resolved theme value only becomes an appearance once a browser has cascaded it, and a typeface
 * only becomes a line length once one has been loaded and laid out. Both are what this style claims,
 * and neither exists in jsdom — which is why these live here and not beside the unit tests that
 * already cover the resolution itself.
 */

/** A theme with a distinctive value for each of the things an author would look at first. */
const THEME = `extends: default
page:
  size: LETTER
  margin: [72, 72, 72, 72]
  background_color: FFFDF5
base:
  font_color: 202020
heading:
  font_color: 8B0000
link:
  font_color: 0000CD
code:
  background_color: E8E8FF
`;

const SOURCE = `= Themed Document

== A Section

Body text with a https://example.com[link].

----
code block
----
`;

/**
 * Write a file's content through the API.
 *
 * @param page - The signed-in page, for its cookie jar.
 * @param projectId - The project holding the file.
 * @param fileNodeId - The file to write.
 * @param content - The text to write.
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
 * Open the project on a file and show the preview in the Print style.
 *
 * @param page - The signed-in page.
 * @param projectId - The project to open.
 * @param fileName - The document to select.
 */
async function openPrintPreview(page: Page, projectId: string, fileName: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`tree-node-${fileName}`).click();
  await expect(page.locator('.cm-editor .cm-content')).toContainText('Body text', { timeout: 30_000 });
  await page.getByRole('button', { name: /expand preview/i }).click();
  await expect(page.getByTestId('asciidoc-output')).toContainText('Body text', { timeout: 20_000 });
  await page.getByTestId('preview-style-print').click();
  await expect(page.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'print');
}

/** One computed style value from an element inside the previewed page. */
async function computed(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(`[data-testid="asciidoc-output"] ${selector}`)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
}

test.describe('the Print preview applies the project theme', () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;
  let documentNodeId: string;
  let themeNodeId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Print Theme ${Date.now()}`);
    documentNodeId = await createTestFile(page, projectId, null, 'themed.adoc');
    await writeFileContent(page, projectId, documentNodeId, SOURCE);
    themeNodeId = await createTestFile(page, projectId, null, 'brand-theme.yml');
    await writeFileContent(page, projectId, themeNodeId, THEME);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('the theme\'s page, colours and code background are all visibly applied', async ({ page }) => {
    await openPrintPreview(page, projectId, 'themed.adoc');
    const column = page.getByTestId('asciidoc-output');

    // LETTER at 96/72 is 816 CSS pixels wide, and a 72pt margin is 96.
    //
    // `offsetWidth` is the column's LAID-OUT width. A bounding rectangle is measured after the
    // fit-to-width transform the pane applies to the page, so it would report the pane's width rather
    // than the theme's page size — the very value under test. See the same note in print-preview.spec.ts.
    const geometry = await column.evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        width: element.offsetWidth,
        padding: style.paddingLeft,
        background: style.backgroundColor,
        color: style.color,
      };
    });
    expect(Math.round(geometry.width)).toBe(816);
    expect(Math.round(Number.parseFloat(geometry.padding))).toBe(96);
    expect(geometry.background).toBe('rgb(255, 253, 245)');
    expect(geometry.color).toBe('rgb(32, 32, 32)');

    expect(await computed(page, 'h2', 'color')).toBe('rgb(139, 0, 0)');
    expect(await computed(page, 'a', 'color')).toBe('rgb(0, 0, 205)');
    expect(await computed(page, '.listingblock pre', 'background-color')).toBe('rgb(232, 232, 255)');
  });

  test("the renderer's own typeface is loaded, not a substitute for it", async ({ page }) => {
    await openPrintPreview(page, projectId, 'themed.adoc');

    // The default theme's body face is the gem's own Noto Serif subset, served from this
    // application's own origin. A family name in a stylesheet proves nothing on its own — what
    // matters is that the browser actually loaded a face under it.
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].map((face) => ({ family: face.family, status: face.status }));
    });
    expect(loaded.some((face) => face.family === 'Noto Serif' && face.status === 'loaded')).toBe(true);
    expect(await computed(page, 'p', 'font-family')).toContain('Noto Serif');
  });

  test('editing the theme restyles the page, with no reload and no re-selection', async ({ page }) => {
    await openPrintPreview(page, projectId, 'themed.adoc');
    expect(await computed(page, 'h2', 'color')).toBe('rgb(139, 0, 0)');

    await writeFileContent(
      page,
      projectId,
      themeNodeId,
      THEME.replace('font_color: 8B0000', 'font_color: 006400'),
    );

    await expect
      .poll(async () => computed(page, 'h2', 'color'), { timeout: 20_000 })
      .toBe('rgb(0, 100, 0)');
    await expect(page.getByTestId('asciidoc-output')).toHaveAttribute('data-preview-style', 'print');
  });

  test('a project declaring which theme it uses gets that one, not the first by name', async ({
    page,
  }) => {
    // Two themes, and the declared one is not the one the automatic (sorted) choice would land on.
    const chosen = await createTestFile(page, projectId, null, 'zz-chosen-theme.yml');
    await writeFileContent(page, projectId, chosen, 'extends: default\nheading:\n  font_color: 4B0082\n');
    // Declared the way an owner declares it: through project options, which is where the export
    // reads it from too.
    const saved = await page.request.put(`${API_URL}/api/projects/${projectId}/render-config`, {
      data: { pdfTheme: 'zz-chosen-theme.yml' },
    });
    expect(saved.ok()).toBe(true);

    await openPrintPreview(page, projectId, 'themed.adoc');
    await expect.poll(async () => computed(page, 'h2', 'color'), { timeout: 20_000 }).toBe(
      'rgb(75, 0, 130)',
    );
  });

  test('the page keeps the theme colours in dark mode', async ({ page }) => {
    await openPrintPreview(page, projectId, 'themed.adoc');
    const light = await page
      .getByTestId('asciidoc-output')
      .evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]);

    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.emulateMedia({ colorScheme: 'dark' });

    const dark = await page
      .getByTestId('asciidoc-output')
      .evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]);
    expect(dark).toEqual(light);
    expect(await computed(page, 'h2', 'color')).toBe('rgb(139, 0, 0)');
  });

  test('a theme with nothing wrong shows no diagnostics surface at all', async ({ page }) => {
    await openPrintPreview(page, projectId, 'themed.adoc');
    await expect(page.getByLabel('Print preview appearance diagnostics')).toHaveCount(0);
  });

  test('an invalid theme keeps the document, reports itself, and does not move the page', async ({
    page,
  }) => {
    await openPrintPreview(page, projectId, 'themed.adoc');
    const before = await page
      .getByTestId('print-page-viewport')
      .evaluate((element) => element.getBoundingClientRect().width);

    await writeFileContent(page, projectId, themeNodeId, 'base:\n  - [\n');

    await expect(page.getByLabel('Print preview appearance diagnostics')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('asciidoc-output')).toContainText('Body text');
    // The last interpretable appearance is held, so the column is exactly where it was.
    const after = await page
      .getByTestId('print-page-viewport')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(after).toBeCloseTo(before, 0);
  });

  test('a reported problem reveals its source in the editor', async ({ page }) => {
    await writeFileContent(
      page,
      projectId,
      themeNodeId,
      'extends: default\nbase:\n  font_color: not-a-colour\n',
    );
    await openPrintPreview(page, projectId, 'themed.adoc');

    await expect(page.getByLabel('Print preview appearance diagnostics')).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: /^Go to brand-theme\.yml/ }).click();
    // Revealing it means opening the theme document — the same navigation the PDF's own diagnostics
    // perform, which is the point of reporting both through one surface.
    await expect(page.getByTestId('tree-node-brand-theme.yml')).toHaveClass(SELECTED, {
      timeout: 15_000,
    });
  });

  test('values with no counterpart on an unpaginated page are ignored, and the rest applies', async ({
    page,
  }) => {
    await writeFileContent(
      page,
      projectId,
      themeNodeId,
      `${THEME}running_content:\n  start_at: toc\nfooter:\n  height: 0.75in\n  recto:\n    right:\n      content: "{page-number}"\n`,
    );
    await openPrintPreview(page, projectId, 'themed.adoc');

    await expect.poll(async () => computed(page, 'h2', 'color'), { timeout: 20_000 }).toBe(
      'rgb(139, 0, 0)',
    );
    await expect(page.getByLabel('Print preview appearance diagnostics')).toHaveCount(0);
    // No page number anywhere: the page is one continuous column, not a paginated document.
    await expect(page.getByTestId('asciidoc-output')).not.toContainText('1');
  });

  test('a theme naming a font nobody supplies falls back and says the appearance is approximate', async ({
    page,
  }) => {
    await writeFileContent(
      page,
      projectId,
      themeNodeId,
      'extends: default\nbase:\n  font_family: Nonesuch Display\n',
    );
    await openPrintPreview(page, projectId, 'themed.adoc');

    const surface = page.getByLabel('Print preview appearance diagnostics');
    await expect(surface).toBeVisible({ timeout: 20_000 });
    await expect(surface).toContainText('Nonesuch Display');
    await expect(page.getByTestId('asciidoc-output')).toContainText('Body text');
  });
});

test.describe('the Print preview with no theme at all', () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Print No Theme ${Date.now()}`);
    const fileNodeId = await createTestFile(page, projectId, null, 'plain.adoc');
    await writeFileContent(page, projectId, fileNodeId, SOURCE);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test("uses the export's default appearance and geometry, and reports nothing", async ({ page }) => {
    await openPrintPreview(page, projectId, 'plain.adoc');

    // A4 at 96/72 is 793.7 CSS pixels wide; the default margin is 0.5in at the top. `offsetWidth` is
    // the laid-out width, taken before the pane's fit-to-width transform rather than after it.
    const geometry = await page.getByTestId('asciidoc-output').evaluate((element: HTMLElement) => {
      const style = getComputedStyle(element);
      return {
        width: element.offsetWidth,
        paddingTop: Number.parseFloat(style.paddingTop),
        background: style.backgroundColor,
      };
    });
    expect(geometry.width).toBeCloseTo(793.7, 0);
    expect(geometry.paddingTop).toBeCloseTo(48, 0);
    expect(geometry.background).toBe('rgb(255, 255, 255)');
    await expect(page.getByLabel('Print preview appearance diagnostics')).toHaveCount(0);
  });
});
