import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser, createInvitedUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject, createTestFile } from './helpers/test-project';
import { setMainFile } from './helpers/editor';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function writeFileContent(page: Page, projectId: string, fileNodeId: string, content: string): Promise<void> {
  const response = await page.request.put(
    `${API_URL}/projects/${projectId}/files/${fileNodeId}/content`,
    { headers: { 'Content-Type': 'text/plain' }, data: content },
  );
  if (!response.ok()) throw new Error(`writeFileContent failed: ${response.status()}`);
}

const railTab = (page: Page, name: RegExp) => page.getByRole('tab', { name });
const outlineRow = (page: Page, name: string | RegExp) =>
  page.getByRole('navigation', { name: /section outline/i }).getByRole('button', { name });

/**
 * Make a left-panel view the one on screen.
 *
 * The rail is an activity bar: activating the tab of the view that is ALREADY showing TOGGLES the
 * panel shut. So an unconditional click is not "show me this view" — for the view that happens to be
 * active it hides the very thing the test is about to use, leaving its content present in the DOM but
 * invisible. Click only when the view is not already selected, and reopen a panel that is collapsed.
 */
async function showView(page: Page, name: RegExp): Promise<void> {
  const tab = railTab(page, name);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  const expand = page.getByRole('button', { name: /expand sidebar/i });
  if (await expand.isVisible()) await expand.click();
}

async function waitSynced(page: Page): Promise<void> {
  await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('Outline follow-ups', () => {
  test.beforeAll(async () => { await ensureTestUser(); });

  let projectId: string;
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Outline Followups ${Date.now()}`);
  });
  test.afterEach(async ({ page }) => { if (projectId) await cleanupProject(page, projectId); });

  // Task 3: the full-document scope must stay honored after switching files — without the outline
  // collapsing to current-file-only and needing a second toggle to recover. The bug: after a file
  // switch in full scope, the assembled outline fell back to the open file's headings even though the
  // toggle still read "Full document", so a foreign-file heading vanished until the toggle was
  // clicked twice.
  test('full-document scope stays honored across file switches (no double-click)', async ({ page }) => {
    test.setTimeout(90_000);
    const mainId = await createTestFile(page, projectId, null, 'fmain.adoc');
    const chId = await createTestFile(page, projectId, null, 'fchild.adoc');
    await writeFileContent(page, projectId, mainId, '= Main Book\n\n== Main Sec\n\ninclude::fchild.adoc[]\n');
    await writeFileContent(page, projectId, chId, '== Child Sec\n\nChild body.\n');
    await setMainFile(page, projectId, mainId);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await showView(page, /files/i);
    await page.getByTestId('tree-node-fmain.adoc').click();
    await waitSynced(page);
    await railTab(page, /outline/i).click();

    // Full scope (default): both the main and the included file's headings are listed.
    await expect(outlineRow(page, 'Main Sec')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Child Sec')).toBeVisible({ timeout: 10_000 });

    // Switch to the child file (still full scope) — the outline must STILL show the full document
    // (the foreign 'Main Sec' heading stays visible) without any toggling.
    await showView(page, /files/i);
    await page.getByTestId('tree-node-fchild.adoc').click();
    await waitSynced(page);
    await railTab(page, /outline/i).click();
    await expect(outlineRow(page, 'Child Sec')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Main Sec')).toBeVisible({ timeout: 10_000 });

    // Switch back to the main file — again full scope stays honored with no double-click.
    await showView(page, /files/i);
    await page.getByTestId('tree-node-fmain.adoc').click();
    await waitSynced(page);
    await railTab(page, /outline/i).click();
    await expect(outlineRow(page, 'Main Sec')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Child Sec')).toBeVisible({ timeout: 10_000 });
  });

  // Issue: the current section must be highlighted (aria-current) in the FULL-document outline — the
  // cursor's line is a line in the OPEN file, so it must be matched against each open-file entry's
  // source line, not its (shifted) assembled-document line.
  test('current section is highlighted in the full-document outline', async ({ page }) => {
    test.setTimeout(90_000);
    const mainId = await createTestFile(page, projectId, null, 'cmain.adoc');
    const chId = await createTestFile(page, projectId, null, 'cchild.adoc');
    // Two sections after the include so the open file's later heading sits at an assembled line that
    // differs from its source line.
    await writeFileContent(page, projectId, mainId,
      '= C Main\n\n== Alpha\n\nAlpha body.\n\ninclude::cchild.adoc[]\n\n== Omega\n\nOmega body line.\n');
    await writeFileContent(page, projectId, chId, '== C Child\n\nChild body.\n');
    await setMainFile(page, projectId, mainId);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await showView(page, /files/i);
    await page.getByTestId('tree-node-cmain.adoc').click();
    await waitSynced(page);
    await railTab(page, /outline/i).click();
    await expect(outlineRow(page, 'Omega')).toBeVisible({ timeout: 20_000 });

    // Put the cursor inside the 'Omega' section (which sits AFTER the include in the assembled doc).
    await page.locator('.cm-editor .cm-content').getByText('Omega body line.').click();
    await expect(outlineRow(page, 'Omega')).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
    await expect(page.getByRole('navigation', { name: /section outline/i }).locator('[aria-current="true"]')).toHaveCount(1);
  });

  // Task 1: an existing user viewing the outline sees a newly-joined collaborator who merely opens a
  // file (without moving the cursor) appear as a presence marker in the outline.
  test('a newly-joined collaborator who opens a file appears in the outline (no cursor move)', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const email = `outline-join-${Date.now()}@example.com`;
    const password = 'EditorP@ssw0rd123!';
    await createInvitedUser(page, email, password, 'Joiner B');
    const addResp = await page.request.post(`${API_URL}/api/projects/${projectId}/members`, {
      data: { email, role: 'editor' },
    });
    if (!addResp.ok()) throw new Error(`addMember failed: ${addResp.status()}`);

    const mainId = await createTestFile(page, projectId, null, 'jmain.adoc');
    const chId = await createTestFile(page, projectId, null, 'jchild.adoc');
    await writeFileContent(page, projectId, mainId, '= Join Doc\n\n== Join Intro\n\ninclude::jchild.adoc[]\n');
    await writeFileContent(page, projectId, chId, '== Join Child\n\nBody.\n');
    await setMainFile(page, projectId, mainId);

    // Session A: open the main file, outline tab (full scope).
    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await page.getByTestId('tree-node-jmain.adoc').click();
    await waitSynced(page);
    await railTab(page, /outline/i).click();
    await expect(outlineRow(page, 'Join Intro')).toBeVisible({ timeout: 20_000 });

    const outlineMarker = page.getByRole('navigation', { name: /section outline/i }).getByTestId('open-by-others-marker');
    await expect(outlineMarker).toHaveCount(0);

    // Session B logs in fresh and opens the SAME main file — WITHOUT moving the cursor.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await signIn(pageB, email, password);
      await pageB.goto(`/dashboard/projects/${projectId}`);
      await expect(pageB.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
      await pageB.getByTestId('tree-node-jmain.adoc').click();
      await waitSynced(pageB);

      // Task 1: A's outline should show B's presence marker even though B never moved the cursor.
      await expect(outlineMarker).toBeVisible({ timeout: 20_000 });
    } finally {
      await contextB.close();
    }
  });
});
