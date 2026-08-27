import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { openFileInEditor, typeInEditor } from './helpers/review';
import {
  commitViaUi,
  completeConflictResolutionViaUi,
  createFileViaUi,
  createProjectViaUi,
  importViaUi,
  initializeViaUi,
  openConflictPanel,
  pullViaUi,
  pushViaUi,
  replaceEditorContentViaUi,
  requireRemote,
  takeTheirsViaUi,
} from './helpers/git';

// Requires a real, reachable, WRITABLE test git remote (GIT_E2E_REMOTE_URL / GIT_E2E_REMOTE_TOKEN /
// optionally GIT_E2E_REMOTE_PROVIDER — see helpers/git.ts) plus apps/api + the git-worker running.
// A genuine merge conflict needs BOTH sides to have diverged: a second project, cloned from the same
// remote branch and driven through its OWN editor in a second browser context, edits and pushes a
// change to the same line this project edits locally (without pushing) — so the pull below pauses on
// a real conflict rather than fast-forwarding.

const FILE_NAME = 'conflicts.adoc';

test.describe('Git conflicts — a pull that collides with an unpushed local commit pauses for resolution', () => {
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

  test('resolving the conflicting file with "Take theirs" completes the pull with the remote wording', async ({
    page,
    browser,
  }) => {
    const remote = requireRemote();
    const branch = `e2e-conflicts-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Conflicts ${Date.now()}`);
    await createFileViaUi(page, FILE_NAME);
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, 'Shared line one\nShared line two — original wording\n');
    await initializeViaUi(page, projectId, remote, branch);
    await openFileInEditor(page, projectId, FILE_NAME);

    // Local side: edit the shared line and commit it locally — deliberately WITHOUT pushing, so the
    // branch is ahead of the remote when the collaborator's push below lands.
    await replaceEditorContentViaUi(page, 'Shared line one\nShared line two — LOCAL edit\n');
    await commitViaUi(page, 'Local edit of the shared line');

    // A second collaborator, on their own project cloned from the same remote branch, edits the very
    // same line differently — through their own editor — and pushes first.
    const collaboratorContext = await browser.newContext();
    try {
      const collaboratorPage = await collaboratorContext.newPage();
      await signIn(collaboratorPage);
      const collaboratorProjectId = await importViaUi(collaboratorPage, remote, { branch });
      await openFileInEditor(collaboratorPage, collaboratorProjectId, FILE_NAME);
      await replaceEditorContentViaUi(collaboratorPage, 'Shared line one\nShared line two — REMOTE edit\n');
      await commitViaUi(collaboratorPage, 'External edit of the shared line');
      await pushViaUi(collaboratorPage);
      await cleanupProject(collaboratorPage, collaboratorProjectId);
    } finally {
      await collaboratorContext.close();
    }

    // Pull: with both a local commit ahead and a conflicting remote commit, this pauses on conflict
    // rather than completing — the header's destructive "Resolve conflicts" button is how that
    // becomes visible.
    await pullViaUi(page);

    const conflictPanel = await openConflictPanel(page);
    await expect(conflictPanel.getByText(FILE_NAME)).toBeVisible({ timeout: 15_000 });

    // Nothing is resolved yet — Complete stays disabled.
    const completeButton = conflictPanel.getByRole('button', { name: 'Complete' });
    await expect(completeButton).toBeDisabled();

    await takeTheirsViaUi(conflictPanel, FILE_NAME);
    await expect(completeButton).toBeEnabled({ timeout: 15_000 });

    await completeConflictResolutionViaUi(conflictPanel);

    // The pull finished: the destructive conflicts button is gone, and the remote's wording won.
    await expect(page.getByRole('button', { name: 'Resolve conflicts' })).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.cm-editor .cm-content')).toContainText('Shared line two — REMOTE edit', {
      timeout: 20_000,
    });
  });
});
