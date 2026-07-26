import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';
import {
  addMemberToProject,
  commentOnPassage,
  ensureCommentsPanelOpen,
  openFileInEditor,
  typeInEditor,
  type MemberCredentials,
} from './helpers/review';

// Feature 038 / US1 (T028): two collaborators in one document exercise the full comment lifecycle —
// create a thread on a passage, see the highlight + thread propagate over SSE, reply, react, hide/show
// the panel, and resolve. Requires apps/api + apps/collab + web running (pnpm e2e:local).

const PASSAGE = 'REVIEWME passage under discussion';

test.describe('Review comments — thread lifecycle across two sessions', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;
  let editor: MemberCredentials;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Review Comments ${Date.now()}`);
    editor = await addMemberToProject(page, projectId, 'editor');
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('comment → highlight + SSE propagation → reply → react → hide/show → resolve', async ({ page, browser }) => {
    const fileName = 'comments.adoc';
    await createTestFile(page, projectId, null, fileName);

    // A opens the doc and seeds a passage to anchor a comment to.
    await openFileInEditor(page, projectId, fileName);
    await typeInEditor(page, `Intro line\n${PASSAGE}\nTrailing line`);

    // B (second editor) opens the same doc and must see the seeded passage before commenting begins.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await signIn(pageB, editor.email, editor.password);
      await openFileInEditor(pageB, projectId, fileName);
      await expect(pageB.locator('.cm-editor .cm-content')).toContainText(PASSAGE, { timeout: 5000 });

      // ── A creates a comment on the passage ──────────────────────────────────────────────────
      await commentOnPassage(page, PASSAGE, 'Please clarify this passage.');

      const railA = page.getByTestId('comment-rail');
      await expect(railA.getByTestId('review-thread-card')).toBeVisible({ timeout: 10_000 });
      await expect(railA).toContainText('Please clarify this passage.', { timeout: 10_000 });

      // The passage now carries a review highlight in A's editor (data-review-id anchor hook).
      const highlightA = page.locator('.cm-editor [data-review-id]');
      await expect(highlightA.first()).toBeVisible({ timeout: 10_000 });
      await expect(highlightA.first()).toContainText('REVIEWME', { timeout: 10_000 });

      // ── B sees the thread once the review-items-changed SSE signal lands ─────────────────────
      await ensureCommentsPanelOpen(pageB);
      const railB = pageB.getByTestId('comment-rail');
      await expect(railB).toContainText('Please clarify this passage.', { timeout: 15_000 });

      // ── B replies; A sees the reply ─────────────────────────────────────────────────────────
      const threadB = railB.getByTestId('review-thread-card').first();
      await threadB.getByTestId('review-reply').click();
      const replyComposer = threadB.getByTestId('comment-composer');
      await expect(replyComposer).toBeVisible({ timeout: 10_000 });
      await replyComposer.locator('textarea').fill('Rewording it now.');
      await threadB.getByTestId('review-composer-submit').click();

      await expect(railA).toContainText('Rewording it now.', { timeout: 15_000 });

      // ── A reacts on the root card with an allowlisted emoji; the chip shows a count ──────────
      const rootCardA = railA.getByTestId('review-thread-card').first();
      const rootReactionBar = rootCardA.getByTestId('reaction-bar').first();
      await rootReactionBar.getByTestId('review-add-reaction').click();
      await page.getByTestId('review-react-👍').click();
      await page.keyboard.press('Escape'); // the reaction popover stays open on select; dismiss it
      await expect(rootCardA.getByTestId('review-reaction-👍')).toBeVisible({ timeout: 10_000 });
      await expect(rootCardA.getByTestId('review-reaction-👍')).toContainText('1', { timeout: 10_000 });

      // ── Collapse the panel from its own rail, reopen it from the collapsed edge ──────────────
      await expect(page.getByTestId('right-panel-count-comments')).toHaveText('1', { timeout: 10_000 });
      await page.getByLabel('collapse panel').click();
      await expect(railA).toBeHidden({ timeout: 10_000 });
      await page.getByTestId('review-toggle').click();
      await expect(railA).toBeVisible({ timeout: 10_000 });

      // ── A resolves the thread: it leaves the default Open filter and returns under All ───────
      await railA.getByTestId('review-thread-card').first().getByTestId('review-resolve').click();
      await expect(railA).not.toContainText('Please clarify this passage.', { timeout: 15_000 });

      await railA.getByRole('tab', { name: 'All' }).click();
      await expect(railA).toContainText('Please clarify this passage.', { timeout: 15_000 });

      // Every open comment is resolved, so the rail's open-count badge disappears.
      await expect(page.getByTestId('right-panel-count-comments')).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await contextB.close();
    }
  });
});
