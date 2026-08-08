import { test, expect, Page } from '@playwright/test';
import { TEST_USER, ensureTestUser, adminDeleteUserByEmail } from './helpers/test-user';
import {
  signIn,
  createProject,
  cleanupProject,
  createTestFile,
  createTestFolder,
  createViewerInProject,
} from './helpers/test-project';
import { waitCollabSynced } from './helpers/editor';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// --- Setup-only API helpers (scaffolding + simulating out-of-band changes) -------------------

/** Seeds a file's content directly. Used as setup, or to simulate another session editing a file. */
async function writeFileContent(page: Page, projectId: string, fileNodeId: string, content: string): Promise<void> {
  const response = await page.request.put(
    `${API_URL}/projects/${projectId}/files/${fileNodeId}/content`,
    { headers: { 'Content-Type': 'text/plain' }, data: content },
  );
  if (!response.ok()) {
    throw new Error(`writeFileContent failed: ${response.status()} ${await response.text()}`);
  }
}

// --- UI helpers (drive the real app like a user) ---------------------------------------------

const editorContent = (page: Page) => page.locator('.cm-editor .cm-content');

// Matches the SELECTED highlight only — the active row's `bg-primary/10` tint, not the always-present
// `hover:bg-accent` (a bare /bg-accent/ would match the hover class on every row).
const SELECTED = /(?:^|\s)bg-primary\/10(?:\s|$)/;

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/dashboard/projects/${projectId}`);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
}

/** Leaves the editor for the dashboard and returns by clicking the project — a full remount, all via UI. */
async function leaveAndReturnViaDashboard(page: Page, projectName: string): Promise<void> {
  await page.getByRole('link', { name: /back to projects/i }).click();
  await page.waitForURL(/\/dashboard$/);
  await page.getByRole('link', { name: projectName }).click();
  await page.waitForURL(/\/dashboard\/projects\/[^/]+$/);
  await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
}

async function signOutViaUi(page: Page, displayName: string): Promise<void> {
  await page.getByRole('button').filter({ hasText: displayName }).click({ timeout: 10_000 });
  await page.getByRole('menuitem', { name: /log out/i }).click();
  await page.waitForURL(/\/login/);
}

// --- Suite -----------------------------------------------------------------------------------
//
// Each test exercises ONE distinct behaviour of the persist-&-restore feature, driving the app
// through the UI (selecting, typing, moving the cursor, navigating, deleting). Only scaffolding
// (creating projects / file nodes / users) and out-of-band edits go through the API.

test.describe('Persist & restore file selection', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;
  let projectName: string;
  let viewerEmail: string | undefined;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectName = `Restore E2E ${Date.now()}`;
    projectId = await createProject(page, projectName);
  });

  test.afterEach(async ({ page }) => {
    if (viewerEmail) {
      await adminDeleteUserByEmail(page, viewerEmail);
      viewerEmail = undefined;
    }
    if (projectId) await cleanupProject(page, projectId);
  });

  // Flagship: the full journey — type content, reveal a deeply-nested file, restore the cursor
  // line, and render the preview — after leaving the editor and returning. Also guards the
  // "stuck on Loading… forever" regression (the restored content must actually appear).
  test('restores a typed nested file: reveal, content, cursor line, and preview on return', async ({ page }) => {
    // Headroom for the collaborative Yjs re-sync after navigating back under heavy parallel load.
    test.setTimeout(90_000);
    const guide = await createTestFolder(page, projectId, null, 'guide');
    const chapters = await createTestFolder(page, projectId, guide, 'chapters');
    await createTestFile(page, projectId, chapters, 'intro.adoc');

    await openProject(page, projectId);
    // `guide` is top-level and auto-expands; expand `chapters` to reach the nested file.
    await page.getByTestId('tree-node-chapters').click();
    await page.getByTestId('tree-node-intro.adoc').click();
    await expect(editorContent(page)).toBeVisible({ timeout: 10_000 });

    // Type the document directly into the editor (drives the real auto-save path).
    await editorContent(page).click();
    await page.keyboard.type(
      [
        '= Nested Doc',
        '',
        'Third line is where the cursor lands.',
        'Fourth line content.',
        'Fifth line content.',
        'Sixth line content.',
      ].join('\n'),
    );
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });

    // Place the cursor on line 3 by clicking its text; confirm via the status bar, then let the
    // debounced line persistence flush.
    await editorContent(page).getByText('Third line is where the cursor lands.').click();
    await expect(page.locator('.asciidoc-editor').getByText(/^Ln 3, /)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(800);

    await leaveAndReturnViaDashboard(page, projectName);

    // The nested file is revealed (collapsed ancestor re-expanded) and highlighted.
    await expect(page.getByTestId('tree-node-intro.adoc')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('tree-node-intro.adoc')).toHaveClass(SELECTED, { timeout: 15_000 });
    // Wait for the collaboration sync to finish before asserting the synced content — under heavy
    // parallel load the post-navigation Yjs sync can lag many seconds.
    await waitCollabSynced(page);
    // The content is shown — must NOT stay stuck loading. The editor stays read-only and empty until
    // the post-navigation Yjs re-sync lands the document, which under heavy parallel load can lag past
    // 20s (observed: 44× empty over 20s, editor still contenteditable="false"), so allow real headroom.
    await expect(editorContent(page)).toContainText('Third line is where the cursor lands.', { timeout: 30_000 });
    // The cursor is back on line 3.
    await expect(page.locator('.asciidoc-editor').getByText(/^Ln 3, /)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.cm-editor .cm-activeLine')).toContainText('Third line is where the cursor lands.');
    // The live preview renders the content within a few seconds.
    await page.getByRole('button', { name: /expand preview/i }).click();
    await expect(page.getByTestId('asciidoc-output')).toContainText('Third line is where the cursor lands.', { timeout: 15_000 });
  });

  // Distinct behaviour: edits must be saved when leaving the page, not only after the autosave
  // debounce. Navigating away immediately after typing must NOT lose the work.
  test('saves edits made just before navigating away (faster than the autosave debounce)', async ({ page }) => {
    // Headroom for the collaborative Yjs re-sync after navigating back under heavy parallel load.
    test.setTimeout(75_000);
    const fileNodeId = await createTestFile(page, projectId, null, 'draft.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Draft\n\nStarting point.\n');

    await openProject(page, projectId);
    await page.getByTestId('tree-node-draft.adoc').click();
    await expect(editorContent(page)).toContainText('Starting point.', { timeout: 10_000 });

    // Type a new line and leave the page well within the 4s autosave debounce, without waiting for
    // "Saved". Give the collaborative Yjs update a brief moment to reach the server before the provider
    // disconnects on navigation (the edit lives in the live Yjs doc, synced over the socket — not the
    // REST autosave this test deliberately beats); under heavy parallel load that round-trip can lag.
    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nLast-second edit before leaving.');
    await page.waitForTimeout(1500);
    await page.getByRole('link', { name: /back to projects/i }).click();
    await page.waitForURL(/\/dashboard$/);

    // Return to the project — the edit must have been flushed on the way out.
    await page.getByRole('link', { name: projectName }).click();
    await page.waitForURL(/\/dashboard\/projects\/[^/]+$/);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    // Wait for the post-navigation Yjs sync before asserting the restored content.
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Last-second edit before leaving.', { timeout: 20_000 });
  });

  // Distinct path: a full page reload (not in-app navigation) must restore the selection.
  test('restores the selected file across a full page reload', async ({ page }) => {
    // The editor content is the collaboratively-synced Yjs document (not a REST fetch). After a reload
    // the provider reconnects (connecting → synced) and under heavy parallel load that sync can lag the
    // page load by many seconds, so give the test headroom and wait on the sync signal rather than a
    // bare content timeout that races the pre-sync (empty) editor.
    test.setTimeout(75_000);
    const fileNodeId = await createTestFile(page, projectId, null, 'notes.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Notes\n\nReload survives this.\n');

    await openProject(page, projectId);
    await page.getByTestId('tree-node-notes.adoc').click();
    await expect(editorContent(page)).toContainText('Reload survives this.', { timeout: 15_000 });

    await page.reload();
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('tree-node-notes.adoc')).toHaveClass(SELECTED, { timeout: 15_000 });
    // Wait for the collaboration sync to finish before asserting the synced content. This is the
    // definitive signal that the Yjs document has arrived, so the assertion never runs against the
    // empty pre-sync editor.
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('Reload survives this.', { timeout: 20_000 });
  });

  // Distinct behaviour: each project remembers its own file independently.
  test('restores each project to its own remembered file', async ({ page }) => {
    // Headroom for repeated collaborative Yjs syncs as we hop between projects under parallel load.
    test.setTimeout(75_000);
    const fileA = await createTestFile(page, projectId, null, 'alpha.adoc');
    await writeFileContent(page, projectId, fileA, '= Alpha\n\nProject A content.\n');

    const projectBName = `Restore E2E B ${Date.now()}`;
    const projectB = await createProject(page, projectBName);
    try {
      const fileB = await createTestFile(page, projectB, null, 'beta.adoc');
      await writeFileContent(page, projectB, fileB, '= Beta\n\nProject B content.\n');

      await openProject(page, projectId);
      await page.getByTestId('tree-node-alpha.adoc').click();
      await waitCollabSynced(page);
      await expect(editorContent(page)).toContainText('Project A content.', { timeout: 20_000 });

      await openProject(page, projectB);
      await page.getByTestId('tree-node-beta.adoc').click();
      await waitCollabSynced(page);
      await expect(editorContent(page)).toContainText('Project B content.', { timeout: 20_000 });

      // Returning to A restores A's file, not B's.
      await openProject(page, projectId);
      await expect(page.getByTestId('tree-node-alpha.adoc')).toHaveClass(SELECTED);
      await waitCollabSynced(page);
      await expect(editorContent(page)).toContainText('Project A content.', { timeout: 20_000 });
    } finally {
      await cleanupProject(page, projectB);
    }
  });

  // Distinct behaviour: the remembered selection is per-user. A second account signing in
  // on the same browser must NOT inherit the first user's selection.
  test('does not leak a selection to a different account on the same browser', async ({ page }) => {
    const viewer = await createViewerInProject(page, projectId);
    viewerEmail = viewer.email;
    const fileNodeId = await createTestFile(page, projectId, null, 'shared.adoc');
    await writeFileContent(page, projectId, fileNodeId, '= Shared\n\nOwner opened this file.\n');

    // The owner opens and selects the file.
    await openProject(page, projectId);
    await page.getByTestId('tree-node-shared.adoc').click();
    await expect(page.getByTestId('tree-node-shared.adoc')).toHaveClass(SELECTED);

    // Switch accounts in the same browser (localStorage persists across the sign-out/sign-in).
    await signOutViaUi(page, TEST_USER.displayName);
    await signIn(page, viewer.email, viewer.password);
    await openProject(page, projectId);

    // The viewer has no remembered selection → the default empty state, not the owner's file.
    await expect(page.getByText(/select a file from the tree/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('tree-node-shared.adoc')).not.toHaveClass(SELECTED);

    // Sign back in as the owner so afterEach cleanup runs with admin privileges.
    await signOutViaUi(page, 'Test Viewer');
    await signIn(page);
  });

  // Distinct behaviour: the cursor clamps to the last valid line when the document shrank below
  // the remembered line, with no error.
  test('clamps the cursor to the last line when the remembered line exceeds the document', async ({ page }) => {
    // Headroom for the collaborative Yjs re-sync after navigating back under heavy parallel load.
    test.setTimeout(75_000);
    // A 3-line document (seeded before the file is opened — no collaboration session yet).
    const fileNodeId = await createTestFile(page, projectId, null, 'log.adoc');
    await writeFileContent(page, projectId, fileNodeId, 'Row 1.\nRow 2.\nRow 3.');

    await openProject(page, projectId);
    await page.getByTestId('tree-node-log.adoc').click();
    await expect(editorContent(page)).toContainText('Row 1.', { timeout: 10_000 });
    await page.waitForTimeout(800); // let the initial cursor-line persistence flush

    // Leave the editor FIRST (which flushes log.adoc's live cursor line), then — while the editor is
    // unmounted so nothing overwrites it — seed a remembered line that now exceeds the document, the
    // state left behind when a collaborator deletes lines below the remembered position. The per-file
    // cursor map is the authority the restore reads first; the legacy entry covers old projects.
    await page.getByRole('link', { name: /back to projects/i }).click();
    await page.waitForURL(/\/dashboard$/);
    await page.evaluate((nodeId) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('asciidocollab:last-selection:')) {
          const entry = JSON.parse(localStorage.getItem(key) as string);
          entry.line = 10;
          localStorage.setItem(key, JSON.stringify(entry));
        }
        if (key.startsWith('asciidocollab:file-cursors:')) {
          const map = JSON.parse(localStorage.getItem(key) as string);
          map[nodeId] = { line: 10 };
          localStorage.setItem(key, JSON.stringify(map));
        }
      }
    }, fileNodeId);
    // Return to the editor; the restore reads the seeded line (10) and clamps it to the document.
    await page.getByRole('link', { name: projectName }).click();
    await page.waitForURL(/\/dashboard\/projects\/[^/]+$/);
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    // Wait for the post-navigation Yjs sync before asserting the restored (clamped) content.
    await waitCollabSynced(page);

    // The cursor lands on the last valid line (clamped to 3), no error, content still shown.
    await expect(editorContent(page)).toContainText('Row 3.', { timeout: 20_000 });
    await expect(page.locator('.asciidoc-editor').getByText(/^Ln 3, /)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.cm-editor .cm-activeLine')).toContainText('Row 3.');
    await expect(page.getByText(/select a file from the tree/i)).not.toBeVisible();
  });

  // Distinct behaviour: when the remembered file no longer exists, fall back to the empty state
  // (no error) and clear the stale memory so it is not retried.
  test('falls back to the empty state and forgets a deleted file', async ({ page }) => {
    const fileNodeId = await createTestFile(page, projectId, null, 'temp.adoc');

    await openProject(page, projectId);
    await page.getByTestId('tree-node-temp.adoc').click();
    await expect(editorContent(page)).toBeVisible({ timeout: 10_000 });

    // Leave the editor first: opening a file starts a collaboration session, and a file with an
    // active session cannot be deleted (018 guard). Navigating to the dashboard tears the room
    // down, after which the delete succeeds — retry until the session has closed.
    await page.getByRole('link', { name: /back to projects/i }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(async () => {
      const response = await page.request.delete(`${API_URL}/projects/${projectId}/files/${fileNodeId}`);
      expect(response.ok()).toBeTruthy();
    }).toPass({ timeout: 15_000 });

    // Returning must not error or hang — the remembered file is gone, so the view falls back to
    // "select a file" and the stale memory is cleared.
    await page.getByRole('link', { name: projectName }).click();
    await page.waitForURL(/\/dashboard\/projects\/[^/]+$/);
    await expect(page.getByText(/select a file from the tree/i)).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByText(/loading\.\.\./i)).not.toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/select a file from the tree/i)).toBeVisible({ timeout: 10_000 });
  });

  // Distinct behaviour: a project that was never visited forces no file open.
  test('opens no file in a project that was never visited', async ({ page }) => {
    await createTestFile(page, projectId, null, 'untouched.adoc');

    await openProject(page, projectId);
    await expect(page.getByText(/select a file from the tree/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('tree-node-untouched.adoc')).not.toHaveClass(SELECTED);
  });
});
