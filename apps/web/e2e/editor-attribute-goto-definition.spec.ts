import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile, editorContent, expectActiveFile, waitCollabSynced } from './helpers/editor';

// Ctrl+click on an attribute reference `{name}` jumps to where the attribute is DEFINED — in the
// current file or another file in the include tree. Mirrors the cross-file xref
// go-to-definition; the logic itself is exhaustively unit-tested in asciidoc-link-handler.test.ts.

test.describe('editor attribute go-to-definition (Ctrl+click)', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Attr GoTo ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('Ctrl+click on a reference defined in an INCLUDED file switches to that file', async ({ page }) => {
    // child.adoc defines :sharedAttr:; main includes it then references {sharedAttr}. Because the
    // definition lives in a descendant, the reference is NOT folded in main, so it is plain clickable
    // source text. Ctrl+clicking it must open child.adoc at the definition.
    await createAdocFile(page, projectId, 'child.adoc', ':sharedAttr: Acme\n');
    const mainId = await createAdocFile(page, projectId, 'main.adoc', 'include::child.adoc[]\nProvided by {sharedAttr}.\n');
    await setMainFile(page, projectId, mainId);

    await openProject(page, projectId);
    await openFile(page, 'main.adoc');
    await waitCollabSynced(page);
    // Let the cross-file symbol index build so the reference resolves.
    await expect(editorContent(page)).toContainText('sharedAttr', { timeout: 15_000 });
    await page.waitForTimeout(1500);

    await editorContent(page).getByText('sharedAttr', { exact: false }).first().click({ modifiers: ['Control'] });
    await expectActiveFile(page, 'child.adoc');
  });

  test('Ctrl+click on a same-file reference reveals its definition without leaving the file', async ({ page }) => {
    // A forward reference `{laterVar}` to a definition further down the SAME file is not folded, so it
    // is clickable. Ctrl+click resolves it in place (the file stays active) and reveals the definition.
    const mainId = await createAdocFile(
      page,
      projectId,
      'solo.adoc',
      'Refer to {laterVar} up top.\n\n:laterVar: defined-below\n',
    );
    await setMainFile(page, projectId, mainId);

    await openProject(page, projectId);
    await openFile(page, 'solo.adoc');
    await waitCollabSynced(page);
    await expect(editorContent(page)).toContainText('laterVar', { timeout: 15_000 });
    await page.waitForTimeout(1500);

    await editorContent(page).getByText('{laterVar}', { exact: false }).first().click({ modifiers: ['Control'] });
    // Same file stays active; the definition line (`:laterVar:`) is revealed/active.
    await expectActiveFile(page, 'solo.adoc');
    await expect(page.locator('.cm-editor .cm-activeLine')).toContainText(':laterVar: defined-below', { timeout: 10_000 });
  });
});
