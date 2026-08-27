import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { openFileInEditor, typeInEditor } from './helpers/review';
import { createFileViaUi, createProjectViaUi, initializeViaUi, requireRemote } from './helpers/git';

// The full round trip (the second test below) requires a real, reachable, WRITABLE test git remote
// (GIT_E2E_REMOTE_URL / GIT_E2E_REMOTE_TOKEN / optionally GIT_E2E_REMOTE_PROVIDER — see
// helpers/git.ts) plus apps/api + the git-worker running. The first test is pure UI (form validation
// on the Connect dialog) and needs neither a remote nor the git-worker, so it is not gated behind
// `requireRemote()` — only apps/api + web are needed for it.

test.describe('Git initialize — turning an existing project\'s files into a brand-new remote repository', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProjectViaUi(page, `Git Initialize ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('the Connect and Initialize dialogs keep their submit disabled until a remote URL and a token are both entered', async ({
    page,
  }) => {
    await page.goto(`/dashboard/projects/${projectId}/settings?section=repository`);
    await expect(page.getByText('This project is not connected to a remote git repository.')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Connect to a remote' }).click();
    const connectDialog = page.getByRole('dialog').filter({ has: page.getByText('Connect a remote repository') });
    await expect(connectDialog.getByText('Connect a remote repository')).toBeVisible({ timeout: 10_000 });

    const connectButton = connectDialog.getByRole('button', { name: 'Connect', exact: true });
    await expect(connectButton).toBeDisabled();

    await connectDialog.getByLabel('Remote URL').fill('https://example.invalid/org/repo.git');
    await expect(connectButton).toBeDisabled();

    await connectDialog.getByLabel('Access token').fill('a-placeholder-token');
    await expect(connectButton).toBeEnabled();

    // Leave without submitting — this test only checks the form's own gating, not a real connect.
    await connectDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(connectDialog).toBeHidden({ timeout: 10_000 });
  });

  test('publishing an existing project through "Initialize & publish" connects it to the test remote', async ({
    page,
  }) => {
    const remote = requireRemote();
    const branch = `e2e-initialize-${Date.now()}`;

    await createFileViaUi(page, 'initialize.adoc');
    await openFileInEditor(page, projectId, 'initialize.adoc');
    await typeInEditor(page, 'Content published by the initialize e2e test.\n');

    await initializeViaUi(page, projectId, remote, branch);

    // The dialog closes itself once initialize succeeds, and the section refetches to show the
    // now-connected state (current branch, "Rotate credential"/"Disconnect") instead of the
    // disconnected buttons.
    await expect(page.getByText(branch)).toBeVisible();
    await expect(page.getByText('This project is not connected to a remote git repository.')).toHaveCount(0);
  });
});
