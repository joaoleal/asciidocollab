import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import type { Page } from '@playwright/test';
import { createAdocFile, openProject, openFile, getEditorText, editorContent, renameFirstWord, expandPreview, COLLAB_EDIT_TEST_TIMEOUT } from './helpers/editor';

/** Select the attribute name in the definition line and replace it, leaving the cursor in it. */
async function renameDefinitionTo(page: Page, newName: string): Promise<void> {
  // The first `edition` in DOM order is the definition on line 1 (the `{edition}` reference is later).
  await renameFirstWord(page, 'edition', newName);
}

// Feature 033: renaming an attribute DEFINITION offers a project-wide refactor of every
// `{name}` reference. The suggestion appears ~2s after the edit settles, applies in one click via
// the reused rename endpoint, and is undoable in one action. A new name that collides with an
// existing attribute blocks the apply.

test.describe('033 — attribute rename suggestion', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(COLLAB_EDIT_TEST_TIMEOUT); // these tests live-edit the collab editor — see the constant
    await signIn(page);
    projectId = await createProject(page, `Rename Suggestion ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('suggests, applies across the file, and undo restores', async ({ page }) => {
    await createAdocFile(page, projectId, 'main.adoc', ':edition: 1\n\nSee {edition} for details.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'edition');

    await renameDefinitionTo(page, 'release');

    // The suggestion appears once the 2s settle elapses and the project-wide lookup returns.
    const suggestion = page.getByTestId('rename-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 20_000 }); // API headroom under parallel gate load
    await expect(suggestion).toContainText('edition');
    await expect(suggestion).toContainText('release');

    await page.getByTestId('rename-suggestion-apply').click();

    // The stale `{edition}` reference (unresolved against the renamed `:release:` definition, so it
    // renders literally) is rewritten to `{release}`, which now resolves to the value `1` — the
    // editor folds a resolved reference to its value. Its disappearance proves the reference rewrite;
    // the definition keeps the new name.
    await expect.poll(() => getEditorText(page)).not.toContain('{edition}');
    expect(await getEditorText(page)).toContain(':release: 1');
    expect(await getEditorText(page)).toContain('See 1 for details.');

    // The preview resolves the renamed reference to the attribute value — zero unresolved refs.
    await expandPreview(page);
    const output = page.getByTestId('asciidoc-output');
    await expect(output).toContainText('See 1 for details.', { timeout: 15_000 });
    await expect(output).not.toContainText('{');

    // Undo reverses the whole rename in one action: the definition and reference return to
    // the original name (the reference again resolves and folds to its value).
    await page.getByTestId('rename-suggestion-undo').click();
    await expect.poll(() => getEditorText(page)).toContain(':edition: 1');
    expect(await getEditorText(page)).not.toContain('{release}');
  });

  test('triggers for an inline {set:name:value} definition', async ({ page }) => {
    await createAdocFile(page, projectId, 'main.adoc', '{set:edition:1}\n\nSee {edition} for details.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'edition');

    // The inline {set:} folds to a value widget; place the cursor on line 1 to reveal the raw source,
    // then select the name and rename it. Wait for the editor to be editable first so the type is not
    // dropped against a still-syncing (read-only) document under parallel load, then confirm it landed.
    await expect(editorContent(page)).toHaveAttribute('contenteditable', 'true', { timeout: 15_000 });
    await editorContent(page).locator('.cm-line').first().click();
    await editorContent(page).getByText('edition', { exact: false }).first().dblclick();
    await page.keyboard.type('release');
    await expect(editorContent(page)).toContainText('release', { timeout: 10_000 });

    const suggestion = page.getByTestId('rename-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 20_000 }); // API headroom under parallel gate load
    await expect(suggestion).toContainText('edition');
    await expect(suggestion).toContainText('release');

    await page.getByTestId('rename-suggestion-apply').click();
    // The `{edition}` reference is rewritten to `{release}`, which resolves to the value (folds to 1).
    await expect.poll(() => getEditorText(page)).not.toContain('{edition}');
    expect(await getEditorText(page)).toContain('See 1 for details.');
  });

  test('blocks apply when the new name collides with an existing attribute', async ({ page }) => {
    await createAdocFile(page, projectId, 'main.adoc', ':edition: 1\n:release: 2\n\nSee {edition}.\n');
    await openProject(page, projectId);
    await openFile(page, 'main.adoc', 'edition');

    await renameDefinitionTo(page, 'release');

    const suggestion = page.getByTestId('rename-suggestion');
    await expect(suggestion).toBeVisible({ timeout: 20_000 }); // API headroom under parallel gate load
    await expect(suggestion).toHaveAttribute('data-collision', 'true');
    await expect(suggestion).toContainText('already exists');
    await expect(page.getByTestId('rename-suggestion-apply')).toHaveCount(0);
  });
});
