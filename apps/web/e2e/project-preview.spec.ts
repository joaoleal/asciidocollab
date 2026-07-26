import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function writeFileContent(
  page: Parameters<typeof signIn>[0],
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
 * The preview renders the collaboratively-synced Yjs document, and the editor content IS that
 * synced document. Asserting preview/editor content before the collab provider finishes connecting
 * races an empty pre-sync document. The "connecting" banner is removed once the provider is synced,
 * so wait for it to clear after selecting a file and before asserting any content.
 */
async function waitCollabSynced(page: Parameters<typeof signIn>[0]): Promise<void> {
  await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('AsciiDoc live preview', () => {
  // Per-test headroom for slow collaborative Yjs sync under heavy parallel CI load.
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Preview Test ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('opening an AsciiDoc file and expanding the preview renders HTML output', async ({ page }) => {
    // Headroom for the collaborative Yjs sync the preview renders from, under heavy parallel load.
    test.setTimeout(60_000);
    const fileNodeId = await createTestFile(page, projectId, null, 'hello.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Hello World\n\nThis is a *test* document.\n');

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });

    await page.getByTestId('tree-node-hello.adoc').click();
    // The preview renders the collaboratively-synced editor document, so wait for that document to
    // actually sync IN — the known title appearing in the editor — before expanding. Asserting on the
    // editor content is a stronger signal than the "connecting" banner clearing, whose absence is racy
    // right after mount (it can read 0 before the provider has even begun connecting), letting the
    // preview expand against an empty pre-sync document that schedules no render.
    await expect(page.locator('.cm-editor .cm-content')).toContainText('Hello World', { timeout: 30_000 });
    await page.getByRole('button', { name: /expand preview/i }).click();

    // The rendered output container must appear — this test failed before the worker was
    // fixed to use the webpack-bundled factory (bare import broke the classic worker).
    await expect(
      page.getByTestId('asciidoc-output'),
      'Preview panel must render AsciiDoc to HTML via the bundled web worker',
    ).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId('asciidoc-output')).toContainText('Hello World', { timeout: 15_000 });
  });

  test('editing the document causes the preview to update (live update)', async ({ page }) => {
    const fileNodeId = await createTestFile(page, projectId, null, 'live.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Initial Title\n\nInitial content.\n');

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    await page.getByTestId('tree-node-live.adoc').click();
    await waitCollabSynced(page);
    await page.getByRole('button', { name: /expand preview/i }).click();

    await expect(page.getByTestId('asciidoc-output')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('asciidoc-output')).toContainText('Initial Title', { timeout: 15_000 });

    // Type new content into the editor
    const editorContent = page.locator('.cm-editor .cm-content');
    await editorContent.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\nNew paragraph added.');

    await expect(
      page.getByTestId('asciidoc-output'),
      'Preview must update after editor content changes',
    ).toContainText('New paragraph added.', { timeout: 10_000 });
  });

  test('scroll sync toggle is visible in the preview panel and can be toggled', async ({ page }) => {
    const fileNodeId = await createTestFile(page, projectId, null, 'sync.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Sync Test\n\nSome content.\n');

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    await page.getByTestId('tree-node-sync.adoc').click();
    await waitCollabSynced(page);
    await page.getByRole('button', { name: /expand preview/i }).click();

    const toggle = page.getByTestId('scroll-sync-toggle');
    await expect(toggle).toBeVisible({ timeout: 5000 });

    // Disabled by default
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Enable
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Disable again
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking a line in the editor scrolls the preview to the corresponding section', async ({ page }) => {
    // Build a document with two clearly separated sections separated by enough filler paragraphs
    // that the second section cannot be visible without scrolling.
    // Each filler entry is a real AsciiDoc paragraph (blank line before + content + blank line after).
    const fillerParagraphs = Array.from({ length: 20 }, (_, index) => [`Filler paragraph ${index + 1} with enough text to generate rendered height.`, '']).flat();
    const lines = [
      '= First Section',
      '',
      'Paragraph in the first section.',
      '',
      ...fillerParagraphs,
      '== Second Section',
      '',
      'Content of the second section.',
    ];
    const content = lines.join('\n') + '\n';

    const fileNodeId = await createTestFile(page, projectId, null, 'click-scroll.adoc');
    await writeFileContent(page, projectId, fileNodeId, content);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    await page.getByTestId('tree-node-click-scroll.adoc').click();
    await waitCollabSynced(page);
    await page.getByRole('button', { name: /expand preview/i }).click();

    // Wait for the preview to fully render both sections
    const previewOutput = page.getByTestId('asciidoc-output');
    await expect(previewOutput).toBeVisible({ timeout: 20_000 });
    await expect(previewOutput).toContainText('First Section', { timeout: 15_000 });
    await expect(previewOutput).toContainText('Second Section');

    // The second section heading in the preview should have a data-source-line attribute.
    // Find a line in the editor that falls within "== Second Section" (around line 19-20).
    // We click on the editor content at that line.
    const editorContent = page.locator('.cm-editor .cm-content');
    await editorContent.click();

    // Navigate cursor to the "Second Section" line via keyboard
    await page.keyboard.press('Control+Home');
    // Move down to the second section heading (line 45 in 1-based → 44 ArrowDown presses)
    for (let index = 0; index < 44; index++) {
      await page.keyboard.press('ArrowDown');
    }

    // Click the current line in the editor to trigger onLineClick
    const activeLineLocator = page.locator('.cm-editor .cm-activeLine');
    await activeLineLocator.click();

    // The preview scroll container should scroll so "Second Section" is visible
    const scrollContainer = page.getByTestId('preview-scroll-container');
    await expect(async () => {
      const scrollTop = await scrollContainer.evaluate((element) => element.scrollTop);
      expect(scrollTop, 'Preview scroll container must have scrolled away from the top').toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });
  });

  test('ctrl+click scrolls the preview: first line goes to top, last line shows bottom section', async ({ page }) => {
    // Build a long document with many filler PARAGRAPHS so the rendered preview is tall enough
    // to require scrolling. Each paragraph needs a blank line separator.
    const fillerParagraphs = Array.from(
      { length: 30 },
      (_, index) => [`Filler paragraph ${index + 1} with enough words to take up vertical space in the rendered output.`, ''],
    ).flat();
    const lines = [
      '= Document Title',
      '',
      'Opening paragraph.',
      '',
      ...fillerParagraphs,
      '== Last Section',
      '',
      'This section is at the very bottom.',
    ];
    const content = lines.join('\n') + '\n';

    const fileNodeId = await createTestFile(page, projectId, null, 'ctrl-scroll.adoc');
    await writeFileContent(page, projectId, fileNodeId, content);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    await page.getByTestId('tree-node-ctrl-scroll.adoc').click();
    await waitCollabSynced(page);
    await page.getByRole('button', { name: /expand preview/i }).click();

    const previewOutput = page.getByTestId('asciidoc-output');
    await expect(previewOutput).toBeVisible({ timeout: 20_000 });
    await expect(previewOutput).toContainText('Document Title', { timeout: 15_000 });
    await expect(previewOutput).toContainText('Last Section');

    const scrollContainer = page.getByTestId('preview-scroll-container');

    // --- Step 1: Ctrl+click on last line → preview scrolls to show "Last Section" ---
    const editorContent = page.locator('.cm-editor .cm-content');
    await editorContent.click();
    await page.keyboard.press('Control+End');

    // Wait for the caret to actually REACH the last line before clicking the active line. Pressing a
    // key and clicking `.cm-activeLine` in the next breath is a race: under parallel load the keypress
    // may not have been applied yet, so the click lands on whichever line was active before — and the
    // assertion below then measures a scroll to the wrong place. `toHaveClass` retries until the class
    // has moved, which is the event actually being waited for.
    const editorLines = page.locator('.cm-editor .cm-line');
    await expect(editorLines.last()).toHaveClass(/cm-activeLine/, { timeout: 10_000 });
    const activeLineLocator = page.locator('.cm-editor .cm-activeLine');
    await activeLineLocator.click({ modifiers: ['Control'] });

    await expect(async () => {
      const scrollTop = await scrollContainer.evaluate((element) => element.scrollTop);
      expect(scrollTop, 'Preview must scroll down after clicking last line').toBeGreaterThan(0);
    }).toPass({ timeout: 5000 });

    // --- Step 2: Ctrl+click on first line → preview scrolls back to the top ---
    await page.keyboard.press('Control+Home');
    // Same wait as step 1, and this is the one that actually flaked: clicking before the caret moved
    // ctrl+clicked the LAST line again, scrolling the preview down when the assertion wants it at top.
    await expect(editorLines.first()).toHaveClass(/cm-activeLine/, { timeout: 10_000 });
    const firstLineLocator = page.locator('.cm-editor .cm-activeLine');
    await firstLineLocator.click({ modifiers: ['Control'] });

    // The document title (<h1 data-source-line="1">) is at the very top of the preview.
    // Clicking line 1 should scroll back to near the top. The exact value depends on
    // container padding and h1 default margins (~55px in practice).
    await expect(async () => {
      const scrollTop = await scrollContainer.evaluate((element) => element.scrollTop);
      expect(scrollTop, 'Preview must scroll back to the top after clicking the first line').toBeLessThan(100);
    }).toPass({ timeout: 8000 });
  });

  test('scroll sync causes the preview to scroll when the editor is scrolled', async ({ page }) => {
    // Build a long document with enough paragraphs that the rendered preview requires scrolling.
    const fillerParagraphs = Array.from(
      { length: 30 },
      (_, index) => [`Content paragraph ${index + 3} with enough text to generate real rendered height.`, ''],
    ).flat();
    const lines = [
      '= Main Title',
      '',
      ...fillerParagraphs,
      '== Remote Section',
      '',
      'This section is far down.',
    ];
    const content = lines.join('\n') + '\n';

    const fileNodeId = await createTestFile(page, projectId, null, 'scroll-sync.adoc');
    await writeFileContent(page, projectId, fileNodeId, content);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    await page.getByTestId('tree-node-scroll-sync.adoc').click();
    await waitCollabSynced(page);
    await page.getByRole('button', { name: /expand preview/i }).click();

    // Wait for preview to render
    const previewOutput = page.getByTestId('asciidoc-output');
    await expect(previewOutput).toBeVisible({ timeout: 20_000 });
    await expect(previewOutput).toContainText('Remote Section', { timeout: 15_000 });

    // Enable scroll sync
    const toggle = page.getByTestId('scroll-sync-toggle');
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Scroll the editor to a line far down (triggers onScrollLine → preview scroll)
    const editorContent = page.locator('.cm-editor .cm-content');
    await editorContent.click();
    await page.keyboard.press('Control+End');

    // After scrolling editor to bottom, preview should also have scrolled
    const scrollContainer = page.getByTestId('preview-scroll-container');
    await expect(async () => {
      const scrollTop = await scrollContainer.evaluate((element) => element.scrollTop);
      expect(scrollTop, 'Preview panel must scroll when scroll sync is enabled and editor is scrolled').toBeGreaterThan(0);
    }).toPass({ timeout: 8000 });
  });
});
