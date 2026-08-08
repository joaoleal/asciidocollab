import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createTestFile } from './helpers/test-project';
import { openProject, openFile, editorContent, waitCollabSynced } from './helpers/editor';

// LIVE attribute collapse-to-value, reproducing the user's exact manual flow:
// an EMPTY file, NO main file configured, with the document TYPED live (not seeded via the REST
// content API). Both definition forms must fold the later `{name}` reference to a `.cm-ad-attr-value`
// widget showing the resolved value:
//   - a header-style `:myvar: hello` entry  → `{myvar}` folds to "hello"
//   - an inline `{set:basedir:src/main}`    → `{basedir}` folds to "src/main"
// The literal `{myvar}` / `{basedir}` must NOT be shown until the line is clicked (click-to-reveal).
//
// The fold is driven by the local CodeMirror plugin (computeAttributeReplacements over the document
// text), so it does NOT depend on the project symbol index or a main file — it must work for a brand
// new, never-saved, live-typed document. The recompute runs as content settles, so we allow generous
// time for the widgets to appear.

test.describe('live {attr} collapse-to-value (no main file, typed live)', () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Live Fold ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('folds a typed `:myvar:` AND a typed `{set:}` reference, with click-to-reveal', async ({ page }) => {
    // Create an EMPTY file and do NOT set a main file — exactly the user's flow.
    await createTestFile(page, projectId, null, 'live.adoc');

    await openProject(page, projectId);
    await openFile(page, 'live.adoc');
    // Wait for collaborative sync before typing so the keystrokes land in the synced document.
    await waitCollabSynced(page);

    const content = editorContent(page);
    await content.click();

    // TYPE the document live, key by key (the user's flow — not the REST content API). Each line is
    // terminated with Enter. CodeMirror may auto-continue list/attribute context, but plain text and
    // attribute-entry lines type verbatim here.
    await page.keyboard.type(':myvar: hello\n');
    await page.keyboard.type('Greeting: {myvar} world.\n');
    await page.keyboard.type('{set:basedir:src/main}\n');
    await page.keyboard.type('Built in {basedir} today.\n');

    // Move the cursor away from the reference lines so the widgets are not "revealed" (an overlapping
    // selection reveals the raw reference for editing). Put the caret on the first line.
    await page.keyboard.press('Control+Home');

    // The fold recompute runs ~250ms after content settles; allow generous time for both widgets.
    const helloWidget = page.locator('.cm-ad-attr-value', { hasText: 'hello' });
    const basedirWidget = page.locator('.cm-ad-attr-value', { hasText: 'src/main' });
    await expect(helloWidget).toBeVisible({ timeout: 15_000 });
    await expect(basedirWidget).toBeVisible({ timeout: 15_000 });

    // The literal references are collapsed away (replaced by the value widgets), not shown as text.
    await expect(content).not.toContainText('{myvar}');
    await expect(content).not.toContainText('{basedir}');

    // Click-to-reveal still works: clicking the value places the cursor on the reference, revealing
    // the raw `{myvar}` source so it can be edited.
    await helloWidget.click();
    await expect(content).toContainText('{myvar}');
  });
});
