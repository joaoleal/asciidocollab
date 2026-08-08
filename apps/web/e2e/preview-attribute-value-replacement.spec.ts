import { test, expect } from '@playwright/test';
import { ensureTestUser } from './helpers/test-user';
import { signIn, createProject, cleanupProject } from './helpers/test-project';
import { createAdocFile, setMainFile, openProject, openFile, expandPreview, editorContent, waitCollabSynced } from './helpers/editor';

// Consistency across the THREE attribute sources (current / parent-including / included child),
// proving an attribute's value is REPLACED (recognized AND shown) on both surfaces:
//  - a PARENT-defined attribute's value renders in a CHILD's preview AND folds in the child editor;
//  - a CHILD-included attribute is KNOWN in the PARENT editor and rendered in the parent's preview.
// Editor recognition is asserted via the collapse-to-value `.cm-ad-attr-value` widget and the
// known-cross-document `.cm-ad-attr-known` mark; preview replacement via the rendered output text.

const KNOWN = '.cm-ad-attr-known';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function fileId(page: import('@playwright/test').Page, projectId: string, name: string): Promise<string> {
  const tree = await page.request.get(`${API}/projects/${projectId}/files`).then((r) => r.json());
  const node = (tree.children as Array<{ id: string; name: string }>).find((c) => c.name === name);
  if (!node) throw new Error(`file ${name} not found`);
  return node.id;
}

test.describe('attribute value replacement across current/parent/included documents', () => {
  test.beforeAll(async () => {
    await ensureTestUser();
  });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    projectId = await createProject(page, `Attr Value Replacement ${Date.now()}`);
  });

  test.afterEach(async ({ page }) => {
    if (projectId) await cleanupProject(page, projectId);
  });

  test('a parent-defined attribute value renders in the child preview AND folds in the child editor', async ({ page }) => {
    await createAdocFile(
      page,
      projectId,
      'main.adoc',
      '= Book\n:productName: Acme\n\ninclude::child.adoc[]\n',
    );
    await createAdocFile(page, projectId, 'child.adoc', '= Child\n\nProduct is {productName}.\n');
    await setMainFile(page, projectId, await fileId(page, projectId, 'main.adoc'));
    await openProject(page, projectId);
    await openFile(page, 'child.adoc');
    await waitCollabSynced(page);
    await expandPreview(page);

    // PREVIEW: the child resolves the inherited parent value.
    const output = page.getByTestId('asciidoc-output');
    await expect(output).toContainText('Product is Acme.', { timeout: 15_000 });
    await expect(output).not.toContainText('{productName}');

    // EDITOR: the inherited reference folds to its value; clicking reveals the raw known reference.
    const valueWidget = page.locator('.cm-ad-attr-value', { hasText: 'Acme' });
    await expect(valueWidget).toBeVisible({ timeout: 10_000 });
    await valueWidget.click();
    await expect(editorContent(page)).toContainText('{productName}');
    await expect(page.locator(KNOWN).first()).toBeVisible({ timeout: 10_000 });
  });

  test('a child-included attribute is known in the parent editor and rendered in the parent preview', async ({ page }) => {
    // child.adoc defines :edition:; main.adoc includes it then references {edition}. The definition
    // lives in a DESCENDANT, so for the root the reference is known-anywhere but its
    // position-aware fold does NOT collapse it — the raw `{edition}` stays and carries the known mark.
    await createAdocFile(page, projectId, 'child.adoc', ':edition: Pro\n');
    await createAdocFile(
      page,
      projectId,
      'main.adoc',
      '= Book\n\ninclude::child.adoc[]\n\nRunning {edition} edition.\n',
    );
    await setMainFile(page, projectId, await fileId(page, projectId, 'main.adoc'));
    await openProject(page, projectId);
    await openFile(page, 'main.adoc');
    await waitCollabSynced(page);
    await expandPreview(page);

    // EDITOR: {edition} is known anywhere in the tree → carries the known cross-document mark.
    await expect(page.locator(KNOWN).first()).toBeVisible({ timeout: 10_000 });

    // PREVIEW: the assembled tree puts the child's :edition: in scope before the reference, so the
    // parent's preview renders the value (not the literal token).
    const output = page.getByTestId('asciidoc-output');
    await expect(output).toContainText('Running Pro edition.', { timeout: 15_000 });
    await expect(output).not.toContainText('{edition}');
  });
});
