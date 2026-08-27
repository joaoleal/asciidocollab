import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { openFileInEditor, typeInEditor } from './helpers/review';
import {
  commitViaUi,
  createFileViaUi,
  createProjectViaUi,
  expectAheadBadge,
  expectUpToDate,
  initializeViaUi,
  pushViaUi,
  requireRemote,
} from './helpers/git';

// Requires a real, reachable, WRITABLE test git remote (GIT_E2E_REMOTE_URL / GIT_E2E_REMOTE_TOKEN /
// optionally GIT_E2E_REMOTE_PROVIDER — see helpers/git.ts) plus apps/api + the git-worker running.

test.describe('Git commit and push — staged changes land on the remote and the status bar catches up', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('committing an edit through the Commit dialog, then pushing through the status bar, brings the branch fully up to date', async ({
    page,
  }) => {
    const remote = requireRemote();
    const fileName = 'commit-push.adoc';
    const branch = `e2e-commit-push-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Commit Push ${Date.now()}`);
    await createFileViaUi(page, fileName);

    // Publish the file's current (empty) content as the base commit of a fresh test-remote branch.
    await openFileInEditor(page, projectId, fileName);
    await typeInEditor(page, 'Base content published at initialize time.\n');
    await initializeViaUi(page, projectId, remote, branch);

    // The initialize navigated to the settings page — back into the editor for the rest of the flow.
    await openFileInEditor(page, projectId, fileName);
    await typeInEditor(page, 'A paragraph added by the commit-and-push e2e test.\n');

    await commitViaUi(page, 'Add a paragraph via the e2e suite');
    await expectAheadBadge(page, 1);

    await pushViaUi(page);
    await expectUpToDate(page);
  });

  test('the Commit dialog refuses to commit when nothing is staged', async ({ page }) => {
    const remote = requireRemote();
    const fileName = 'nothing-to-commit.adoc';
    const branch = `e2e-nothing-staged-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Nothing Staged ${Date.now()}`);
    await createFileViaUi(page, fileName);
    await openFileInEditor(page, projectId, fileName);
    await typeInEditor(page, 'Content published at initialize time only.\n');
    await initializeViaUi(page, projectId, remote, branch);
    await openFileInEditor(page, projectId, fileName);

    // Immediately after initialize the working tree is clean — nothing new to commit yet.
    await page.getByRole('button', { name: 'Commit…' }).click();
    const commitDialog = page.getByRole('dialog').filter({ has: page.getByText('Commit changes') });
    await expect(commitDialog.getByText('Nothing staged to commit.')).toBeVisible({ timeout: 10_000 });
    await expect(commitDialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();

    await commitDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(commitDialog).toBeHidden({ timeout: 10_000 });
  });
});
