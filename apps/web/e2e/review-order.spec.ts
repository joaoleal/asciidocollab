import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';
import { openFileInEditor, typeInEditor, ensureCommentsPanelOpen, commentOnPassage } from './helpers/review';

/**
 * The rail must list comments in the order they appear in the DOCUMENT, not the order they were
 * written. The comparator behind that is unit-tested, but a passing comparator does not prove the panel
 * uses it — the ordering rule previously existed in one place (the prev/next arrows) while the rail
 * rendered whatever order the API returned, which was creation time. Only a real render over real
 * anchors, whose offsets exist solely once the shared Yjs document has loaded in the browser, can tell
 * those two apart.
 *
 * So this comments on the LAST line first and the FIRST line second: document order and creation order
 * then disagree, and every wrong implementation (API order, creation time, unsorted) produces the
 * reverse of what is asserted.
 */

const FIRST_PASSAGE = 'ALPHA passage near the top';
const LAST_PASSAGE = 'OMEGA passage near the bottom';

test.describe('Review panel ordering', () => {
  // The rail renders from the collaboratively-synced document, and each comment round-trips through the
  // API and back, so this needs more headroom than a pure UI spec.
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Review Order ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('lists threads in document order even when they were written in reverse', async ({ page }) => {
    const fileName = 'ordered.adoc';
    await createTestFile(page, projectId, null, fileName);
    await openFileInEditor(page, projectId, fileName);
    await typeInEditor(page, `${FIRST_PASSAGE}\n\nMiddle line\n\n${LAST_PASSAGE}`);
    await expect(page.locator('.cm-editor .cm-content')).toContainText(LAST_PASSAGE, { timeout: 15_000 });

    // Written bottom-up on purpose: creation order is now the reverse of document order.
    await commentOnPassage(page, LAST_PASSAGE, 'Comment on the omega passage.');
    const rail = page.getByTestId('comment-rail');
    await expect(rail.getByTestId('review-thread-card')).toHaveCount(1, { timeout: 15_000 });

    await commentOnPassage(page, FIRST_PASSAGE, 'Comment on the alpha passage.');
    await expect(rail.getByTestId('review-thread-card')).toHaveCount(2, { timeout: 15_000 });

    await ensureCommentsPanelOpen(page);
    const bodies = await rail.getByTestId('review-thread-card').allInnerTexts();
    expect(bodies[0]).toContain('alpha');
    expect(bodies[1]).toContain('omega');
  });
});
