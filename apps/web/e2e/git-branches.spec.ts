import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, cleanupProject } from './helpers/test-project';
import { commentOnPassage, openFileInEditor, typeInEditor } from './helpers/review';
import {
  commitViaUi,
  createBranchViaUi,
  createFileViaUi,
  createProjectViaUi,
  initializeViaUi,
  requireRemote,
  switchBranchViaUi,
} from './helpers/git';

// Requires a real, reachable, WRITABLE test git remote (GIT_E2E_REMOTE_URL / GIT_E2E_REMOTE_TOKEN /
// optionally GIT_E2E_REMOTE_PROVIDER — see helpers/git.ts) plus apps/api + apps/collab + the
// git-worker running. Only `initializeViaUi` below reaches the remote at all — every checkout in
// this file is a purely LOCAL branch switch, but a connected repository (which only
// import/connect/initialize can produce) is what makes the branch switcher have any real branches
// to switch between at all.
//
// Same anchor-model caveat as git-pull-live-doc.spec.ts: there is no server-side git<->review
// integration, so the CLIENT re-resolves each comment's anchor only while the document's live
// editing session stays open across the checkout — which is why the file is never closed here.

const FILE_NAME = 'branches.adoc';
const PASSAGE = 'PRESENT-ON-THE-ORIGINAL-BRANCH passage';

test.describe('Git branches — a comment degrades across a checkout that drops its passage, and re-anchors on the way back', () => {
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

  test('switching to a branch without the passage degrades the comment; switching back re-anchors it', async ({
    page,
  }) => {
    const remote = requireRemote();
    const originalBranch = `e2e-branches-original-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Branches ${Date.now()}`);
    await createFileViaUi(page, FILE_NAME);

    // A common base commit with no passage yet — this is the tip the sibling branch below is cut
    // from, so it never sees what gets committed on the original branch afterward.
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, 'Common intro shared by both branches\n');
    await initializeViaUi(page, projectId, remote, originalBranch);
    await openFileInEditor(page, projectId, FILE_NAME);

    const siblingBranch = `e2e-branches-sibling-${Date.now()}`;
    await createBranchViaUi(page, siblingBranch);

    // Still on the original branch: add the passage and commit it there — the sibling branch's tip
    // stays at the common base, so it will never have this line.
    await typeInEditor(page, `${PASSAGE}\n`);
    await commitViaUi(page, 'Add the passage to the original branch only');

    await commentOnPassage(page, PASSAGE, 'This is specific to the original branch.');
    const rail = page.getByTestId('comment-rail');
    const card = rail.getByTestId('review-thread-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Switch to the sibling branch — the doc stays open throughout, so its live editing session is
    // what the checkout's "open_files_need_confirm" refusal (and BranchSwitchDialog's "Switch anyway")
    // reacts to, and what lets the client re-resolve the comment's anchor once the content changes.
    await switchBranchViaUi(page, siblingBranch);
    await expect(page.locator('.cm-editor .cm-content')).not.toContainText(PASSAGE, { timeout: 30_000 });

    const sectionIndicator = rail.getByTestId('thread-card-section-indicator');
    const detachedTray = page.getByTestId('detached-tray');
    await expect(sectionIndicator.or(detachedTray)).toBeVisible({ timeout: 20_000 });

    // Switch back: the passage returns, and so should the comment's normal, located state.
    await switchBranchViaUi(page, originalBranch);
    await expect(page.locator('.cm-editor .cm-content')).toContainText(PASSAGE, { timeout: 30_000 });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('This is specific to the original branch.', { timeout: 10_000 });
    await expect(card.getByTestId('thread-card-section-indicator')).toHaveCount(0);
  });

  test('creating a branch adds it to the switcher without switching to it', async ({ page }) => {
    const remote = requireRemote();
    const originalBranch = `e2e-branches-create-only-${Date.now()}`;

    projectId = await createProjectViaUi(page, `Git Branches Create Only ${Date.now()}`);
    await createFileViaUi(page, FILE_NAME);
    await openFileInEditor(page, projectId, FILE_NAME);
    await typeInEditor(page, 'Base content.\n');
    await initializeViaUi(page, projectId, remote, originalBranch);
    await openFileInEditor(page, projectId, FILE_NAME);

    const newBranchName = `e2e-branches-new-${Date.now()}`;
    await createBranchViaUi(page, newBranchName);

    // A freshly created branch is never the checked-out one — the header still reads the original.
    await expect(page.getByRole('button', { name: 'Switch branch' })).toContainText(originalBranch, {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Switch branch' }).click();
    await expect(page.getByRole('menuitem', { name: newBranchName, exact: true })).toBeVisible({ timeout: 10_000 });
  });
});
