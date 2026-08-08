import { test, expect, Page } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';
import { waitCollabSynced } from './helpers/editor';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Seeds a file's content directly (setup only — the test itself drives the UI). */
async function writeFileContent(page: Page, projectId: string, fileNodeId: string, content: string): Promise<void> {
  const response = await page.request.put(
    `${API_URL}/projects/${projectId}/files/${fileNodeId}/content`,
    { headers: { 'Content-Type': 'text/plain' }, data: content },
  );
  if (!response.ok()) {
    throw new Error(`writeFileContent failed: ${response.status()} ${await response.text()}`);
  }
}

const editorContent = (page: Page) => page.locator('.cm-editor .cm-content');

// The SELECTED highlight only — the active row's `bg-primary/10` tint, not the hover `bg-accent`.
const SELECTED = /(?:^|\s)bg-primary\/10(?:\s|$)/;

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
}

/** Opens a tree file and waits until it is the highlighted (selected) node. */
async function openFile(page: Page, fileName: string): Promise<void> {
  await page.getByTestId(`tree-node-${fileName}`).click();
  await expect(page.getByTestId(`tree-node-${fileName}`)).toHaveClass(SELECTED, { timeout: 10_000 });
}

// --- Suite -----------------------------------------------------------------------------------
//
// Each file selection must be a real browser navigation, so the Back/Forward buttons walk the files
// visited this session and re-open the previous one (regression: selection lived only in React state,
// so Back left the editor and never returned to the prior file).

test.describe('Editor browser Back/Forward navigation', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Back-Nav E2E ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('Back walks back through visited files and Forward re-opens them', async ({ page }) => {
    // Headroom for the collaborative Yjs re-sync after each history navigation under parallel load.
    test.setTimeout(75_000);
    const alpha = await createTestFile(page, projectId, null, 'alpha.adoc');
    const beta = await createTestFile(page, projectId, null, 'beta.adoc');
    const gamma = await createTestFile(page, projectId, null, 'gamma.adoc');
    await writeFileContent(page, projectId, alpha, '= Alpha\n\nAlpha body.\n');
    await writeFileContent(page, projectId, beta, '= Beta\n\nBeta body.\n');
    await writeFileContent(page, projectId, gamma, '= Gamma\n\nGamma body.\n');

    await openProject(page, projectId);

    // Visit three files in order: alpha → beta → gamma.
    await openFile(page, 'alpha.adoc');
    await openFile(page, 'beta.adoc');
    await openFile(page, 'gamma.adoc');
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Gamma body.', { timeout: 20_000 });

    // Back → beta (the previously selected file is re-opened, highlighted, and its content shown).
    await page.goBack();
    await expect(page.getByTestId('tree-node-beta.adoc')).toHaveClass(SELECTED, { timeout: 10_000 });
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Beta body.', { timeout: 20_000 });

    // Back again → alpha.
    await page.goBack();
    await expect(page.getByTestId('tree-node-alpha.adoc')).toHaveClass(SELECTED, { timeout: 10_000 });
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Alpha body.', { timeout: 20_000 });

    // Forward → beta again (the history is intact in both directions).
    await page.goForward();
    await expect(page.getByTestId('tree-node-beta.adoc')).toHaveClass(SELECTED, { timeout: 10_000 });
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Beta body.', { timeout: 20_000 });
  });
});
