import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';
import { setEditorPreferences, resetEditorPreferences } from './helpers/editor-preferences';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * A horizontal scrollbar is a LAYOUT fact: it exists only once a real engine has measured the content
 * against the pane. The CSS cascade behind it is unit-tested (tests/styles/preview-wrapping.test.ts),
 * but "the preview does not scroll sideways" can only be asserted where boxes have widths — hence this
 * spec rather than another jsdom test.
 *
 * Reported case: a `----` listing block holding one very long line. It rendered with `white-space: pre`,
 * so the line ran off to the right and the reader had to drag a scrollbar to read it.
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

/** The reported source, plus the other unbreakable-content shapes on the same surface. */
const LONG_LINE =
  'long text: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ' +
  'ullamco laboris nisi ut aliquip ex ea commodo consequat.';
const LONG_TOKEN = `https://example.com/${'a'.repeat(300)}`;
const SOURCE = `regular text

----
${LONG_LINE}
----

A paragraph with an unbreakable token: ${LONG_TOKEN}

=== A heading with ${LONG_TOKEN}

|===
| ${LONG_TOKEN}
|===

\`${LONG_TOKEN}\`

[%nowrap]
----
| aligned | columns | must | survive |
${LONG_LINE}
----
`;

/** Open the project, select the file, wait for the synced document, and expand the preview. */
async function openPreview(page: Page, projectId: string, fileName: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`tree-node-${fileName}`).click();
  // The preview renders the collaboratively-synced document, so wait for it to sync IN before
  // expanding — otherwise the preview can be measured against an empty pre-sync render.
  await expect(page.locator('.cm-editor .cm-content')).toContainText('regular text', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: /expand preview/i }).click();
  await expect(page.getByTestId('asciidoc-output')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('asciidoc-output')).toContainText('regular text', { timeout: 15_000 });
}

/** Overflow in CSS pixels: how much wider the content is than the box that has to hold it. */
async function horizontalOverflow(page: Page, selector: string, nth = 0): Promise<number> {
  return page.locator(selector).nth(nth).evaluate((element) => element.scrollWidth - element.clientWidth);
}

test.describe('HTML preview does not scroll sideways', () => {
  // Headroom for the collaborative Yjs sync the preview renders from, under heavy parallel load.
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    // The `asciidocollab` case never clicks a style — it measures whatever the panel opens in — so
    // the style has to be established rather than assumed: the shared account remembers whichever one
    // another spec last picked.
    await setEditorPreferences(page, { previewStyle: 'asciidocollab' });
    projectId = await createProject(page, `Preview Overflow ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    // Cleanup first, so a failing reset cannot strand the project (the reset asserts on its requests).
    if (projectId) await cleanupProject(page, projectId);
    // The `asciidoctor` case stores that style on the account; put the default back.
    await resetEditorPreferences(page);
  });

  for (const style of ['asciidocollab', 'asciidoctor'] as const) {
    test(`long verbatim lines, prose and cells stay inside the pane (${style} style)`, async ({
      page,
    }) => {
      const fileNodeId = await createTestFile(page, projectId, null, 'overflow.adoc');
      await writeFileContent(page, projectId, fileNodeId, SOURCE);
      await openPreview(page, projectId, 'overflow.adoc');
      if (style === 'asciidoctor') {
        await page.getByTestId('preview-style-asciidoctor').click();
        await expect(page.getByTestId('asciidoc-output')).toHaveAttribute(
          'data-preview-style',
          'asciidoctor',
        );
      }

      // The pane itself: nothing inside it — long prose token, heading, table cell, inline code, or the
      // listing block — may push the scroll container wider than its own viewport. A 1px tolerance
      // absorbs sub-pixel rounding.
      expect(
        await horizontalOverflow(page, '[data-testid="preview-scroll-container"]'),
        'the preview pane must not scroll horizontally',
      ).toBeLessThanOrEqual(1);

      // The first listing block is the reported case: it must wrap in its card, not scroll.
      expect(
        await horizontalOverflow(page, '[data-testid="asciidoc-output"] .listingblock pre', 0),
        'a long line in a `----` block must wrap instead of scrolling',
      ).toBeLessThanOrEqual(1);
    });
  }

  test('an author who asks for no wrapping still gets a scrollbar, not clipped text', async ({ page }) => {
    // `[%nowrap]` (and `:prewrap!:`) mean "preserve my columns". Honouring that necessarily reintroduces
    // a scrollbar for THAT block — the one thing it must never do is hide the overflow, because then the
    // text is simply gone.
    const fileNodeId = await createTestFile(page, projectId, null, 'overflow.adoc');
    await writeFileContent(page, projectId, fileNodeId, SOURCE);
    await openPreview(page, projectId, 'overflow.adoc');

    const nowrapBlock = page.locator('[data-testid="asciidoc-output"] .listingblock pre.nowrap');
    await expect(nowrapBlock).toHaveCount(1);
    expect(
      await nowrapBlock.evaluate((element) => getComputedStyle(element).overflowX),
      'an opted-out block must scroll, never hide its overflow',
    ).toBe('auto');
    expect(
      await horizontalOverflow(page, '[data-testid="asciidoc-output"] .listingblock pre.nowrap'),
      'the opted-out block keeps its own horizontal scroll',
    ).toBeGreaterThan(1);
    // …and it still must not drag the whole pane sideways: the card scrolls, the page does not.
    expect(
      await horizontalOverflow(page, '[data-testid="preview-scroll-container"]'),
    ).toBeLessThanOrEqual(1);
  });
});
