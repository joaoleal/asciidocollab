import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { importViaUi, requireRemote } from './helpers/git';

// Requires a real, reachable, WRITABLE test git remote (GIT_E2E_REMOTE_URL / GIT_E2E_REMOTE_TOKEN /
// optionally GIT_E2E_REMOTE_PROVIDER — see helpers/git.ts) plus apps/api + the git-worker running.

test.describe('Git import — a remote repository clones into a new project the importer owns', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  // Populated only once the import actually creates a project, so cleanup stays a no-op otherwise.
  let importedProjectId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test.afterEach(async ({ page }) => {
    if (importedProjectId) await cleanupProject(page, importedProjectId);
    importedProjectId = undefined;
  });

  test('cloning the test remote through the dashboard\'s Import dialog produces a new project, ready to open with its files and history intact', async ({
    page,
  }) => {
    const remote = requireRemote();

    importedProjectId = await importViaUi(page, remote);

    // Landed straight in the new project's editor, its file tree already populated from the clone.
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('file-tree')).toBeVisible({ timeout: 10_000 });

    // It carries a real, connected repository — not a placeholder — with a resolved branch and a
    // normal, caught-up sync state.
    await expect(page.locator('[title="Current branch"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Up to date', { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test('starting an import from an unreachable remote surfaces a visible error in the dialog, and never navigates away', async ({
    page,
  }) => {
    requireRemote();

    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Import from Git' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByText('Import a repository') });
    await expect(dialog.getByText('Import a repository')).toBeVisible({ timeout: 10_000 });

    await dialog.getByRole('radiogroup', { name: 'Git hosting provider' }).getByRole('radio', { name: 'GitHub' }).click();
    await dialog.getByLabel('Remote URL').fill('https://example.invalid/definitely-not-a-real/repository.git');
    await dialog.getByLabel('Access token').fill('not-a-real-token');
    await dialog.getByRole('button', { name: 'Start import' }).click();

    // Either a typed `FAILED` outcome or the operation simply never reaching SUCCEEDED within the
    // dialog's own polling both surface as a visible alert here — which is all this asserts.
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
