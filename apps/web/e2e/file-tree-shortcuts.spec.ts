import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';

// The file tree's keyboard shortcuts, exercised through a real browser.
//
// They are covered by unit tests too, and those tests pass — which is exactly why this file exists.
// A jsdom test dispatches the keydown ON the tree container, so it proves the listener does the right
// thing with an event it is handed, and can say nothing about whether a real keypress ever arrives
// there. That depends on where the browser thinks focus is, and on the bindings having been fetched
// from the server, neither of which jsdom models: `useKeyBindings` starts with an EMPTY map and fills
// it asynchronously, so a tree whose bindings have not landed maps F2 to nothing at all.
//
// The scope is deliberate and is asserted here in both directions: these keys act while the reader is
// working in the tree, and mean whatever the editor says they mean once they are working there.

/** Open a project and wait for its file tree to be usable. */
async function gotoProject(page: Page, projectId: string) {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
  await expect(
    page.getByText(/failed to load files/i),
    'File tree returned an error before the shortcut could be tested.',
  ).not.toBeVisible();
}

/**
 * Select a file the way a user does — by clicking its row — and wait for the click to have taken
 * effect. Selection is what every one of these shortcuts acts on.
 */
async function selectFile(page: Page, name: string) {
  const row = page.getByTestId(`tree-node-${name}`);
  await expect(row).toBeVisible({ timeout: 8000 });
  await row.click();
}

test.describe('File tree keyboard shortcuts', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Tree Shortcuts E2E ${Date.now()}`);
    await createTestFile(page, projectId, null, 'intro.adoc');
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('F2 opens the rename dialog for the selected file', async ({ page }) => {
    await gotoProject(page, projectId);
    await selectFile(page, 'intro.adoc');

    await page.keyboard.press('F2');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole('textbox')).toHaveValue('intro.adoc');
  });

  test('F2 renames the file through the dialog it opens', async ({ page }) => {
    await gotoProject(page, projectId);
    await selectFile(page, 'intro.adoc');

    await page.keyboard.press('F2');
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('textbox').fill('overview.adoc');
    await dialog.getByRole('button', { name: /confirm/i }).click();

    await expect(page.getByTestId('tree-node-overview.adoc')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('tree-node-intro.adoc')).not.toBeVisible();
  });

  test('Delete asks before removing the selected file', async ({ page }) => {
    await gotoProject(page, projectId);
    await selectFile(page, 'intro.adoc');

    await page.keyboard.press('Delete');

    // The confirmation is the point: a shortcut that deleted outright would be one keystroke away
    // from losing a file, with nothing to undo it.
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText(/delete intro\.adoc\?/i)).toBeVisible();
    await expect(page.getByTestId('tree-node-intro.adoc')).toBeVisible();
  });

  test('Ctrl+N opens the new-file dialog for the folder holding the selection', async ({ page }) => {
    await gotoProject(page, projectId);
    await selectFile(page, 'intro.adoc');

    await page.keyboard.press('Control+n');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole('textbox')).toHaveValue('new-document.adoc');
  });

  test('the shortcuts belong to the tree, and stop applying once the editor has the focus', async ({ page }) => {
    await gotoProject(page, projectId);
    await selectFile(page, 'intro.adoc');

    // Open the file and work in it, which is where the focus spends most of its time. From here the
    // tree's keys are the editor's: F2 is the editor's to define, and Delete must delete the
    // character in front of the cursor rather than the file that happens to be selected.
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.type('some text');

    await page.keyboard.press('F2');

    await expect(page.locator('[role="dialog"]')).not.toBeVisible();

    // Clicking back into the tree hands the shortcuts back — the scope follows the focus, so the key
    // is not dead, it belongs to whichever surface the reader is working in.
    await selectFile(page, 'intro.adoc');
    await page.keyboard.press('F2');

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole('textbox')).toHaveValue('intro.adoc');
  });

  test('typing in the find box is not hijacked by the tree shortcuts', async ({ page }) => {
    await gotoProject(page, projectId);
    await selectFile(page, 'intro.adoc');

    // The find panel lives INSIDE the tree container, so the shortcut listener hears every key
    // pressed in its input. Correcting a typo there must edit the text, not delete the selected file.
    await page.keyboard.press('Control+f');
    const search = page.getByRole('textbox', { name: /find/i }).or(page.getByPlaceholder(/find/i));
    await expect(search.first()).toBeVisible({ timeout: 5000 });
    await search.first().fill('intro');
    await search.first().press('Delete');

    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
    await expect(page.getByTestId('tree-node-intro.adoc')).toBeVisible();
  });
});
