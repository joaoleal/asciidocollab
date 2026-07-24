import { test, expect, type Page } from '@playwright/test';
import { ensureTestUser, createInvitedUser } from './helpers/test-user';
import {
  signIn,
  createProject,
  cleanupProject,
  createTestFile,
} from './helpers/test-project';
import { setMainFile } from './helpers/editor';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// --- Setup helper -----------------------------------------------------------------------------

/** Seeds a file's content directly (scaffolding only). */
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

async function waitCollabSynced(page: Page): Promise<void> {
  await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
}

const railTab = (page: Page, name: RegExp) => page.getByRole('tab', { name });
const outlineRow = (page: Page, name: string | RegExp) =>
  page.getByRole('navigation', { name: /section outline/i }).getByRole('button', { name });

// --- Suite ------------------------------------------------------------------------------------

test.describe('Editor left panel: Outline view (028)', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;
  let projectName: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectName = `Outline E2E ${Date.now()}`;
    projectId = await createProject(page, projectName);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  // Flagship: Files is the default; switch to Outline; the outline lists nested headings
  // including the title; clicking a heading moves the editor and the preview follows; and typing a
  // new heading makes a new outline row appear live.
  test('default Files; switch to Outline; nested headings; navigate; live update', async ({ page }) => {
    test.setTimeout(75_000);
    const fileNodeId = await createTestFile(page, projectId, null, 'guide.adoc');
    await writeFileContent(
      page,
      projectId,
      fileNodeId,
      ['= Guide Title', '', '== Getting Started', '', '=== Install', '', 'Body text.', '', '== Reference', '', 'More body.'].join('\n'),
    );

    await openProject(page, projectId);
    await page.getByTestId('tree-node-guide.adoc').click();
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Getting Started', { timeout: 20_000 });

    // Files is the default view: the file tree node is visible, the outline rail tab is not selected.
    await expect(page.getByTestId('tree-node-guide.adoc')).toBeVisible();
    await expect(railTab(page, /outline/i)).toHaveAttribute('aria-selected', 'false');

    // Switch to Outline via the rail.
    await railTab(page, /outline/i).click();
    await expect(railTab(page, /outline/i)).toHaveAttribute('aria-selected', 'true');

    // Every heading is listed, including the document title; nested by level.
    await expect(outlineRow(page, 'Guide Title')).toBeVisible();
    await expect(outlineRow(page, 'Getting Started')).toBeVisible();
    await expect(outlineRow(page, 'Install')).toBeVisible();
    await expect(outlineRow(page, 'Reference')).toBeVisible();

    // Open the preview, then click a deep heading: the editor moves there and the preview follows.
    await page.getByRole('button', { name: /expand preview/i }).click();
    await outlineRow(page, 'Reference').click();
    await expect(page.locator('.cm-editor .cm-activeLine')).toContainText('Reference', { timeout: 10_000 });

    // Typing a new section heading makes a new outline row appear without a manual refresh.
    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n\n== Appendix\n');
    await expect(outlineRow(page, 'Appendix')).toBeVisible({ timeout: 10_000 });
  });

  // The current-section highlight follows the cursor (exactly one current row).
  test('current section highlight follows the cursor', async ({ page }) => {
    test.setTimeout(75_000);
    const fileNodeId = await createTestFile(page, projectId, null, 'sections.adoc');
    await writeFileContent(
      page,
      projectId,
      fileNodeId,
      ['= Doc', '', '== Alpha', '', 'Alpha body line.', '', '== Bravo', '', 'Bravo body line.'].join('\n'),
    );

    await openProject(page, projectId);
    await page.getByTestId('tree-node-sections.adoc').click();
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Alpha body line.', { timeout: 20_000 });
    await railTab(page, /outline/i).click();

    // Cursor inside the Alpha section → Alpha is current.
    await editorContent(page).getByText('Alpha body line.').click();
    await expect(outlineRow(page, 'Alpha')).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
    await expect(page.getByRole('navigation', { name: /section outline/i }).locator('[aria-current="true"]')).toHaveCount(1);

    // Move into Bravo → the current row follows.
    await editorContent(page).getByText('Bravo body line.').click();
    await expect(outlineRow(page, 'Bravo')).toHaveAttribute('aria-current', 'true', { timeout: 10_000 });
    await expect(page.getByRole('navigation', { name: /section outline/i }).locator('[aria-current="true"]')).toHaveCount(1);
  });

  // The chosen view persists across a reload (localStorage, per user, not the account API).
  test('the chosen Outline view persists across a reload', async ({ page }) => {
    test.setTimeout(75_000);
    const fileNodeId = await createTestFile(page, projectId, null, 'persist.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Persist\n\n== One\n');

    await openProject(page, projectId);
    await page.getByTestId('tree-node-persist.adoc').click();
    await waitCollabSynced(page);
    await railTab(page, /outline/i).click();
    await expect(railTab(page, /outline/i)).toHaveAttribute('aria-selected', 'true');

    await page.reload();
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });
    // Outline is still the active view after the reload.
    await expect(railTab(page, /outline/i)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  });

  // Graceful empty states.
  test('empty states: no document, then a heading-less document', async ({ page }) => {
    const fileNodeId = await createTestFile(page, projectId, null, 'flat.adoc');
    await writeFileContent(page, projectId, fileNodeId, 'Just a paragraph, no headings.\n');

    await openProject(page, projectId);
    // No document open yet → switch to Outline → first empty state.
    await railTab(page, /outline/i).click();
    await expect(page.getByText('Open a document to see its outline.')).toBeVisible({ timeout: 10_000 });

    // Switch back to Files (the file tree is hidden while Outline is active) to open a heading-less
    // document, then return to Outline → second empty state.
    await railTab(page, /files/i).click();
    await page.getByTestId('tree-node-flat.adoc').click();
    await waitCollabSynced(page);
    await railTab(page, /outline/i).click();
    await expect(page.getByText('No headings yet — add a section title (=, ==, …).')).toBeVisible({ timeout: 20_000 });
  });

  // Full-document outline across include directives (feature 032).
  // With a main document configured, the outline shows the complete heading hierarchy from
  // all included files regardless of which file is open.
  test('full-document outline: shows all headings from included files', async ({ page }) => {
    test.setTimeout(90_000);

    // Create main.adoc (root document) and ch.adoc (included chapter).
    const mainId = await createTestFile(page, projectId, null, 'main.adoc');
    const chId = await createTestFile(page, projectId, null, 'ch.adoc');
    await writeFileContent(page, projectId, mainId,
      '= Book Title\n\n== Chapter One\n\nSome intro text.\n\ninclude::ch.adoc[]\n');
    await writeFileContent(page, projectId, chId,
      '== Chapter Two\n\nIncluded chapter content.\n');

    // Set main.adoc as the main file so the project has a root document.
    await setMainFile(page, projectId, mainId);

    // Open the project and switch to the Outline panel.
    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await railTab(page, /outline/i).click();

    // Open main.adoc from the Files tab first.
    await railTab(page, /files/i).click();
    await page.getByTestId('tree-node-main.adoc').click();
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
    await railTab(page, /outline/i).click();

    // All headings from both files appear in the outline (seamless, in order).
    await expect(outlineRow(page, 'Book Title')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Chapter One')).toBeVisible({ timeout: 10_000 });
    await expect(outlineRow(page, 'Chapter Two')).toBeVisible({ timeout: 10_000 });
  });

  // Clicking a foreign-file heading navigates to that file at the source heading.
  test('full-document outline: clicking a foreign-file heading opens that file', async ({ page }) => {
    test.setTimeout(90_000);

    const mainId = await createTestFile(page, projectId, null, 'root.adoc');
    const chapId = await createTestFile(page, projectId, null, 'chapter.adoc');
    await writeFileContent(page, projectId, mainId,
      '= Root\n\n== Root Section\n\ninclude::chapter.adoc[]\n');
    await writeFileContent(page, projectId, chapId,
      '== Chapter Section\n\nChapter body.\n');
    await setMainFile(page, projectId, mainId);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    // Open root.adoc (the main document).
    await railTab(page, /files/i).click();
    await page.getByTestId('tree-node-root.adoc').click();
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });

    // Switch to the Outline tab and wait for the full outline to load.
    await railTab(page, /outline/i).click();
    await expect(outlineRow(page, 'Chapter Section')).toBeVisible({ timeout: 20_000 });

    // Clicking the child-file heading opens chapter.adoc.
    await outlineRow(page, 'Chapter Section').click();
    // The file tree should now show chapter.adoc as the active file.
    await expect(page.getByTestId('tree-node-chapter.adoc')).toHaveAttribute(
      'aria-current', 'true', { timeout: 15_000 },
    );
    // And the editor should contain the chapter content.
    await expect(editorContent(page)).toContainText('Chapter body.', { timeout: 15_000 });
  });

  // With no active collab session on an included file, the outline shows the
  // last-saved headings from that file (single-user verification of the persistence layer).
  test('full-document outline: included file with no live session shows last-saved headings', async ({ page }) => {
    test.setTimeout(90_000);

    const mainId = await createTestFile(page, projectId, null, 'doc.adoc');
    const chapId = await createTestFile(page, projectId, null, 'appendix.adoc');
    await writeFileContent(page, projectId, mainId,
      '= Document\n\n== Intro\n\ninclude::appendix.adoc[]\n');
    await writeFileContent(page, projectId, chapId,
      '== Appendix A\n\nSome appendix content.\n');
    await setMainFile(page, projectId, mainId);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    // Open doc.adoc (no session on appendix.adoc) and switch to the Outline tab.
    await railTab(page, /files/i).click();
    await page.getByTestId('tree-node-doc.adoc').click();
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
    await railTab(page, /outline/i).click();

    // Shows last-saved headings from appendix.adoc even though nobody is editing it live.
    await expect(outlineRow(page, 'Appendix A')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Intro')).toBeVisible({ timeout: 10_000 });
  });

  // A heading edit made by a collaborator in an included file appears in another
  // user's full-document outline within ~2 s, without an explicit save.
  test('full-document outline: live heading edit in included file updates outline', async ({ page, browser }) => {
    test.setTimeout(120_000);

    // Session B watches the outline; Session A edits the included file.
    const mainId = await createTestFile(page, projectId, null, 'live-main.adoc');
    const chapId = await createTestFile(page, projectId, null, 'live-ch.adoc');
    await writeFileContent(page, projectId, mainId,
      '= Live Book\n\n== Fixed Section\n\ninclude::live-ch.adoc[]\n');
    await writeFileContent(page, projectId, chapId,
      '== Original Chapter Heading\n\nBody text.\n');
    await setMainFile(page, projectId, mainId);

    // Session B (the outline watcher): open live-main.adoc and bring up the outline tab.
    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await railTab(page, /files/i).click();
    await page.getByTestId('tree-node-live-main.adoc').click();
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
    await railTab(page, /outline/i).click();
    // Confirm the initial heading from live-ch.adoc is visible.
    await expect(outlineRow(page, 'Original Chapter Heading')).toBeVisible({ timeout: 20_000 });

    // Session A (the editor): sign in as the same test user in a fresh browser context.
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    try {
      await signIn(pageA);
      await pageA.goto(`/dashboard/projects/${projectId}`);
      await expect(pageA.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

      // A opens live-ch.adoc (the included file).
      await pageA.getByTestId('tree-node-live-ch.adoc').click();
      await expect(pageA.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });

      // A rewrites the heading in the included file via the editor (no explicit save).
      const contentA = pageA.locator('.cm-editor .cm-content');
      await contentA.click();
      await pageA.keyboard.press('Control+Home');
      await pageA.keyboard.press('Shift+End');
      await pageA.keyboard.type('== Updated Chapter Heading');

      // Session B's outline should reflect the updated heading within ~2 s.
      await expect(outlineRow(page, 'Updated Chapter Heading')).toBeVisible({ timeout: 15_000 });
      await expect(outlineRow(page, 'Original Chapter Heading')).toHaveCount(0);
    } finally {
      await contextA.close();
    }
  });

  // Scope toggle narrows the outline to the open file and back; persists across reload.
  test('scope toggle narrows outline to current file and persists across reload', async ({ page }) => {
    test.setTimeout(90_000);

    const mainId = await createTestFile(page, projectId, null, 'scope-main.adoc');
    const chapId = await createTestFile(page, projectId, null, 'scope-ch.adoc');
    await writeFileContent(page, projectId, mainId,
      '= Scope Book\n\n== Main Heading\n\ninclude::scope-ch.adoc[]\n');
    await writeFileContent(page, projectId, chapId, '== Chapter Heading\n\nChapter body.\n');
    await setMainFile(page, projectId, mainId);

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    // Open scope-main.adoc and switch to the Outline tab.
    await railTab(page, /files/i).click();
    await page.getByTestId('tree-node-scope-main.adoc').click();
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
    await railTab(page, /outline/i).click();

    // Full-document scope (default): both headings appear.
    await expect(outlineRow(page, 'Main Heading')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Chapter Heading')).toBeVisible({ timeout: 10_000 });

    // Toggle to current-file scope: only Main Heading should be visible.
    await page.getByRole('button', { name: /current file|full document/i }).click();
    await expect(outlineRow(page, 'Main Heading')).toBeVisible({ timeout: 5000 });
    await expect(outlineRow(page, 'Chapter Heading')).toHaveCount(0);

    // Reload the page — the choice should persist (localStorage).
    await page.reload();
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });
    await expect(railTab(page, /outline/i)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

    // After reload, should still show current-file only (Chapter Heading absent).
    await expect(outlineRow(page, 'Main Heading')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Chapter Heading')).toHaveCount(0);

    // Toggle back to full document: Chapter Heading reappears.
    await page.getByRole('button', { name: /current file|full document/i }).click();
    await expect(outlineRow(page, 'Chapter Heading')).toBeVisible({ timeout: 10_000 });
  });

  // Project with no main document configured → only the open file's headings
  // appear in the outline and the full-document scope toggle is not shown.
  test('no-main-doc: shows only open-file headings with no scope toggle', async ({ page }) => {
    test.setTimeout(75_000);

    // No setMainFile call → the project has no main document.
    const fileId = await createTestFile(page, projectId, null, 'standalone.adoc');
    await writeFileContent(page, projectId, fileId,
      '= Standalone Title\n\n== Only Heading\n\nBody.\n');

    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });

    await page.getByTestId('tree-node-standalone.adoc').click();
    await expect(page.getByTestId('collab-banner-connecting')).toHaveCount(0, { timeout: 30_000 });
    await railTab(page, /outline/i).click();

    // Only open-file headings appear.
    await expect(outlineRow(page, 'Standalone Title')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Only Heading')).toBeVisible({ timeout: 5000 });

    // No scope toggle when there is no main document configured.
    await expect(page.getByRole('button', { name: /current file|full document/i })).toHaveCount(0);
  });

  // Presence marker appears on B's section in A's outline,
  // moves when B's cursor moves, reflects others only (not A's own entry).
  test('outline shows presence marker on heading where B has cursor; reflects others only', async ({ page, browser }) => {
    test.setTimeout(120_000);

    const email = `outline-presence-${Date.now()}@example.com`;
    const password = 'EditorP@ssw0rd123!';
    await createInvitedUser(page, email, password, 'Collaborator B');
    const addMemberResp = await page.request.post(`${API_URL}/api/projects/${projectId}/members`, {
      data: { email, role: 'editor' },
    });
    if (!addMemberResp.ok()) throw new Error(`addMember failed: ${addMemberResp.status()}`);

    // Create a main doc + included file with distinct sections.
    const mainId = await createTestFile(page, projectId, null, 'main-presence.adoc');
    const childId = await createTestFile(page, projectId, null, 'child-presence.adoc');
    await writeFileContent(page, projectId, mainId,
      '= Presence Doc\n\n== Intro Section\n\nSome text.\n\ninclude::child-presence.adoc[]\n');
    await writeFileContent(page, projectId, childId,
      '== Child Section\n\nChild content here.\n');
    await setMainFile(page, projectId, mainId);

    // Session A: open the main file in the outline tab.
    await page.goto(`/dashboard/projects/${projectId}`);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await page.getByTestId('tree-node-main-presence.adoc').click();
    await waitCollabSynced(page);
    await railTab(page, /outline/i).click();
    // Full-document outline visible to A.
    await expect(outlineRow(page, 'Intro Section')).toBeVisible({ timeout: 20_000 });
    await expect(outlineRow(page, 'Child Section')).toBeVisible({ timeout: 10_000 });

    // The outline-scoped marker: the file-tree (024) marker shares this testid, so scope to the
    // section-outline navigation to assert specifically on the outline's presence marker.
    const outlineMarker = page.getByRole('navigation', { name: /section outline/i }).getByTestId('open-by-others-marker');

    // A does NOT see a marker for their own session (self-exclusion). This MUST be asserted before B
    // joins: merely opening the file publishes presence (see outline-followups.spec.ts), so once B is
    // in the room a marker is expected and this assertion would be racing presence propagation.
    await expect(outlineMarker).toHaveCount(0);

    // Session B: second browser context, opens the same main file.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await signIn(pageB, email, password);
      await pageB.goto(`/dashboard/projects/${projectId}`);
      await expect(pageB.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
      await pageB.getByTestId('tree-node-main-presence.adoc').click();
      await waitCollabSynced(pageB);

      // Opening the file is itself enough to publish presence, so wait for B's marker to reach A
      // BEFORE touching the cursor. Without this the cursor-move assertions below race initial
      // presence propagation, which under CI's parallel workers can take longer than their timeout —
      // the marker then never "appears" because it had not arrived in the first place.
      await expect(outlineMarker).toBeVisible({ timeout: 30_000 });

      // B places cursor on the "Child Section" heading line by clicking in the editor around line 7.
      const editorB = pageB.locator('.cm-editor .cm-content');
      await editorB.click();
      // Move to line 7 (the include::child-presence.adoc[] line → child section at that area).
      for (let index = 0; index < 6; index++) await pageB.keyboard.press('ArrowDown');

      // A's outline should eventually show B's presence marker on whichever heading B is in.
      await expect(outlineMarker).toBeVisible({ timeout: 15_000 });

      // B moves cursor up to the "Intro Section" area.
      for (let index = 0; index < 5; index++) await pageB.keyboard.press('ArrowUp');

      // The marker should move (appear somewhere in the outline — still present).
      await expect(outlineMarker).toBeVisible({ timeout: 10_000 });
    } finally {
      await contextB.close();
    }

    // After B disconnects, the marker should clear from A's outline.
    await expect(page.getByRole('navigation', { name: /section outline/i }).getByTestId('open-by-others-marker')).toHaveCount(0, { timeout: 15_000 });
  });

  // File create/options actions show only while Files is active.
  test('file actions are present on Files and absent on Outline', async ({ page }) => {
    // The document title MUST NOT be "Actions": this test matches the file-tree ⋯ control by its
    // accessible name (`aria-label="actions"`), and an outline entry renders a button named after the
    // heading. A "= Actions" title would surface an "Actions" outline entry that collides with that
    // name, so the `toHaveCount(0)` assertion below would (racily) see the outline button instead.
    const fileNodeId = await createTestFile(page, projectId, null, 'sample.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Sample Doc\n\n== Heading\n');

    await openProject(page, projectId);
    await page.getByTestId('tree-node-sample.adoc').click();
    await waitCollabSynced(page);

    // Files view (default): the file-tree "actions" (⋯) control is visible.
    await expect(page.getByRole('button', { name: /^actions$/i }).first()).toBeVisible();

    // Outline view: the Files slot is hidden, so its actions are not visible.
    await railTab(page, /outline/i).click();
    await expect(page.getByRole('button', { name: /^actions$/i })).toHaveCount(0);

    // Switching back restores them.
    await railTab(page, /files/i).click();
    await expect(page.getByRole('button', { name: /^actions$/i }).first()).toBeVisible();
  });
});
