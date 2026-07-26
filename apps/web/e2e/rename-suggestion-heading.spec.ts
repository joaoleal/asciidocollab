import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, openProject, openFile, getEditorText, renameFirstWord, COLLAB_EDIT_TEST_TIMEOUT } from './helpers/editor';

// Feature 033: renaming a section heading whose AUTO-GENERATED id is referenced offers to
// update the cross-references to the new derived id — but only when the heading has no explicit id.

/** Replace the first word of the heading, changing its derived id. */
async function renameHeadingWordTo(page: Page, replacement: string): Promise<void> {
  // The first `Install` in DOM order is the heading on line 1 (the `<<_install_guide>>` xref follows).
  await renameFirstWord(page, 'Install', replacement);
}

test.describe('033 — section-heading auto-id rename suggestion', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(COLLAB_EDIT_TEST_TIMEOUT); // these tests live-edit the collab editor — see the constant
    await signIn(page);
    projectId = await createProject(page, `Rename Heading ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('suggests updating xrefs to the new derived id', async ({ page }) => {
    await createAdocFile(page, projectId, 'main.adoc', '== Install Guide\n\nJump to <<_install_guide>>.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'Install Guide');

    await renameHeadingWordTo(page, 'Setup'); // "Install Guide" → "Setup Guide" ⇒ _setup_guide

    const suggestion = page.getByTestId('rename-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 20_000 }); // API headroom under parallel gate load
    await expect(suggestion).toContainText('_install_guide');
    await expect(suggestion).toContainText('_setup_guide');

    await page.getByTestId('rename-suggestion-apply').click();

    // The cross-reference is rewritten to the heading's new derived id.
    await expect.poll(() => getEditorText(page)).toContain('<<_setup_guide>>');
    expect(await getEditorText(page)).not.toContain('<<_install_guide>>');
    expect(await getEditorText(page)).toContain('Setup Guide'); // heading text is the author's edit
  });

  test('no suggestion when the heading has an explicit id', async ({ page }) => {
    await createAdocFile(page, projectId, 'main.adoc', '[#guide]\n== Install Guide\n\nJump to <<guide>>.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'Install Guide');

    await renameHeadingWordTo(page, 'Setup');

    // The explicit `[#guide]` id is the reference target, unaffected by the heading text — no offer.
    await expect(page.getByTestId('rename-suggestion')).toHaveCount(0, { timeout: 4000 });
  });
});
