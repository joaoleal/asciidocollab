import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, openFile, getEditorText, renameFirstWord, COLLAB_EDIT_TEST_TIMEOUT } from './helpers/editor';

// Feature 033: renaming an explicit anchor DEFINITION (`[[id]]`) offers a project-wide refactor
// of every cross-reference (`<<id>>` / `xref:id[]`) to the new id, applied in one click and undoable.

/** Select the anchor id in the definition and replace it, leaving the cursor in it. */
async function renameAnchorTo(page: Page, newId: string): Promise<void> {
  // The first `install` in DOM order is the `[[install]]` definition on line 1.
  await renameFirstWord(page, 'install', newId);
}

test.describe('033 — anchor rename suggestion', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(COLLAB_EDIT_TEST_TIMEOUT); // these tests live-edit the collab editor — see the constant
    await signIn(page);
    projectId = await createProject(page, `Rename Anchor ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('suggests, rewrites the xref, and undo restores', async ({ page }) => {
    await createAdocFile(page, projectId, 'main.adoc', '[[install]]\n== Install\n\nJump to <<install>> now.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'install');

    await renameAnchorTo(page, 'setup');

    const suggestion = page.getByTestId('rename-suggestion');
    // The offer appears after the 1s settle plus two project-wide usage lookups; give those API calls
    // headroom under parallel gate load (they occasionally run several seconds slower than steady state).
    await expect(suggestion).toBeVisible({ timeout: 20_000 });
    await expect(suggestion).toContainText('install');
    await expect(suggestion).toContainText('setup');

    await page.getByTestId('rename-suggestion-apply').click();

    // The cross-reference is rewritten to the new id; the definition already carried it.
    await expect.poll(() => getEditorText(page)).toContain('<<setup>>');
    expect(await getEditorText(page)).toContain('[[setup]]');
    expect(await getEditorText(page)).not.toContain('<<install>>');

    // Undo reverses definition + reference in one action.
    await page.getByTestId('rename-suggestion-undo').click();
    await expect.poll(() => getEditorText(page)).toContain('<<install>>');
    expect(await getEditorText(page)).toContain('[[install]]');
    expect(await getEditorText(page)).not.toContain('<<setup>>');
  });
});
