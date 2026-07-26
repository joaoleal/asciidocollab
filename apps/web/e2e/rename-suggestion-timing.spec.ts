import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, openFile, editorContent, renameFirstWord, COLLAB_EDIT_TEST_TIMEOUT } from './helpers/editor';

// Feature 033: the suggestion appears only after the ~1s settle, and after the cursor leaves
// the definition it disappears ~5s later — unless the cursor returns within that window.

/** Rename the `:edition:` definition to `:release:`, leaving the cursor in it. */
async function renameDefinition(page: Page): Promise<void> {
  await renameFirstWord(page, 'edition', 'release');
}

test.describe('033 — suggestion timing & location', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(COLLAB_EDIT_TEST_TIMEOUT); // these tests live-edit the collab editor — see the constant
    await signIn(page);
    projectId = await createProject(page, `Rename Timing ${Date.now()}`);
    await createAdocFile(page, projectId, 'main.adoc', ':edition: 1\n\nSee {edition}.\n\nMore body text here.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'edition');
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('does not appear until ~1s after the edit settles', async ({ page }) => {
    await renameDefinition(page);
    const suggestion = page.getByTestId('rename-suggestion');
    // Immediately after typing, the 1s settle has not elapsed.
    await expect(suggestion).toBeHidden();
    await page.waitForTimeout(400);
    await expect(suggestion).toBeHidden(); // still well within the ~1s settle window
    await expect(suggestion).toBeVisible({ timeout: 4000 }); // appears after the settle + lookup
  });

  test('hides ~5s after leaving, but returning within the window keeps it', async ({ page }) => {
    await renameDefinition(page);
    const suggestion = page.getByTestId('rename-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 6000 });

    // Leave the definition, return before 5s → the disappearance is cancelled.
    await editorContent(page).getByText('More body text here.').click();
    await page.waitForTimeout(2500);
    await expect(suggestion).toBeVisible();
    // Return the cursor to the definition (document start, on `:release:`) — a click would land on the
    // widget's own text, so move via the keyboard on the focused editor.
    await page.keyboard.press('ControlOrMeta+Home');
    await page.waitForTimeout(4000); // would have hidden if the leave timer had not been cancelled
    await expect(suggestion).toBeVisible();

    // Leave again and stay away past the 5s window → it disappears.
    await editorContent(page).getByText('More body text here.').click();
    await expect(suggestion).toBeHidden({ timeout: 7000 });
  });
});
